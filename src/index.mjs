import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  DynamoDBClient,
  PutItemCommand,
  UpdateItemCommand
} from "@aws-sdk/client-dynamodb";
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
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const DISCORD_NOTIFICATION_TABLE = process.env.DISCORD_NOTIFICATION_TABLE;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const OUTPUT_PREFIX = process.env.OUTPUT_PREFIX || "processed";
const TRANSCRIPTION_BACKEND = process.env.TRANSCRIPTION_BACKEND || "aws-transcribe";
const TRANSCRIBE_DATA_ACCESS_ROLE_ARN = process.env.TRANSCRIBE_DATA_ACCESS_ROLE_ARN;
const TRANSCRIBE_LANGUAGE_CODE = process.env.TRANSCRIBE_LANGUAGE_CODE || "en-US";
const MAX_SPEAKER_LABELS = Number(process.env.MAX_SPEAKER_LABELS || 4);
const DISCORD_CLAIM_LEASE_SECONDS = 15 * 60;
const DISCORD_NOTIFICATION_TTL_SECONDS = 90 * 24 * 60 * 60;

// AWS_REGION is set automatically by the Lambda runtime.
const ddb = new DynamoDBClient({});
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


export const notifyDiscordHandler = async (event) => {
  validateDiscordNotifierConfig();

  const results = [];

  for (const record of event.Records || []) {
    const bucket = record.s3?.bucket?.name;
    const key = decodeS3Key(record.s3?.object?.key || "");

    if (!bucket || !isTranscriptKey(key)) {
      continue;
    }

    const transcriptIdentity = `${bucket}/${key}`;
    const claimed = await claimDiscordNotification(transcriptIdentity);

    if (!claimed) {
      results.push({ key, status: "already_notified" });
      continue;
    }

    let releaseClaimOnError = true;

    try {
      const transcript = await readJsonFromS3(bucket, key);
      const transcriptText = extractTranscriptText(transcript);
      const summary = await summarizeTranscript(transcriptText);
      await markDiscordNotificationPosting(transcriptIdentity);
      releaseClaimOnError = false;
      await postDiscordMessage({ key, summary, transcript });
      await markDiscordNotificationSent(transcriptIdentity);
      results.push({ key, status: "sent" });
    } catch (error) {
      if (releaseClaimOnError) {
        await releaseDiscordNotificationClaim(transcriptIdentity);
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


const validateDiscordNotifierConfig = () => {
  if (!ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is required for Discord transcript notifications");
  }

  if (!DISCORD_NOTIFICATION_TABLE) {
    throw new Error("DISCORD_NOTIFICATION_TABLE is required for Discord transcript notifications");
  }

  if (!DISCORD_WEBHOOK_URL) {
    throw new Error("DISCORD_WEBHOOK_URL is required for Discord transcript notifications");
  }
};

const isTranscriptKey = (key) => key.startsWith(`${OUTPUT_PREFIX}/`) && key.endsWith("/transcript.json");

const claimDiscordNotification = async (transcriptIdentity) => {
  const now = nowEpochSeconds();

  try {
    await ddb.send(new PutItemCommand({
      TableName: DISCORD_NOTIFICATION_TABLE,
      Item: {
        transcriptKey: { S: transcriptIdentity },
        status: { S: "IN_PROGRESS" },
        createdAt: { S: new Date().toISOString() },
        claimExpiresAt: { N: String(now + DISCORD_CLAIM_LEASE_SECONDS) },
        expiresAt: { N: String(now + DISCORD_NOTIFICATION_TTL_SECONDS) }
      },
      ConditionExpression: "attribute_not_exists(transcriptKey) OR (#status <> :sent AND claimExpiresAt < :now)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":sent": { S: "SENT" },
        ":now": { N: String(now) }
      }
    }));
    return true;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException || error.name === "ConditionalCheckFailedException") {
      return false;
    }

    throw error;
  }
};

const markDiscordNotificationPosting = async (transcriptIdentity) => {
  await ddb.send(new UpdateItemCommand({
    TableName: DISCORD_NOTIFICATION_TABLE,
    Key: { transcriptKey: { S: transcriptIdentity } },
    UpdateExpression: "SET #status = :status, postingAt = :postingAt REMOVE claimExpiresAt",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: {
      ":status": { S: "DISCORD_POSTING" },
      ":postingAt": { S: new Date().toISOString() }
    }
  }));
};

const markDiscordNotificationSent = async (transcriptIdentity) => {
  await ddb.send(new UpdateItemCommand({
    TableName: DISCORD_NOTIFICATION_TABLE,
    Key: { transcriptKey: { S: transcriptIdentity } },
    UpdateExpression: "SET #status = :status, sentAt = :sentAt, expiresAt = :expiresAt REMOVE claimExpiresAt",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: {
      ":status": { S: "SENT" },
      ":sentAt": { S: new Date().toISOString() },
      ":expiresAt": { N: String(nowEpochSeconds() + DISCORD_NOTIFICATION_TTL_SECONDS) }
    }
  }));
};

const releaseDiscordNotificationClaim = async (transcriptIdentity) => {
  await ddb.send(new DeleteItemCommand({
    TableName: DISCORD_NOTIFICATION_TABLE,
    Key: { transcriptKey: { S: transcriptIdentity } }
  }));
};

const nowEpochSeconds = () => Math.floor(Date.now() / 1000);

const readJsonFromS3 = async (bucket, key) => {
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = await response.Body.transformToString();

  return JSON.parse(body);
};

const extractTranscriptText = (transcript) => {
  const alternative = transcript?.results?.channels?.[0]?.alternatives?.[0];

  if (Array.isArray(transcript?.results?.utterances) && transcript.results.utterances.length > 0) {
    return transcript.results.utterances
      .map((utterance) => `Speaker ${utterance.speaker ?? "unknown"}: ${utterance.transcript}`)
      .join("\n")
      .trim();
  }

  if (alternative?.paragraphs?.transcript) {
    return alternative.paragraphs.transcript.trim();
  }

  if (alternative?.transcript) {
    return alternative.transcript.trim();
  }

  return "No transcript text was found in the processed transcript JSON.";
};

const summarizeTranscript = async (transcriptText) => {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 500,
      temperature: 0.2,
      system: "You summarize voice memo transcripts for Discord. Be concise, concrete, and preserve action items.",
      messages: [
        {
          role: "user",
          content: `Summarize this diarized voice memo transcript. Return:\n- a 1-2 sentence summary\n- bullet key points\n- action items if any\n\nTranscript:\n${truncateForSummary(transcriptText)}`
        }
      ]
    })
  });
  const body = await response.text();

  if (!response.ok) {
    throw new Error(`Anthropic summary failed (${response.status}): ${body.slice(0, 500)}`);
  }

  const message = JSON.parse(body);
  const textBlocks = (message.content || [])
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text.trim());

  return textBlocks.join("\n\n").trim() || "Summary unavailable.";
};

const truncateForSummary = (text) => {
  const maxChars = 45000;

  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}\n\n[Transcript truncated for summarization]`;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const postDiscordMessage = async ({ key, summary, transcript }) => {
  const recordingName = key.split("/").at(-3) || "voice memo";
  const duration = transcript?.metadata?.duration;
  const durationText = typeof duration === "number" ? `${Math.round(duration)}s` : "unknown";
  const trimmedSummary = truncateDiscordText(summary, 3500);
  const content = `New voice memo transcript: ${recordingName}`;

  await sendDiscordWebhook({
    content,
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: "Voice memo summary",
        description: trimmedSummary,
        color: 3447003,
        fields: [
          { name: "Recording", value: truncateDiscordText(recordingName, 1024), inline: true },
          { name: "Duration", value: durationText, inline: true }
        ],
        timestamp: new Date().toISOString()
      }
    ]
  });
};

const sendDiscordWebhook = async (payload) => {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetch(discordWebhookUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const body = await response.text();

    if (response.ok) {
      return;
    }

    if (attempt < maxAttempts && response.status === 429) {
      await sleep(discordRetryDelay(response, body));
      continue;
    }

    if (attempt < maxAttempts && response.status >= 500) {
      await sleep(500 * attempt);
      continue;
    }

    throw new Error(`Discord webhook failed (${response.status}): ${body.slice(0, 500)}`);
  }
};

const discordWebhookUrl = () => {
  const url = new URL(DISCORD_WEBHOOK_URL);
  url.searchParams.set("wait", "true");

  return url;
};

const discordRetryDelay = (response, body) => {
  try {
    const parsed = JSON.parse(body);

    if (typeof parsed.retry_after === "number") {
      return Math.ceil(parsed.retry_after * 1000);
    }
  } catch {
    // Fall back to the Retry-After header below.
  }

  const retryAfter = Number(response.headers.get("retry-after"));

  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.ceil(retryAfter * 1000);
  }

  return 1000;
};

const truncateDiscordText = (text, maxLength) => {
  if (!text || text.length <= maxLength) {
    return text || "n/a";
  }

  return `${text.slice(0, maxLength - 3)}...`;
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
