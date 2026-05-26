# Voice Memo Upload Service

AWS SAM stack that issues short-lived presigned S3 PUT URLs for uploading voice
memos. Requests are authenticated with a shared `x-api-key` header.

## Architecture

Current working path uses Deepgram for prerecorded transcription and speaker
diarization while keeping audio storage and outputs in S3.

1. **Apple Shortcuts** records a voice memo and calls `POST /upload-url` with an
   `x-api-key` header and JSON `fileName`.
2. **UploadUrl Lambda** authenticates the shared key, appends `.m4a` when the
   filename has no extension, and returns a short-lived presigned S3 PUT URL for
   `unprocessed/<file>.m4a`.
3. **Apple Shortcuts** uploads the audio bytes directly to S3 using that
   presigned URL.
4. **S3 ObjectCreated** on `unprocessed/` invokes `StartTranscriptionFunction`.
5. With `TranscriptionBackend=deepgram`, the transcription Lambda signs a
   temporary S3 GET URL for the audio, posts that URL to Deepgram prerecorded
   transcription with `model=nova-3`, `diarize=true`, and `utterances=true`, then
   writes Deepgram's JSON response to `processed/`.
6. The final transcript is stored at:

```text
s3://<bucket>/processed/<recording-name>/<object-identity>/transcript.json
```

Security boundaries:

- The upload Lambda can only `s3:PutObject` under `unprocessed/*`.
- The transcription Lambda has conditional S3 read/write permissions only when
  the Deepgram backend is selected.
- The S3 bucket is encrypted and blocks public access. Deepgram only receives a
  temporary presigned GET URL for a specific uploaded object.
- The public HTTP endpoints are guarded by the shared `x-api-key`; do not commit
  the real key.

AWS Transcribe support remains in the code as an alternate backend, but it is not
the current working deployment because this AWS account returns
`SubscriptionRequiredException` for Amazon Transcribe.

## Deploy

Prerequisites: [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)
and configured AWS credentials.

```bash
sam build
sam deploy --guided   # first time; prompts for the ApiKey parameter
```

On later deploys just run `sam deploy`. The API endpoint is printed as a stack
output (`ApiEndpoint`).

The working deployment uses Deepgram. Run the helper script to deploy or update
that backend. It prompts for secrets without echoing them, builds the app, deploys
with `TranscriptionBackend=deepgram`, waits for the stack update, and prints the
stack outputs:

```bash
scripts/deploy-deepgram.sh
```

You can also provide non-secret overrides through environment variables, for
example `BUCKET_NAME`, `AWS_REGION`, `TRANSCRIBE_LANGUAGE_CODE`, and
`MAX_SPEAKER_LABELS`.

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

- `BucketName`, `ApiKey`, `TranscribeLanguageCode`, `MaxSpeakerLabels`,
  `TranscriptionBackend`, and `DeepgramApiKey` are template parameters; override
  with `--parameter-overrides` if needed.
- `TranscriptionBackend` defaults to `aws-transcribe` in the template for
  backwards compatibility, but the verified working deployment uses `deepgram`.
- The bucket is created and managed by this stack. If `aws-voice-memo` already
  exists in your account, either import it or pass a different `BucketName`.
