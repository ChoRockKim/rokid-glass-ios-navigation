# 01. Rokid AI Glasses 개발 환경 (macOS + Claude Code)

조사일: 2026-10-19. 방법: 웹 검색/페이지 fetch. 표기 규칙:
- [확인] 출처 페이지에서 직접 확인한 사실
- [2차] 서드파티/커뮤니티 문서에만 있는 내용 (공식 미확인)
- [추측] 확인 못 한 추론, 직접 검증 필요

주의: 공식 문서 본문(custom.rokid.com, open.rokid.com)은 JS 렌더링/로그인 때문에 fetch로 내용을 읽지 못했다. 아래 SDK 좌표/버전은 대부분 커뮤니티 문서 기준이며 공식 값과 다를 수 있다.

## 1. 하드웨어/OS 라인업 (두 갈래)

| 제품 | OS | 개발 방식 |
|---|---|---|
| Rokid Glasses (디스플레이 AI 글래스) | YodaOS-Sprite (Android 12 기반 [2차]) | CXR-M/CXR-S SDK, AIUI(JS/Ink) 에이전트 |
| Rokid AR Studio / AR Lite (Max Pro + Station Pro 등) | YodaOS-Master | UXR SDK (Unity/OpenXR), 일반 Android 앱 |

- [확인] Rokid Glasses SDK가 2025-09 오픈플랫폼에 공개. YodaOS-Master(AR Studio, AR Lite)와 YodaOS-Sprite(Rokid Glasses) 지원. CXR M/CXR S SDK 업데이트. 개발자 체험 프로그램은 ADB 지원 디버깅 데이터 케이블을 제공. https://www.ithome.com/0/880/994.htm
- [확인] UXR SDK 2.0: 0/3/6DoF, 제스처/레이/키보드마우스/음성 입력, Unity 및 OpenXR 엔진, MRTK 지원 (2023 AR Studio 시기 보도). 최신 버전/문서는 미확인. https://www.xrtoday.com/?p=47232 , https://www.arm.com/company/success-library/arm-designs/rokid-ar-studio

## 2. 공식 포털/문서

- Rokid 오픈 플랫폼: https://open.rokid.com/ (ar.rokid.com/sdk 가 301로 여기로 이동) [확인: 리다이렉트만 확인, 본문 미열람]
- 공식 문서 호스트 custom.rokid.com (CXR-S 권한 설정 문서 링크가 이 호스트) [2차] https://adg.csdn.net/696f3618437a6b403369a6e6.html
- AIUI Studio (Global, 웹 IDE + 시뮬레이터): https://aiui-global.rokid.com/space [확인]
- AIUI 기술 문서: https://js.rokid.com/AIUI?lang=en-US [확인: awesome-rokid가 official로 표기]
- AIUI 개발 툴/샘플/스킬 저장소: https://github.com/jsar-project/AIUI [확인]
- AIX(.aix 패키지 CLI): https://github.com/yodaos-project/aix [확인]
- 목록/큐레이션: https://github.com/Anezium/awesome-rokid
- 커뮤니티 문서(비공식, 역공학 포함, Rokid와 무관): https://github.com/buildwithfenna/rokid-docs

## 3. SDK 정리

| SDK | 위치 | 역할 | 좌표/버전 |
|---|---|---|---|
| CXR-M | 폰(Android) | 안경 제어: BT/Wi-Fi 연결, 카메라, TTS, AI 연동 | `com.rokid.cxr:client-m` 1.0.8 [2차 rokid-docs], 1.2.2 [2차 RokidAIAssistant], 스니펫에 0.0.5 스냅샷도 있음. 다른 글은 `com.rokid.cxr:cxr-mobile:latest` |
| CXR-S | 안경(YodaOS-Sprite) 위 앱 | 폰과 데이터 채널/메시지 송수신 | `com.rokid.cxr:cxr-service-bridge:1.0-SNAPSHOT` [2차 rokid-docs], 다른 글은 `com.rokid.cxr:cxr-sdk:latest` |
| CXR-L | 안경 단독(폰 없이) | standalone | `com.rokid.cxr:client-l:0.0.1` [2차] |
| UXR | AR Studio(Master) | 입력/렌더 (Unity, OpenXR) | 좌표 미확인 |

- Maven 저장소 [2차, 두 곳 이상 일치]: `https://maven.rokid.com/repository/maven-public/`
- 좌표가 문서마다 달라(client-m vs cxr-mobile, cxr-service-bridge vs cxr-sdk) 실제 해석 가능한 것은 gradle 의존성 해석으로 직접 검증해야 한다 [추측: 버전/이름이 변경된 듯].
- CXR-M 요구사항 [2차]: minSdk 28, 권한은 위치(COARSE/FINE), BLUETOOTH(_ADMIN/_CONNECT/_SCAN), 네트워크/Wi-Fi 상태. Android 12+는 SCAN/CONNECT 런타임 요청. 출처 https://raw.githubusercontent.com/buildwithfenna/rokid-docs/main/cxr-m/sdk-integration.md
- 설정 예 [2차]:
  ```kotlin
  // settings.gradle.kts
  dependencyResolutionManagement { repositories {
    maven { url = uri("https://maven.rokid.com/repository/maven-public/") }
    google(); mavenCentral() } }
  // build.gradle.kts
  implementation("com.rokid.cxr:client-m:<version>")
  ```
- 페어링에는 Rokid 발급 client secret이 필요 (예제 프로젝트가 `ROKID_CLIENT_SECRET`를 local.properties에 둠) [2차]. https://github.com/zero2005x/RokidAIAssistant
- 참고 샘플: https://github.com/RokidSuuport/glass3_sdk_demo , https://github.com/zero2005x/RokidAIAssistant (폰 모듈 + 안경 모듈 gradle 구성, Kotlin) [2차]
- 3개 개발 경로 요약:
  1. AIUI/AIX: JS+Ink로 에이전트 작성, 안경이 호스트 런타임 실행. Android 빌드 불필요. 가장 쉬움.
  2. CXR-M(폰 앱) + 선택적 CXR-S(안경 앱): 네이티브 Android(Kotlin/Gradle).
  3. UXR + Unity: AR Studio 계열.

## 4. 안경에 adb 연결/디버깅

- [2차] 안경(RV101 기준 설명)에서 ADB를 켜려면 폰의 Rokid 앱(Rokid AI 앱)에서 개발자 모드/ADB를 활성화해야 하며, 케이블만 꽂는다고 켜지지 않는다. https://github.com/ksuzukigh/rokid-mac-control
- [2차] 자석 충전 포트가 데이터도 지원하지만 전용 개발 케이블(5핀)이 필요. 기본 동봉 3핀 충전 케이블은 데이터 불가. 개발 케이블은 Rokid 개발자 담당에 문의. 같은 출처 + rokid-docs cxr-s/development-environment.md
- [확인] 개발자 체험 프로그램이 ADB 지원 디버깅 데이터 케이블을 제공 (ithome 링크).
- [2차] 최초 1회 USB 연결 후 같은 Wi-Fi에서 무선 접속 가능. 재부팅 후에는 안경의 "Wi-Fi ON" 앱을 켜야 함. (Rokid Control 앱 동작 기준; adb connect 포트는 문서에 없음)
- [2차/다른 기기] Rokid Station은 `adb connect <ip>:5555` 후 `adb install` (Android XR 일반 가이드 사이트). 안경 본체에 그대로 적용되는지는 [추측].
- 이후 일반 adb 사용 [추측: 표준 Android]: `adb devices`, `adb install -r app.apk`, `adb logcat`, `adb shell`, `adb exec-out screencap -p`, `scrcpy`(Rokid Control 앱이 번들해 화면 미러링에 사용).
- 폰과 안경이 동시에 adb에 보이면 `ANDROID_SERIAL=<serial> ./gradlew :glasses-app:installDebug` 로 대상 지정 [2차 RokidAIAssistant].
- AIX 경로는 `aix install my-agent.aix` 가 ADB로 연결된 Rokid Glasses에 설치 [확인] https://github.com/yodaos-project/aix
- 기타 macOS 도구(커뮤니티): https://github.com/ksuzukigh/rokid-mac-control , https://github.com/bcefghj/rokid-collection/tree/main/rokid-glasses-control

## 5. 에뮬레이터/시뮬레이터

- [확인] 데스크톱 AVD형 에뮬레이터는 확인되지 않음. 공식 시뮬레이터는 AIUI Studio 웹의 Device Simulation > Preview (음성 입력, 템플 터치 조작: 클릭/더블클릭/스와이프, 조명 환경 시뮬레이션). https://raw.githubusercontent.com/jsar-project/AIUI/main/documentation/0-guide/quickstart/quickstart.en-US.md
- [확인] `aix preview ./my-agent` 로컬 Ink 프리뷰 (yodaos-project/aix).
- [2차] GlassKit 데모에 "emulator-friendly input mapping"이 있다는 언급뿐.
- [추측] CXR-M 폰 앱은 BT 기기 필요라 일반 Android 에뮬레이터로는 안경 연동 테스트가 어렵다. 안경 실기기가 사실상 필수(AIUI 제외).
- 실기기 테스트(AIUI): AIX 패키징 후 Hi Rokid 앱 Settings > Developer > Update glasses resource package, 음성으로 "Hi Rokid, open the xxx agent". [확인]

## 6. Gradle CLI 빌드

- [2차] 예제 프로젝트 요건: JDK 21, Android SDK API 36(compileSdk), minSdk 28, AGP 9.0, Gradle 9.3 Kotlin DSL. 이는 그 프로젝트의 선택이며 Rokid 요건 아님. CXR-M 자체 요건은 minSdk 28 [2차].
- 명령 [2차 RokidAIAssistant, 표준 gradle]:
  ```
  ./gradlew assembleDebug
  ./gradlew :glasses-app:assembleDebug
  ./gradlew :phone-app:installDebug
  ```
- 안경 앱은 별도 모듈/APK로 빌드해 adb로 설치, 폰 앱은 폰에 설치하는 2모듈 구조가 일반적 [2차].
- Android Studio 없이 CLI만으로 가능 [추측: 표준 Android 프로젝트이므로]. 프로젝트 신규 생성 템플릿은 Studio나 예제 repo 복제가 편함.

## 7. macOS 도구 설치 (표준 절차, Rokid 특화 아님)

```bash
brew install --cask temurin@21          # JDK 21
brew install --cask android-commandlinetools
brew install android-platform-tools scrcpy
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
export PATH=$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools
yes | sdkmanager --licenses
sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0"
# AIUI/AIX 경로
brew install node   # Node 20+ (AIUI 요구)
npm install -g @yodaos-pkg/aix-cli
npm create @yodaos-pkg/aiui-agent@latest my-agent
```
- Node 20+ 는 [확인](AIUI), 나머지 brew cask 이름과 경로는 일반 지식이라 [추측 수준]으로 설치 후 확인할 것. API 레벨/빌드툴 버전은 프로젝트에 맞춰 조정.

## 8. Claude Code 워크플로 (제안, 대부분 추측/권장)

1. 경로 선택: 빠른 시작은 AIUI. 공식 스킬 설치 [확인]:
   `npx skills add https://github.com/jsar-project/AIUI/tree/main/skills/aiui-dev` (그 외 aiui-cloud-integration, aiui-cloud-apis). 스타터에 `AGENTS.md`가 포함됨. Claude Code는 CLAUDE.md를 읽으므로 `CLAUDE.md`에 `@AGENTS.md` import 추천 [추측].
2. 네이티브 Android 경로 CLAUDE.md에 넣을 내용(권장):
   - JDK/SDK 경로 환경변수, 모듈 구성(phone-app, glasses-app), 빌드/설치 명령, `ANDROID_SERIAL` 사용 규칙
   - Rokid maven 저장소 URL과 실제 해석된 SDK 좌표/버전 (검증 후 기록)
   - 안경 화면은 작은 디스플레이/템플 조작이라는 UI 제약, 전력/발열 주의
   - `adb logcat` 필터 방법, 한 번에 한 기기만 대상
3. 자동화 권장: 권한 allowlist에 `./gradlew *`, `adb devices/install/logcat`, `sdkmanager`; 커스텀 스킬(예: `/deploy-glasses` = assemble → adb install → logcat 스냅샷) 작성.
4. MCP: Rokid 전용 MCP는 확인되지 않음. 대신 안드로이드 일반 adb 래핑 MCP는 많으나 필수 아님; Bash로 adb/gradle 직접 호출이 단순 [추측]. 공식 문서 열람은 chrome MCP 또는 WebFetch(로그인/JS 렌더링 한계 있음).
5. 로컬 문서 캐시: 읽기 어려운 공식 문서는 사람이 PDF/마크다운으로 저장해 docs/ 에 두고 CLAUDE.md에서 참조.
6. 화면 확인: `adb exec-out screencap -p > shot.png` 후 Claude가 이미지 Read [추측: 안경에서 screencap 동작 여부 미검증].

## 9. 미확인/다음 할 일

- open.rokid.com 의 실제 SDK 다운로드/문서 목록 (브라우저로 로그인 후 확인 필요)
- CXR-M/S 정확한 최신 좌표와 maven 인증 필요 여부
- UXR SDK 최신 버전과 AR Studio 현행 판매/지원 여부
- 개발 케이블 입수 방법, 글로벌 판매 기기에서의 ADB 활성화 절차
- client secret 발급 절차 (개발자 계정 등록)

## 출처 목록
- https://www.ithome.com/0/880/994.htm
- https://github.com/jsar-project/AIUI
- https://raw.githubusercontent.com/jsar-project/AIUI/main/documentation/0-guide/quickstart/quickstart.en-US.md
- https://github.com/yodaos-project/aix
- https://github.com/Anezium/awesome-rokid
- https://github.com/buildwithfenna/rokid-docs
- https://github.com/zero2005x/RokidAIAssistant
- https://github.com/ksuzukigh/rokid-mac-control
- https://adg.csdn.net/696f3618437a6b403369a6e6.html
- https://open.rokid.com/
- https://www.xrtoday.com/?p=47232
- https://www.arm.com/company/success-library/arm-designs/rokid-ar-studio
- https://anexplorer.io/install/apk-on-glasses
