#!/bin/bash
# ============================================================================
# new-mac-setup.sh — Bootstrap the Bodycon ops stack on a fresh Mac.
#
# HOW TO USE (on the NEW laptop):
#   1. Install prerequisites first (see PREREQS check below).
#   2. AirDrop this file + your two .env files to the new Mac.
#   3. In Terminal:  bash ~/Downloads/new-mac-setup.sh
#   4. When it finishes, drop your .env files where it tells you.
#
# It clones all 3 repos into ~/bodycon, installs deps, and reinstalls the
# quarterly WA-tax launchd job with THIS machine's paths.
# ============================================================================
set -e
BASE="$HOME/bodycon"
GH_USER="kaliacrtr"
REPOS=(ops-dashboard bodycon-returns-portal bodycon-email-builder)

echo ""
echo "  Bodycon — New Mac Setup"
echo "  ----------------------------------------"

# ---- Prereq checks (fail loud, don't guess) --------------------------------
missing=0
command -v git >/dev/null || { echo "  ✗ git not found. Install Xcode Command Line Tools: xcode-select --install"; missing=1; }
command -v node >/dev/null || { echo "  ✗ node not found. Install nvm then 'nvm install 18'  (https://github.com/nvm-sh/nvm)"; missing=1; }
command -v gh >/dev/null   || { echo "  ⚠ gh (GitHub CLI) not found — needed to clone your PRIVATE repos."; echo "     Install: brew install gh   then:  gh auth login"; missing=1; }
if command -v node >/dev/null; then
  NODE_MAJOR=$(node -v | sed 's/v\([0-9]*\).*/\1/')
  [ "$NODE_MAJOR" -ge 18 ] || { echo "  ✗ node is v$NODE_MAJOR — need 18+. Run 'nvm install 18 && nvm use 18'"; missing=1; }
fi
[ "$missing" -eq 1 ] && { echo ""; echo "  Fix the above, then re-run this script."; exit 1; }
echo "  ✓ Prereqs OK (git, node $(node -v), gh)"

# ---- Clone repos -----------------------------------------------------------
mkdir -p "$BASE"; cd "$BASE"
for repo in "${REPOS[@]}"; do
  if [ -d "$BASE/$repo/.git" ]; then
    echo "  ✓ $repo already present — pulling latest"; (cd "$BASE/$repo" && git pull --ff-only 2>/dev/null || true)
  else
    echo "  → cloning $repo ..."
    gh repo clone "$GH_USER/$repo" "$BASE/$repo"   # gh handles private-repo auth
  fi
done

# ---- Install dependencies --------------------------------------------------
for d in ops-dashboard bodycon-email-builder bodycon-returns-portal; do
  if [ -f "$BASE/$d/package.json" ]; then
    echo "  → npm install in $d ..."; (cd "$BASE/$d" && npm install --silent)
  fi
done

# ---- Reinstall the WA quarterly-tax launchd job (with THIS Mac's paths) -----
DASH="$BASE/ops-dashboard"
NODE_BIN="$(command -v node)"
PLIST="$HOME/Library/LaunchAgents/com.bodycon.watax.plist"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.bodycon.watax</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>$DASH/wa-quarterly-tax.js</string>
    </array>
    <key>WorkingDirectory</key><string>$DASH</string>
    <key>StartCalendarInterval</key>
    <array>
        <dict><key>Month</key><integer>1</integer><key>Day</key><integer>1</integer><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
        <dict><key>Month</key><integer>4</integer><key>Day</key><integer>1</integer><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
        <dict><key>Month</key><integer>7</integer><key>Day</key><integer>1</integer><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
        <dict><key>Month</key><integer>10</integer><key>Day</key><integer>1</integer><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
    </array>
    <key>StandardOutPath</key><string>$DASH/watax.log</string>
    <key>StandardErrorPath</key><string>$DASH/watax.log</string>
</dict>
</plist>
PLIST_EOF
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST" && echo "  ✓ WA quarterly-tax job reinstalled (fires Jan/Apr/Jul/Oct 1, 9am)"

# ---- Secrets reminder (these are NOT in GitHub, by design) ------------------
echo ""
echo "  ========================================================"
echo "  ⚠ LAST STEP — copy your .env secret files into place:"
echo "     $DASH/.env"
echo "         (Shopify, Klaviyo, Meta, Anthropic keys + GMAIL_APP_PASSWORD + NOTIFICATION_EMAIL)"
echo "     $BASE/bodycon-email-builder/.env"
echo "         (SHOPIFY_ACCESS_TOKEN, SHOPIFY_STORE_DOMAIN, ANTHROPIC_API_KEY, PORT)"
echo "     (returns-portal secrets live in Netlify — nothing to copy)"
echo ""
echo "  No .env yet? Run the dashboard's setup:  cd \"$DASH\" && bash setup.sh"
echo "  The tax automation won't SEND until GMAIL_APP_PASSWORD is in the dashboard .env."
echo "  ========================================================"
echo ""
echo "  Done. Your consolidated stack lives in: $BASE"
