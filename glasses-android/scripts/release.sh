#!/usr/bin/env bash
# 고정 키로 서명한 릴리스 APK 를 빌드하고, (선택) 서버 OTA 에 올린다.
#   scripts/release.sh <versionCode> <versionName> [--upload]
# 필요한 환경 변수 (값은 저장소에 넣지 않는다):
#   RELEASE_KEYSTORE_B64  또는 RELEASE_KEYSTORE(파일 경로)   고정 서명 키 (keystore, alias rokidroute)
#   RELEASE_KEYSTORE_PASS                                    키 비밀번호
#   GLASS_DEVICE_TOKEN                                       안경 전용 토큰 (APK 에 들어감)
#   OTA_UPLOAD_TOKEN                                         --upload 할 때
#   ROUTE_SERVER (기본 https://route-server-production.up.railway.app)
#   GRADLE_INIT (선택) Maven 미러 init 스크립트 등
set -euo pipefail
cd "$(dirname "$0")/.."
CODE="${1:?versionCode}"; NAME="${2:?versionName}"; UPLOAD="${3:-}"
SERVER="${ROUTE_SERVER:-https://route-server-production.up.railway.app}"
KS="${RELEASE_KEYSTORE:-}"
if [ -z "$KS" ]; then
  : "${RELEASE_KEYSTORE_B64:?RELEASE_KEYSTORE 또는 RELEASE_KEYSTORE_B64 필요}"
  KS="$(mktemp -d)/release.keystore"; printf '%s' "$RELEASE_KEYSTORE_B64" | base64 -d > "$KS"
fi
GRADLE="./gradlew"; command -v gradle >/dev/null && [ ! -s gradle/wrapper/gradle-wrapper.jar ] && GRADLE=gradle
$GRADLE --no-daemon -q ${GRADLE_INIT:+-I "$GRADLE_INIT"} assembleRelease \
  -PVERSION_CODE="$CODE" -PVERSION_NAME="$NAME" -PROUTE_SERVER="$SERVER" \
  -PDEVICE_TOKEN="${GLASS_DEVICE_TOKEN:?GLASS_DEVICE_TOKEN 필요}" \
  -PRELEASE_KEYSTORE="$KS" -PRELEASE_KEYSTORE_PASS="${RELEASE_KEYSTORE_PASS:?RELEASE_KEYSTORE_PASS 필요}" 2>&1 | grep -v JAVA_TOOL || true
APK=app/build/outputs/apk/release/app-release.apk
[ -s "$APK" ] || { echo "빌드 실패"; exit 1; }
OUT="build/rokid-route-glasses-$NAME.apk"; mkdir -p build; cp "$APK" "$OUT"; echo "built $OUT ($(wc -c < "$OUT") bytes)"
if [ "$UPLOAD" = "--upload" ]; then
  curl -sS --fail-with-body -X PUT "$SERVER/app/upload?versionCode=$CODE&versionName=$NAME" \
    -H "Authorization: Bearer ${OTA_UPLOAD_TOKEN:?OTA_UPLOAD_TOKEN 필요}" --data-binary @"$OUT"; echo
fi
