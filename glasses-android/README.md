# glasses-android (Rokid 안경용 APK)

Kotlin 안드로이드 앱. 서버(`server/`)의 WebSocket `/glass?map=1` 에 붙어 안내 문구와 미니맵을 그린다. `/viewer`(웹)와 같은 화면을 안경에서 직접 띄우는 것.

선택 근거: 공개된 Rokid 안경 앱 10개 중 8개가 Kotlin (Rokid 공식 `glass3_sdk_demo`, 지도 HUD `Anezium/Rokid-GMaps` 포함). 구성(minSdk 28, compileSdk 34, Kotlin 2.1, View+Canvas)은 Rokid-GMaps 를 따랐다. 통신은 OkHttp 4.12 (`Rokid_Claude` 와 같은 버전).

## 화면
- 480×282 dp 를 화면 아래 가운데에 그린다. 나머지는 검정(투과형 안경에서 안 보임).
- 위: `3/14`, `→ 목적지` / 가운데: 안내 두 줄 / 배경: 미니맵(경로·주변 도로·다음 회전 ◆·나 ▲)
- 처음 실행하면 **연결 코드 4자리**가 뜬다 (페어링).

## 연결 방식
**기본: 안경 전용 토큰을 APK 에 넣어 빌드** → 설치하고 켜면 바로 연결.
- 서버 Railway 변수 `GLASS_DEVICE_TOKEN` 과 같은 값을 빌드 때 `-PDEVICE_TOKEN=…` 으로 준다. 저장소에는 넣지 않는다.
- **APK 안에 토큰이 들어 있으므로 APK 를 남에게 주지 말 것.** 새면 Railway 에서 `GLASS_DEVICE_TOKEN` 만 바꾸고 APK 를 다시 빌드.
- 서버가 이 토큰을 거절(401)하면 아래 페어링으로 넘어간다.

### 예비: 페어링
1. 안경 앱을 켜면 `연결 코드 1234` 가 뜬다 (서버 `POST /pair/request`).
2. 폰 단축어 **"안경 연결"** 로 그 코드를 보낸다 (`POST /pair/approve`, `API_TOKEN` 인증). 만드는 법은 `docs/ios-shortcuts.md`.
3. 안경이 2초마다 확인하다가 승인되면 토큰을 받아 저장하고 연결한다. 다음부터는 바로 연결.
   서버 `GLASS_TOKEN` 을 바꾸면 401 → 자동으로 다시 페어링.

## 입력 (실기 미확인)
| 입력 | 길안내 화면 | 메뉴 |
|---|---|---|
| ENTER, DPAD_CENTER, 미디어 재생/일시정지 (탭) | 다음 | 선택 |
| DPAD_RIGHT/DOWN, 미디어 다음 | 다음 | 아래로 |
| DPAD_LEFT/UP, 미디어 이전 | 이전 | 위로 |
| BACK, ESC (더블탭) | 메뉴 열기 | 메뉴 닫기 |

`Rokid_Claude` 주석 기준 탭=ENTER, 쓸기=DPAD_LEFT/RIGHT. 어느 쓸기 방향이 앞인지는 실기에서 확인.

### R08 링 (R08 Access Bridge)
소스(Anezium/R08-Access-Bridge)만 읽고 맞춘 것. 실기 미확인.
- 링 앞/뒤 → 접근성 포커스 노드에 `ACTION_SCROLL_FORWARD/BACKWARD` → 다음/이전 (HudView 가 포커스·스크롤 가능 노드로 보인다)
- 링 탭 → `ACTION_CLICK` → 선택, 더블탭 → 뒤로(`GLOBAL_ACTION_BACK`) → 메뉴
- 스와이프 제스처로 떨어질 때는 세로 플링을 다음/이전으로, Stable 모드(미디어 키)는 위 표대로.

## 메뉴 · OTA 업데이트
뒤로 가기 → 메뉴: `길안내 화면으로` / `업데이트 확인` / `앱 종료`.
`업데이트 확인` → 서버 `GET /app/latest` → 새 버전이면 한 번 더 선택 → 다운로드 · sha256 확인 → 안드로이드 설치 창.
- 처음 한 번은 "이 출처 허용" 설정 화면으로 간다. 허용 후 다시 선택.
- 같은 키로 서명된 APK 만 덮어 설치된다 → 릴리스는 고정 키로: `scripts/release.sh <versionCode> <versionName> [--upload]` (필요한 환경 변수는 스크립트 머리말). 키·토큰은 저장소에 넣지 않는다.
- 디버그 서명 앱에서 넘어갈 때는 한 번 지우고 릴리스 APK 를 설치.

## 방향 (미니맵 회전)
- `TYPE_ROTATION_VECTOR`(지자기 포함)가 있으면 북 기준 방위 → **보고 있는 방향이 위**.
- 없으면 `TYPE_GAME_ROTATION_VECTOR`(상대 각도)로 고개 회전을 따라가고, 경로 위를 걷는 동안 경로 진행 방향으로 0°를 10%씩 보정.
- 둘 다 없으면 경로 진행 방향이 위 (`/viewer` 와 같음).
- Rokid 공식 예제는 GAME_ROTATION_VECTOR 를 쓰고 지자기 유무를 로그로만 확인한다 → 어느 모드가 될지는 실기 로그(`adb logcat -s Heading Route`)로 확인.

## 빌드
```bash
cd glasses-android
echo "sdk.dir=/path/to/android-sdk" > local.properties   # platforms;android-34, build-tools;34.0.0
./gradlew assembleDebug -PDEVICE_TOKEN="$(cat device_token)"  # → app/build/outputs/apk/debug/app-debug.apk
```
서버 주소를 바꾸려면 `./gradlew assembleDebug -PROUTE_SERVER=https://…`.
2026-11-04 클라우드 세션에서 빌드 성공 (3.5MB, 디버그 서명). Maven Central 이 429 를 줄 때는 Google 미러(`maven-central.storage-download.googleapis.com/maven2`)로 바꿔 빌드했다 (세션 전용 init 스크립트, 저장소 설정은 그대로).

디버그 키는 빌드 환경마다 달라서, 다른 곳에서 빌드한 APK 로 덮어 설치하면 서명 불일치로 실패할 수 있다 → 기존 앱을 지우고 설치.

## 확인 상태
- 빌드, APK 패키지 정보·서명: 확인
- 안경 실기 (화면 크기·위치, 키 코드, 센서 모드, 네트워크): **미확인**

## 화면 미리보기 (에뮬레이터 없이)
`./gradlew recordPaparazziDebug` → `app/src/test/snapshots/images/*.png`. Paparazzi(layoutlib, Android Studio 미리보기 엔진)로 `HudView` 를 480×282 dp 에 그린다.
입력은 서버 코드를 돌려 안경(map=1)이 받은 메시지를 저장한 `app/src/test/resources/flow.json` (실제 카카오 대중교통 경로, 실시간 도착은 가짜 값, 주변 도로는 가짜 바둑판).
클라우드 세션에 KVM 이 없어 에뮬레이터는 못 돌렸다.
