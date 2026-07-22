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

# Regenerate the Android project from twa-manifest.json (no build yet).
bubblewrap update --skipVersionUpgrade

# --- Pin to a RELEASED Android SDK -------------------------------------------
# Bubblewrap's current default compiles against the newest *preview* SDK (via an
# alpha androidx.browser) — e.g. compileSdk 36 (Android 16). APKs built against an
# unreleased/preview SDK cannot be installed on shipping devices: they fail with
# "There was a problem parsing the package." We pin to the latest *released* API
# (34 / Android 14) and the matching stable browser-helper so the APK installs on
# any Android 5.0+ tablet.
sed -i.bak -E \
  -e 's/compileSdkVersion[[:space:]]+[0-9]+/compileSdkVersion 34/' \
  -e 's/targetSdkVersion[[:space:]]+[0-9]+/targetSdkVersion 34/' \
  -e 's/androidbrowserhelper:[0-9.]+([-a-z0-9]*)?/androidbrowserhelper:2.5.0/' \
  app/build.gradle && rm -f app/build.gradle.bak

# Build + sign the release APK against the patched (released-SDK) project. The
# checksum from `update` still matches twa-manifest.json, so this won't regenerate
# and clobber the patch above.
bubblewrap build --skipPwaValidation

echo
echo "Done. Sideload android/app-release-signed.apk onto the tablet:"
echo "  adb install -r app-release-signed.apk"
echo "or copy the .apk to the device and open it (allow 'install from this source')."
