#!/usr/bin/env bash
# Build the Signet Android APK (a Trusted Web Activity wrapper around the live PWA).
#
# Prereqs: Node 18+ and a JDK are enough — Bubblewrap downloads its own JDK 17 and
# the Android SDK into ~/.bubblewrap on first run. You do NOT need Android Studio.
#
# Usage:
#   cd android && ./build-apk.sh
#
# Output: android/app-release-signed.apk  (sideload this onto the tablets)
#
# The signing keystore (signet-release.keystore) lives next to this script and is
# gitignored. Keep it safe and back it up — you need the SAME keystore to ship any
# future update, and its SHA-256 fingerprint is what /.well-known/assetlinks.json
# publishes so Android trusts the app to open signet.ridgeline.workers.dev links
# (and PDFs) without a browser address bar.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v bubblewrap >/dev/null 2>&1; then
  echo "Installing @bubblewrap/cli globally…"
  npm install -g @bubblewrap/cli
fi

if [ ! -f signet-release.keystore ]; then
  echo "No keystore found — generating a new one (remember the password you set!)."
  keytool -genkeypair -v -keystore signet-release.keystore -alias signet \
    -keyalg RSA -keysize 2048 -validity 10000
  echo
  echo ">>> Now update public/.well-known/assetlinks.json with this key's SHA-256:"
  keytool -list -v -keystore signet-release.keystore -alias signet | grep 'SHA256:'
  echo ">>> …then redeploy the Worker so the new fingerprint is live before installing."
fi

# Regenerate the Android project from twa-manifest.json and build a signed release APK.
bubblewrap build --skipPwaValidation

echo
echo "Done. Sideload android/app-release-signed.apk onto the tablet:"
echo "  adb install -r app-release-signed.apk"
echo "or copy the .apk to the device and open it (allow 'install from this source')."
