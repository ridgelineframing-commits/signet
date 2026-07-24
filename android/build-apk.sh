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

# The signing certificate's validity window MUST start comfortably in the past.
# keytool defaults the "valid from" date to the moment the key is generated; a
# field tablet whose clock is even slightly behind that instant then sees the
# cert as "not yet valid" and refuses to install with "There was a problem
# parsing the package" — even though the APK itself is perfectly fine and
# correctly signed. (This is the real cause of the parse errors the SDK-version
# and versionName patches above never fixed.) Backdating notBefore to a fixed
# past date makes the APK immune to device clock skew.
KEYSTORE_STARTDATE="2020/01/01 00:00:00"

if [ ! -f signet-release.keystore ]; then
  echo "No keystore found — generating a new one (remember the password you set!)."
  keytool -genkeypair -v -keystore signet-release.keystore -alias signet \
    -keyalg RSA -keysize 2048 -validity 14600 -startdate "$KEYSTORE_STARTDATE"
  echo
  echo ">>> New signing key created (cert valid from ${KEYSTORE_STARTDATE})."
  echo ">>> The signing key — and therefore the app's fingerprint — has CHANGED, so:"
  echo ">>>   1. Update public/.well-known/assetlinks.json with the SHA-256 below."
  echo ">>>   2. Redeploy the Worker so the new fingerprint is live."
  echo ">>>   3. UNINSTALL any older Signet build on the tablets before installing"
  echo ">>>      (a different key can't upgrade an existing install)."
  keytool -list -v -keystore signet-release.keystore -alias signet | grep 'SHA256:'
else
  echo "Using existing keystore. NOTE: if the tablets report \"problem parsing the"
  echo "package\", the certificate's start date is likely too recent for their clocks."
  echo "A cert's dates can't be edited in place — rotate to a freshly backdated key:"
  echo "    mv signet-release.keystore signet-release.keystore.old && ./build-apk.sh"
  echo "then update public/.well-known/assetlinks.json with the new fingerprint,"
  echo "redeploy, and reinstall (the signing key will have changed)."
fi

# Regenerate the Android project from twa-manifest.json (no build yet).
bubblewrap update --skipVersionUpgrade

# --- Patch the generated project so the APK actually installs ----------------
# Three fixes, all of which otherwise produce "There was a problem parsing the
# package" on shipping tablets:
#   1. Bubblewrap's default compiles against the newest *preview* SDK (via an
#      alpha androidx.browser) — e.g. compileSdk 36 (Android 16). APKs built
#      against an unreleased/preview SDK only install on that same preview build.
#      Pin to the latest *released* API (34 / Android 14) + stable browser-helper.
#   2. `bubblewrap update --skipVersionUpgrade` leaves versionName empty, and many
#      Android installers reject an empty versionName. Set it from twa-manifest.json.
#   3. Bubblewrap copies the web share-target / file-handler "accept" list straight
#      into <data android:mimeType="…"> elements. A bare file extension there (e.g.
#      ".pdf") is NOT a valid MIME type — at install the package parser throws
#      MalformedMimeTypeException and rejects the WHOLE apk. twa-manifest.json is
#      kept clean, but strip any slash-less mimeType from the generated manifest
#      too, as a belt-and-suspenders guard against bubblewrap reintroducing one.
VERSION_NAME=$(sed -n 's/.*"appVersionName":[[:space:]]*"\([^"]*\)".*/\1/p' twa-manifest.json)
VERSION_NAME=${VERSION_NAME:-1.0.0}
sed -i.bak -E \
  -e 's/compileSdkVersion[[:space:]]+[0-9]+/compileSdkVersion 34/' \
  -e 's/targetSdkVersion[[:space:]]+[0-9]+/targetSdkVersion 34/' \
  -e 's/androidbrowserhelper:[0-9.]+([-a-z0-9]*)?/androidbrowserhelper:2.5.0/' \
  -e "s/versionName \"\"/versionName \"${VERSION_NAME}\"/" \
  app/build.gradle && rm -f app/build.gradle.bak

# Delete any <data android:mimeType="…"> whose value has no "/" (an invalid MIME
# type that would abort package parsing at install time).
MANIFEST=app/src/main/AndroidManifest.xml
if [ -f "$MANIFEST" ]; then
  sed -i.bak -E '/<data[[:space:]][^>]*android:mimeType="[^"\/]*"/d' "$MANIFEST" \
    && rm -f "$MANIFEST.bak"
fi

# Build + sign the release APK against the patched (released-SDK) project. The
# checksum from `update` still matches twa-manifest.json, so this won't regenerate
# and clobber the patch above.
bubblewrap build --skipPwaValidation

echo
echo "Done. Sideload android/app-release-signed.apk onto the tablet:"
echo "  adb install -r app-release-signed.apk"
echo "or copy the .apk to the device and open it (allow 'install from this source')."
