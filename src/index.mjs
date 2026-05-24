import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const API_KEY = process.env.API_KEY;
const BUCKET_NAME = process.env.BUCKET_NAME;

// AWS_REGION is set automatically by the Lambda runtime.
const s3 = new S3Client({});

export const handler = async (event) => {
  const providedKey = event.headers?.["x-api-key"];

  if (providedKey !== API_KEY) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: "Unauthorized" })
    };
  }

  const body = JSON.parse(event.body || "{}");
  const fileName = body.fileName;

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
    body: JSON.stringify({ uploadUrl, key })
  };
};
