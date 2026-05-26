# LiveKit Transcription Fallback Handoff

## Current State

This repo implements a SAM-based voice memo upload service for Apple Shortcuts.

Current upload flow:

1. Apple Shortcuts calls `/upload-url` with `x-api-key` and JSON `fileName`.
2. Lambda returns a presigned S3 PUT URL.
3. Shortcut uploads audio to `s3://aws-voice-memo/unprocessed/<file>.m4a`.

Recent implementation details:

- Upload handler now appends `.m4a` when `fileName` has no extension.
- Response includes final `fileName`, `key`, and `uploadUrl`.
- AWS Transcribe path was implemented with S3 ObjectCreated trigger, diarization, explicit `LanguageCode`, dedicated Transcribe data access role, and output under `processed/`.

## Blocker

AWS Transcribe is blocked at the account/service level. Both CLI and AWS Console return:

```text
The AWS Access Key Id needs a subscription for the service
```

This happens in `ap-southeast-2` when calling:

```bash
aws transcribe list-transcription-jobs --region ap-southeast-2 --max-results 5
```

The AWS console also displays the same error on the Amazon Transcribe page. This confirms it is not caused by Lambda code or IAM in the SAM stack. Until AWS enables Transcribe for account `993099901409`, the AWS Transcribe backend cannot run.

## Proposed Fallback: LiveKit

Use LiveKit as a transcription backend while keeping the existing Apple Shortcuts + S3 upload flow.

Recommended architecture:

1. Shortcut uploads `.m4a` to `s3://aws-voice-memo/unprocessed/<file>.m4a`.
2. S3 ObjectCreated triggers Lambda.
3. Lambda creates a short-lived presigned S3 GET URL for the uploaded audio.
4. Lambda creates a LiveKit room.
5. Lambda starts a LiveKit Ingress with `URL_INPUT` pointed at the presigned audio URL.
6. A LiveKit STT-only Agent joins/listens to the room.
7. Agent uses LiveKit STT, likely Deepgram via LiveKit model/plugin.
8. Agent writes transcript output back to the same bucket:

```text
s3://aws-voice-memo/processed/<recording>/transcript.json
```

## Suggested Implementation Approach

Do this as a parallel backend, not a replacement yet:

```text
TRANSCRIPTION_BACKEND=aws-transcribe | livekit
```

Keep AWS Transcribe code until the blocker is resolved or LiveKit is proven.

Likely new configuration:

```text
LIVEKIT_URL
LIVEKIT_API_KEY
LIVEKIT_API_SECRET
LIVEKIT_STT_MODEL=deepgram/nova-3-general
```

Likely new component:

```text
LiveKit Transcriber Worker
```

Python is probably the best first worker runtime because LiveKit agent/transcriber examples are Python-first.

## Verification Request for Claude

Please verify whether this LiveKit fallback architecture is technically sound. Focus on:

- Whether LiveKit Ingress `URL_INPUT` can ingest an S3 presigned `.m4a` file.
- Whether a LiveKit STT-only agent can transcribe that room without interactive users.
- Whether diarization/speaker labels are available through LiveKit STT provider choices.
- Whether Lambda should start LiveKit Ingress directly or enqueue work for a separate worker.
- Security concerns around presigned GET URL lifetime and LiveKit credentials.
- Operational concerns: job completion detection, writing transcript to S3, retries/idempotency, and cost.
- Recommended minimal first implementation for this repo.

Expected output: findings first, then recommended architecture and next implementation steps.
