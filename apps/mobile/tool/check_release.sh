#!/usr/bin/env bash
# Checks a built release APK against the app checks of the launch checklist (docs/launch-checklist.md):
#   A8   signed with a release key, not the debug key
#   A9   not debuggable, no plain HTTP, no backups
#   A10  no test keys compiled in (anvil's public keys, which DEV_WALLET_PRIVATE_KEY is meant for)
# A11 (https only) is enforced by the app at startup and tested in test/core/app_config_test.dart.
#
# Usage, from apps/mobile after `flutter build apk --release ...`:
#   bash tool/check_release.sh [path/to/app-release.apk]
# Needs the Android SDK's build-tools (apksigner, aapt2): ANDROID_HOME, or sdk.dir in android/local.properties.
# Exits 1 if any check fails.
set -u

apk="${1:-build/app/outputs/flutter-apk/app-release.apk}"
[ -f "$apk" ] || { echo "No APK at $apk: build one with flutter build apk --release"; exit 2; }

sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [ -z "$sdk" ] && [ -f android/local.properties ]; then
  # local.properties escapes Windows paths: C\:\\Users\\me\\sdk
  sdk="$(sed -n 's/^sdk\.dir=//p' android/local.properties | sed 's/\\:/:/g; s/\\\\/\//g' | tr -d '\r')"
fi
tools="$(ls -d "$sdk"/build-tools/*/ 2>/dev/null | sort -V | tail -1)"
[ -n "$tools" ] || { echo "Android build-tools not found (set ANDROID_HOME)"; exit 2; }
apksigner="${tools}apksigner"; [ -f "$apksigner.bat" ] && apksigner="$apksigner.bat"
aapt2="${tools}aapt2"; [ -f "$aapt2.exe" ] && aapt2="$aapt2.exe"

failed=0
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1"; failed=1; }

# A8: the signature verifies, and its certificate isn't Android's debug certificate.
certs="$("$apksigner" verify --print-certs "$apk" 2>&1)"
if [ $? -ne 0 ]; then
  fail "A8  the APK's signature doesn't verify"
elif echo "$certs" | grep -q "CN=Android Debug"; then
  fail "A8  signed with the DEBUG key: add android/key.properties (apps/mobile/README.md, \"Signing\")"
else
  pass "A8  signed with a release key ($(echo "$certs" | sed -n 's/.*certificate DN: //p' | head -1))"
fi

# A9: the merged manifest and the network security config.
manifest="$("$aapt2" dump xmltree --file AndroidManifest.xml "$apk")"
echo "$manifest" | grep -q "debuggable([^)]*)=(type 0x12)0xffffffff\|debuggable([^)]*)=true" &&
  fail "A9  the app is debuggable" || pass "A9  not debuggable"
echo "$manifest" | grep -q "usesCleartextTraffic([^)]*)=(type 0x12)0xffffffff\|usesCleartextTraffic([^)]*)=true" &&
  fail "A9  usesCleartextTraffic is on" || pass "A9  usesCleartextTraffic is off"
echo "$manifest" | grep -q "allowBackup([^)]*)=false\|allowBackup([^)]*)=(type 0x12)0x0" &&
  pass "A9  allowBackup is off" || fail "A9  allowBackup isn't off"
config="$("$aapt2" dump resources "$apk" | grep -A1 "xml/network_security_config" | sed -n 's/.*(file) \([^ ]*\) .*/\1/p' | head -1)"
if [ -z "$config" ]; then
  fail "A9  no network security config"
elif "$aapt2" dump xmltree --file "$config" "$apk" | grep -q "cleartextTrafficPermitted=true\|cleartextTrafficPermitted=(type 0x12)0xffffffff"; then
  fail "A9  the network security config permits plain HTTP"
else
  pass "A9  the network security config refuses plain HTTP"
fi

# A10: no well-known test key in the Dart code (libapp.so) of any ABI.
keys="ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6
47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a
8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba
92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e
4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356
dbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97
2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
unzip -q -o "$apk" 'lib/*/libapp.so' -d "$work" 2>/dev/null
libs="$(find "$work" -name libapp.so)"
found=""
for lib in $libs; do
  lower="$work/lower.bin"
  tr 'A-Z' 'a-z' < "$lib" > "$lower" # grep -i on binaries crashes some greps (Git for Windows)
  for key in $keys; do grep -q -a -F "$key" "$lower" && found="$key"; done
done
if [ -z "$libs" ]; then
  fail "A10 no libapp.so in the APK"
elif [ -n "$found" ]; then
  fail "A10 a public test key (anvil, ${found:0:8}…) is compiled in: build without DEV_WALLET_PRIVATE_KEY"
else
  pass "A10 no test keys compiled in"
fi

exit $failed
