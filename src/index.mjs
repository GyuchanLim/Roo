import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  ConflictException,
  StartTranscriptionJobCommand,
  TranscribeClient
} from "@aws-sdk/client-transcribe";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto from "node:crypto";
import path from "node:path";

const API_KEY = process.env.API_KEY;
const BUCKET_NAME = process.env.BUCKET_NAME;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const OUTPUT_PREFIX = process.env.OUTPUT_PREFIX || "processed";
const TRANSCRIPTION_BACKEND = process.env.TRANSCRIPTION_BACKEND || "aws-transcribe";
const TRANSCRIBE_DATA_ACCESS_ROLE_ARN = process.env.TRANSCRIBE_DATA_ACCESS_ROLE_ARN;
const TRANSCRIBE_LANGUAGE_CODE = process.env.TRANSCRIBE_LANGUAGE_CODE || "en-US";
const MAX_SPEAKER_LABELS = Number(process.env.MAX_SPEAKER_LABELS || 4);

// AWS_REGION is set automatically by the Lambda runtime.
const s3 = new S3Client({});
const transcribe = new TranscribeClient({});

export const handler = async (event) => {
  const providedKey = event.headers?.["x-api-key"];

  if (providedKey !== API_KEY) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: "Unauthorized" })
    };
  }

  const body = JSON.parse(event.body || "{}");
  const fileName = normalizeAudioFileName(body.fileName);

  if (!fileName) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "fileName is required" })
    };
  }

  const key = `unprocessed/${fileName}`;

  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    ContentType: "audio/m4a"
  });

  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uploadUrl, key, fileName })
  };
};

export const startTranscriptionHandler = async (event) => {
  validateTranscriptionBackend();

  const results = [];

  for (const record of event.Records || []) {
    const bucket = record.s3?.bucket?.name;
    const key = decodeS3Key(record.s3?.object?.key || "");

    if (!bucket || !key.startsWith("unprocessed/")) {
      continue;
    }

    const baseName = safeBaseName(key);
    const objectIdentity = makeObjectIdentity(bucket, key, record.s3?.object);
    const transcriptionJobName = makeTranscriptionJobName(baseName, objectIdentity);
    const outputKey = `${OUTPUT_PREFIX}/${baseName}/${objectIdentity}/transcript.json`;

    if (TRANSCRIPTION_BACKEND === "deepgram") {
      await transcribeWithDeepgram({ bucket, key, outputKey });
      results.push({
        key,
        outputKey,
        status: "completed",
        transcriptionBackend: TRANSCRIPTION_BACKEND
      });
      continue;
    }

    const command = new StartTranscriptionJobCommand({
      TranscriptionJobName: transcriptionJobName,
      LanguageCode: TRANSCRIBE_LANGUAGE_CODE,
      Media: {
        MediaFileUri: `s3://${bucket}/${key}`
      },
      OutputBucketName: bucket,
      OutputKey: outputKey,
      Settings: {
        ShowSpeakerLabels: true,
        MaxSpeakerLabels: MAX_SPEAKER_LABELS
      },
      JobExecutionSettings: {
        AllowDeferredExecution: true,
        DataAccessRoleArn: TRANSCRIBE_DATA_ACCESS_ROLE_ARN
      }
    });

    try {
      await transcribe.send(command);
      results.push({ key, transcriptionJobName, outputKey, status: "started" });
    } catch (error) {
      if (error instanceof ConflictException || error.name === "ConflictException") {
        results.push({ key, transcriptionJobName, outputKey, status: "already_exists" });
        continue;
      }

      throw error;
    }
  }

  return { results };
};

const validateTranscriptionBackend = () => {
  if (!["aws-transcribe", "deepgram"].includes(TRANSCRIPTION_BACKEND)) {
    throw new Error(`Unsupported TRANSCRIPTION_BACKEND: ${TRANSCRIPTION_BACKEND}`);
  }

  if (TRANSCRIPTION_BACKEND === "deepgram" && !DEEPGRAM_API_KEY) {
    throw new Error("DEEPGRAM_API_KEY is required when TRANSCRIPTION_BACKEND=deepgram");
  }
};

const transcribeWithDeepgram = async ({ bucket, key, outputKey }) => {
  const audioUrl = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: bucket,
      Key: key
    }),
    { expiresIn: 3600 }
  );

  const response = await fetch(deepgramListenUrl(), {
    method: "POST",
    headers: {
      Authorization: `Token ${DEEPGRAM_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ url: audioUrl })
  });
  const responseBody = await response.text();

  if (!response.ok) {
    throw new Error(`Deepgram transcription failed (${response.status}): ${responseBody.slice(0, 500)}`);
  }

  const transcript = JSON.parse(responseBody);

  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: outputKey,
    ContentType: "application/json",
    Body: JSON.stringify(transcript, null, 2)
  }));
};

const deepgramListenUrl = () => {
  const url = new URL("https://api.deepgram.com/v1/listen");
  url.searchParams.set("model", "nova-3");
  url.searchParams.set("smart_format", "true");
  url.searchParams.set("diarize", "true");
  url.searchParams.set("utterances", "true");

  return url;
};

const decodeS3Key = (key) => decodeURIComponent(key.replace(/\+/g, " "));

const normalizeAudioFileName = (fileName) => {
  if (typeof fileName !== "string") {
    return "";
  }

  const normalized = fileName.trim().replace(/^\/+/, "");

  if (!normalized) {
    return "";
  }

  return path.extname(normalized) ? normalized : `${normalized}.m4a`;
};

const safeBaseName = (key) => {
  const parsed = path.parse(key.replace(/^unprocessed\//, ""));
  const baseName = parsed.name || "voice-memo";

  return baseName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "voice-memo";
};

const makeObjectIdentity = (bucket, key, object = {}) => {
  const stableToken = object.eTag || object.versionId || object.sequencer;

  if (stableToken) {
    return stableToken.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 64);
  }

  return crypto
    .createHash("sha256")
    .update(`${bucket}/${key}`)
    .digest("hex")
    .slice(0, 32);
};

const makeTranscriptionJobName = (baseName, objectIdentity) => {
  const prefix = `voice-memo-${baseName}`.slice(0, 130);

  return `${prefix}-${objectIdentity}`.slice(0, 200);
};
