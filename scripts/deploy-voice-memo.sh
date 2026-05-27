#!/usr/bin/env bash
set -euo pipefail

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

STACK_NAME="${STACK_NAME:-voice-memo}"
REGION="${AWS_REGION:-ap-southeast-2}"
BUCKET_NAME="${BUCKET_NAME:-aws-voice-memo}"
TRANSCRIBE_LANGUAGE_CODE="${TRANSCRIBE_LANGUAGE_CODE:-en-US}"
MAX_SPEAKER_LABELS="${MAX_SPEAKER_LABELS:-4}"
ANTHROPIC_MODEL="${ANTHROPIC_MODEL:-claude-sonnet-4-20250514}"

if [[ -z "${API_KEY:-}" ]]; then
  read -rsp "Upload API key: " API_KEY
  printf '\n'
fi

if [[ -z "${DEEPGRAM_API_KEY:-}" ]]; then
  read -rsp "Deepgram API key: " DEEPGRAM_API_KEY
  printf '\n'
fi

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  read -rsp "Anthropic API key: " ANTHROPIC_API_KEY
  printf '\n'
fi

if [[ -z "${DISCORD_WEBHOOK_URL:-}" ]]; then
  read -rsp "Discord webhook URL: " DISCORD_WEBHOOK_URL
  printf '\n'
fi

if aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" >/dev/null 2>&1; then
  STACK_EXISTS=true
else
  STACK_EXISTS=false
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
    DeepgramApiKey="$DEEPGRAM_API_KEY" \
    AnthropicApiKey="$ANTHROPIC_API_KEY" \
    AnthropicModel="$ANTHROPIC_MODEL" \
    DiscordWebhookUrl="$DISCORD_WEBHOOK_URL"

if [[ "$STACK_EXISTS" == "true" ]]; then
  WAITER=stack-update-complete
else
  WAITER=stack-create-complete
fi

aws cloudformation wait "$WAITER" \
  --stack-name "$STACK_NAME" \
  --region "$REGION" || {
    status="$(aws cloudformation describe-stacks \
      --stack-name "$STACK_NAME" \
      --region "$REGION" \
      --query 'Stacks[0].StackStatus' \
      --output text)"

    if [[ "$status" != "UPDATE_COMPLETE" && "$status" != "CREATE_COMPLETE" ]]; then
      printf 'Stack did not reach a complete state. Current status: %s\n' "$status" >&2
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
printf '\nThen confirm the Discord notifier logs with:\n'
printf 'sam logs --stack-name %s --name NotifyDiscordFunction --region %s --tail\n' "$STACK_NAME" "$REGION"
