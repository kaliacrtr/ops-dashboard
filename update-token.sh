#!/bin/bash
# Update Meta API token only — run this every 60 days

echo ""
echo "  Bodycon — Update Meta Token"
echo "  ----------------------------"
echo ""
echo "  Paste your new 60-day Meta access token and press Enter."
echo "  (Nothing will be visible as you type.)"
echo ""
printf "  Token: "
read -rs TOKEN
echo ""

if [ -z "$TOKEN" ]; then
  echo "  ERROR: Token cannot be empty."
  exit 1
fi

ENV_FILE="$(dirname "$0")/.env"

if grep -q '^META_ACCESS_TOKEN=' "$ENV_FILE" 2>/dev/null; then
  sed -i '' "s|^META_ACCESS_TOKEN=.*|META_ACCESS_TOKEN=$TOKEN|" "$ENV_FILE"
else
  echo "META_ACCESS_TOKEN=$TOKEN" >> "$ENV_FILE"
fi

# Save expiry date (60 days from today)
EXPIRY=$(date -v+60d '+%Y-%m-%d' 2>/dev/null || date -d '+60 days' '+%Y-%m-%d')
if grep -q '^META_TOKEN_EXPIRY=' "$ENV_FILE" 2>/dev/null; then
  sed -i '' "s|^META_TOKEN_EXPIRY=.*|META_TOKEN_EXPIRY=$EXPIRY|" "$ENV_FILE"
else
  echo "META_TOKEN_EXPIRY=$EXPIRY" >> "$ENV_FILE"
fi

echo ""
echo "  ✓ Token saved. Expires around $EXPIRY."
echo ""
echo "  Restart the server: node server.js"
echo ""
