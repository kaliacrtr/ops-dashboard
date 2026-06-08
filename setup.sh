#!/bin/bash
# Ops Dashboard — Setup

echo ""
echo "  Ops Dashboard — Setup"
echo "  ----------------------------------------"
echo ""

if ! command -v node &> /dev/null; then
  echo "  ERROR: Node.js is not installed. Download it at https://nodejs.org"
  exit 1
fi

# ── Load existing .env values ─────────────────────────────────────────────────
if [ -f .env ]; then
  META_ACCESS_TOKEN=$(grep '^META_ACCESS_TOKEN=' .env | cut -d'=' -f2-)
  AD_ACCOUNT_ID=$(grep '^AD_ACCOUNT_ID=' .env | cut -d'=' -f2-)
  SHOPIFY_STORE_DOMAIN=$(grep '^SHOPIFY_STORE_DOMAIN=' .env | cut -d'=' -f2-)
  SHOPIFY_CLIENT_ID=$(grep '^SHOPIFY_CLIENT_ID=' .env | cut -d'=' -f2-)
  SHOPIFY_CLIENT_SECRET=$(grep '^SHOPIFY_CLIENT_SECRET=' .env | cut -d'=' -f2-)
  SHOPIFY_ACCESS_TOKEN=$(grep '^SHOPIFY_ACCESS_TOKEN=' .env | cut -d'=' -f2-)
  KLAVIYO_PRIVATE_KEY=$(grep '^KLAVIYO_PRIVATE_KEY=' .env | cut -d'=' -f2-)
  ANTHROPIC_API_KEY=$(grep '^ANTHROPIC_API_KEY=' .env | cut -d'=' -f2-)
fi

# ── Meta token ────────────────────────────────────────────────────────────────
if [ -n "$META_ACCESS_TOKEN" ]; then
  echo "  ✓ Meta token already set — skipping."
else
  echo "  [Meta] Paste your Meta API access token and press Enter."
  echo "  (Nothing will be visible as you type.)"
  echo ""
  printf "  Token: "
  read -rs META_ACCESS_TOKEN
  echo ""
  if [ -z "$META_ACCESS_TOKEN" ]; then
    echo "  ERROR: Meta token cannot be empty."
    exit 1
  fi
fi

# ── Meta Ad Account ID ────────────────────────────────────────────────────────
if [ -n "$AD_ACCOUNT_ID" ]; then
  echo "  ✓ Ad Account ID already set ($AD_ACCOUNT_ID) — skipping."
else
  echo ""
  echo "  [Meta] Enter your Ad Account ID."
  echo "  (Ads Manager → top-left account dropdown → looks like act_XXXXXXXXX)"
  echo ""
  printf "  Ad Account ID (act_...): "
  read -r AD_ACCOUNT_ID
  echo ""
  # Normalize — add act_ prefix if they left it off
  if [ -n "$AD_ACCOUNT_ID" ] && [[ "$AD_ACCOUNT_ID" != act_* ]]; then
    AD_ACCOUNT_ID="act_${AD_ACCOUNT_ID}"
  fi
  if [ -z "$AD_ACCOUNT_ID" ]; then
    echo "  ERROR: Ad Account ID cannot be empty — it's required for the Ads dashboard."
    exit 1
  fi
fi

# ── Shopify store domain ───────────────────────────────────────────────────────
if [ -n "$SHOPIFY_STORE_DOMAIN" ]; then
  echo "  ✓ Shopify store domain already set ($SHOPIFY_STORE_DOMAIN) — skipping."
else
  echo ""
  echo "  [Shopify] Enter your Shopify store domain (optional — skip for ads-only)."
  echo "  (Format: yourstore.myshopify.com)"
  echo ""
  printf "  Store domain (or press Enter to skip): "
  read -r SHOPIFY_STORE_DOMAIN
  echo ""
  if [ -z "$SHOPIFY_STORE_DOMAIN" ]; then
    echo "  ⚠  Shopify domain skipped — Revenue and P&L tabs will show no Shopify data."
  fi
fi

# ── Shopify client credentials ────────────────────────────────────────────────
if [ -z "$SHOPIFY_STORE_DOMAIN" ]; then
  echo "  Shopify app credentials skipped (no store domain set)."
elif [ -n "$SHOPIFY_CLIENT_ID" ] && [ -n "$SHOPIFY_CLIENT_SECRET" ]; then
  echo "  ✓ Shopify app credentials already set — skipping."
else
  echo ""
  echo "  [Shopify] Enter your Shopify app Client ID and Client Secret."
  echo "  (Shopify Partners → Apps → your app → Client credentials)"
  echo ""
  if [ -z "$SHOPIFY_CLIENT_ID" ]; then
    printf "  Client ID: "
    read -r SHOPIFY_CLIENT_ID
    echo ""
  fi
  if [ -z "$SHOPIFY_CLIENT_SECRET" ]; then
    printf "  Client Secret: "
    read -rs SHOPIFY_CLIENT_SECRET
    echo ""
  fi
  if [ -z "$SHOPIFY_CLIENT_ID" ] || [ -z "$SHOPIFY_CLIENT_SECRET" ]; then
    echo "  ⚠  Shopify app credentials skipped."
    SHOPIFY_CLIENT_ID=""
    SHOPIFY_CLIENT_SECRET=""
  fi
fi

# ── Klaviyo private key ───────────────────────────────────────────────────────
if [ -n "$KLAVIYO_PRIVATE_KEY" ]; then
  echo "  ✓ Klaviyo key already set — skipping."
else
  echo ""
  echo "  [Klaviyo] Enter your Klaviyo Private API Key (optional)."
  echo "  (Klaviyo → Settings → API Keys → Create Private API Key)"
  echo ""
  printf "  Private Key (or press Enter to skip): "
  read -rs KLAVIYO_PRIVATE_KEY
  echo ""
  if [ -z "$KLAVIYO_PRIVATE_KEY" ]; then
    echo "  ⚠  Klaviyo key skipped — Email tab will not be available."
  fi
fi

# ── Anthropic API key ─────────────────────────────────────────────────────────
if [ -n "$ANTHROPIC_API_KEY" ]; then
  echo "  ✓ Anthropic API key already set — skipping."
else
  echo ""
  echo "  [Anthropic] Enter your Anthropic API Key for AI Insights (optional)."
  echo "  (console.anthropic.com → API Keys → Create Key)"
  echo ""
  printf "  API Key (or press Enter to skip): "
  read -rs ANTHROPIC_API_KEY
  echo ""
  if [ -z "$ANTHROPIC_API_KEY" ]; then
    echo "  ⚠  Anthropic key skipped — AI Insights will not be available."
  fi
fi

# ── Write .env ────────────────────────────────────────────────────────────────
cat > .env <<EOF
META_ACCESS_TOKEN=$META_ACCESS_TOKEN
AD_ACCOUNT_ID=$AD_ACCOUNT_ID
SHOPIFY_STORE_DOMAIN=$SHOPIFY_STORE_DOMAIN
SHOPIFY_CLIENT_ID=$SHOPIFY_CLIENT_ID
SHOPIFY_CLIENT_SECRET=$SHOPIFY_CLIENT_SECRET
SHOPIFY_ACCESS_TOKEN=$SHOPIFY_ACCESS_TOKEN
KLAVIYO_PRIVATE_KEY=$KLAVIYO_PRIVATE_KEY
ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY
PORT=3000
EOF

echo ""
echo "  ✓ .env updated."

# ── Install deps (only if needed) ─────────────────────────────────────────────
if [ ! -d node_modules ]; then
  echo "  Installing Node dependencies..."
  npm install --silent
  echo "  ✓ Dependencies installed."
fi

echo ""
echo "  ✓ Setup complete."
echo ""
echo "  Start the dashboard:  node server.js"
echo "  Then open:            http://localhost:3000"
if [ -n "$SHOPIFY_CLIENT_ID" ] && [ -z "$SHOPIFY_ACCESS_TOKEN" ]; then
  echo ""
  echo "  To connect Shopify, open:  http://localhost:3000/shopify/auth"
fi
echo ""
