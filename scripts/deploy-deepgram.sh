#!/usr/bin/env bash
set -euo pipefail

STACK_NAME="${STACK_NAME:-voice-memo}"
REGION="${AWS_REGION:-ap-southeast-2}"
BUCKET_NAME="${BUCKET_NAME:-aws-voice-memo}"
TRANSCRIBE_LANGUAGE_CODE="${TRANSCRIBE_LANGUAGE_CODE:-en-US}"
MAX_SPEAKER_LABELS="${MAX_SPEAKER_LABELS:-4}"

if [[ -z "${API_KEY:-}" ]]; then
  read -rsp "Upload API key: " API_KEY
  printf '\n'
fi

if [[ -z "${DEEPGRAM_API_KEY:-}" ]]; then
  read -rsp "Deepgram API key: " DEEPGRAM_API_KEY
  printf '\n'
fi

sam build

sam deploy \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --parameter-overrides \
    ApiKey="$API_KEY" \
    BucketName="$BUCKET_NAME" \
    TranscribeLanguageCode="$TRANSCRIBE_LANGUAGE_CODE" \
    MaxSpeakerLabels="$MAX_SPEAKER_LABELS" \
    TranscriptionBackend=deepgram \
    DeepgramApiKey="$DEEPGRAM_API_KEY"

aws cloudformation wait stack-update-complete \
  --stack-name "$STACK_NAME" \
  --region "$REGION" || {
    status="$(aws cloudformation describe-stacks \
      --stack-name "$STACK_NAME" \
      --region "$REGION" \
      --query 'Stacks[0].StackStatus' \
      --output text)"

    if [[ "$status" != "UPDATE_COMPLETE" ]]; then
      printf 'Stack did not reach UPDATE_COMPLETE. Current status: %s\n' "$status" >&2
      exit 1
    fi
  }

aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query "Stacks[0].Outputs" \
  --output table

printf '\nAfter uploading a fresh memo, verify transcript output with:\n'
printf 'aws s3 ls s3://%s/processed/ --recursive --region %s\n' "$BUCKET_NAME" "$REGION"
