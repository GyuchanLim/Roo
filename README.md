# Voice Memo Upload Service

AWS SAM stack that issues short-lived presigned S3 PUT URLs for uploading voice
memos. Requests are authenticated with a shared `x-api-key` header.

## Architecture

- **HTTP API** (`/upload-url`, POST) → **Lambda** → returns a presigned URL.
- The upload Lambda can only `PutObject` under `unprocessed/` in the bucket.
- **S3 bucket** (`aws-voice-memo`) — encrypted, all public access blocked, CORS
  allows browser PUT uploads.
- **S3 ObjectCreated event** for `unprocessed/` → **Lambda** → starts an AWS
  Transcribe job with speaker diarization.
- **AWS Transcribe** assumes a dedicated data access role to read
  `unprocessed/*` and write results under `processed/*`.

## Deploy

Prerequisites: [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)
and configured AWS credentials.

```bash
sam build
sam deploy --guided   # first time; prompts for the ApiKey parameter
```

On later deploys just run `sam deploy`. The API endpoint is printed as a stack
output (`ApiEndpoint`).

## Usage

```bash
# 1. Get a presigned URL
curl -X POST "$API_ENDPOINT" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"fileName": "memo-2026-05-25.m4a"}'

# 2. Upload the file to the returned uploadUrl
curl -X PUT "$UPLOAD_URL" \
  -H "Content-Type: audio/m4a" \
  --data-binary @memo.m4a
```

If `fileName` has no extension, the service appends `.m4a` before creating the
S3 key. The response includes the final `fileName` and `key`.

The presigned URL expires after 300 seconds. When the upload completes, the S3
event starts transcription automatically. Diarized JSON output is written to:

```text
s3://<bucket>/processed/<recording-name>/<object-identity>/transcript.json
```

## Notes

- `BucketName`, `ApiKey`, `TranscribeLanguageCode`, and `MaxSpeakerLabels` are
  template parameters; override with `--parameter-overrides` if needed.
- The bucket is created and managed by this stack. If `aws-voice-memo` already
  exists in your account, either import it or pass a different `BucketName`.
