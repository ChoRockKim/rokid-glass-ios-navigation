# 02. Rokid AI Glasses 개발 언어 / SDK / 프레임워크 조사

조사일: 2026-10-19. 방법: 웹 검색 + 페이지 fetch (WebSearch/WebFetch).
표기: **[확인]** = 1차/2차 출처에서 직접 확인, **[2차]** = 제3자 글(블로그/뉴스/커뮤니티)에만 근거, **[추측]** = 추론.
한계: Rokid 공식 문서(developer.rokid.com/docs, CXR-M/CXR-S Reference)에는 직접 접근하지 못했다. 공식 API 시그니처는 반드시 공식 문서로 재확인할 것.

## 1. 개발 경로 한눈에 보기

Rokid 쪽에는 서로 성격이 다른 경로가 4개 있다.

| 경로 | 언어/도구 | 실행 위치 | 비고 |
|---|---|---|---|
| A. 폰 컴패니언 + CXR-M SDK | Kotlin/Java (Android) | 폰이 주(主), 안경은 카메라/마이크/디스플레이 단말 | 가장 문서/샘플이 많음 |
| B. 안경 단독 Android 앱 + CXR-S SDK | Kotlin/Java (Android) | 안경(YodaOS-Sprite, Android 계열) | 공식 CXR-S 문서 미확인 |
| C. AIUI (JavaScript + Ink) / AIUI Studio / .aix | JS + Ink 페이지, 웹 기반 도구 | 안경 위 AIUI 런타임 | 2026 신규, 에이전트/공간 UI 중심 |
| D. Lingzhu(灵珠) 커스텀 에이전트 | 임의 언어 서버 (SSE) | 클라우드/자체 서버 | 안경은 음성 UI 역할 |
| E. Unity | C# + 커뮤니티 AAR 브릿지(CXR-L), 또는 UXR SDK(AR 계열) | 폰 Unity 앱 | 제3자 의존 |

## 2. 항목별 조사 결과

### 2.1 네이티브 Android (Kotlin/Java)
- **[확인]** Rokid 오픈 플랫폼이 2025-09 Rokid Glasses용 SDK를 공개했고 CXR-M(폰 측), CXR-S(안경 측) SDK를 갱신했다. 대상 OS는 YodaOS-Master(AR Studio/AR Lite)와 YodaOS-Sprite(Rokid Glasses). 출처: https://www.ithome.com/0/880/994.htm
- **[확인]** CXR-M은 Kotlin으로 쓰는 예가 다수 있다 (`CxrApi.getInstance()`, `initBluetooth`, `connectBluetooth`, `initWifiP2P`). 출처: https://developer.cloud.tencent.com/article/2596080
- **[확인]** 실사용 프로젝트 RokidAIAssistant: Kotlin 2.2.10, AGP 9.0, Gradle 9.3, minSdk 28 / targetSdk 34 / compileSdk 36, JDK 21 권장, Compose + Material3, Retrofit/OkHttp, Room. CXR "client-m" 1.2.2 를 Rokid Maven 에서 받음. 출처: https://github.com/zero2005x/RokidAIAssistant
- **[확인]** Rokid Maven 저장소: `https://maven.rokid.com/repository/maven-public/` (CXR-L `com.rokid.cxr:client-l` 용으로 확인). 출처: https://github.com/ARDings/RokidAIGlassesUnityBridge
- **[2차]** `com.rokid.cxr:client-m` 좌표는 서드파티 Kotlin SDK(xg.glass)와 위 프로젝트에서 확인. `client-s` 좌표는 찾지 못함. 출처: https://libraries.io/maven/io.github.hkust-spark:xgglass-device-meta

### 2.2 Unity / Unreal
- **Unity [2차/커뮤니티]**: RokidAIGlassesUnityBridge 가 CXR-L(`client-l` 1.0.1)을 AAR 로 감싸 Unity(2021.3 LTS+, minSdk 31)에서 OAuth 로그인, 사진, 16kHz PCM 오디오, CustomView 텍스트 표시를 제공한다. 한계: 공식 allowlist 우회 수동 intent, 리플렉션 의존(SDK 내부 변경 시 깨질 수 있음), customViewUpdate 재렌더 안 됨(닫고 다시 열어 깜빡임), 화면 상시 켜짐 필요. 출처: https://github.com/ARDings/RokidAIGlassesUnityBridge
- **Unity UXR SDK [2차]**: 중국어 제3자 튜토리얼이 Unity Package Manager 로 Rokid UXR SDK 를 import 하는 방법을 설명(샘플 20+). 이는 AR Studio/Lite 같은 AR(6DoF) 계열 얘기일 가능성이 높고, 디스플레이 있는 AI Glasses 에도 적용되는지는 **[추측]**/미확인. 출처: https://developer.cloud.tencent.com/article/2574173 (검색 요약 기준, 본문 미검증)
- **Unreal**: 이번 조사에서 Rokid 의 Unreal 지원 근거를 찾지 못함. **[확인: 근거 없음]**, 공식적으로 지원한다고 볼 수 없다.

### 2.3 웹 / JS
- **[확인]** AIUI: 공식 영문 기술문서가 "JavaScript 와 Ink 로 AIUI 앱 개발"이라고 소개. 출처: https://js.rokid.com/AIUI?lang=en-US (awesome-rokid 의 설명 인용), https://github.com/Anezium/awesome-rokid
- **[확인]** 스캐폴딩: `npm create @yodaos-pkg/aiui-agent@latest my-agent`. 시작 프로젝트: `app.js`, `app.json`, `AGENTS.md`, `pages/index/index.ink`. samples/ 에 UI, 디바이스 API, 게임, 오디오, 스캐너, 블루투스, TTS, 자이로 예제. 출처: https://github.com/jsar-project/AIUI
- **[확인]** AIUI Studio(웹): 2026-09 IFA Berlin 에서 글로벌 출시, 자연어로 앱 생성, 안경 없이 쓰는 시뮬레이터(Interactive Inview), AIUI Code / AIUI Skills Library. 등록 개발자 약 35,000명, Agent Store 에이전트 500+. 출처: https://www.androidheadlines.com/2026/09/rokid-opens-ai-glasses-development-aiui-studio.html
- **[확인]** `.aix` 패키지(검사/미리보기/패킹/서명/ADB 설치) CLI: https://github.com/yodaos-project/aix (awesome-rokid 기재)
- **[2차]** Lumen: 커뮤니티 웹앱 런처 플랫폼. 출처: https://github.com/beyondlevi/rokid-lumen
- **React Native**: 근거 없음. 공식/커뮤니티 모두 확인 못함. 폰 컴패니언을 RN 으로 만들려면 CXR-M 이 네이티브 AAR 이므로 네이티브 모듈 브릿지를 직접 써야 할 것으로 **[추측]**.

### 2.4 안경 단독(glasses-side) vs 폰 컴패니언
- **[확인]** 폰 컴패니언 구조 예(RokidAIAssistant): `phone-app`(AI 호출, STT, DB, CXR 통신) / `glasses-app`(카메라, Compose UI, 웨이크워드) / `common`(프로토콜). 이 프로젝트는 안경 단독 동작을 범위 밖으로 둠. 출처: https://github.com/zero2005x/RokidAIAssistant
- **[확인]** 공식 데모 glass3_sdk_demo: `glassdemo`(안경 측: 사진/영상, NV21 프레임, 음성, 상태 조회), `glass3sdkphonedemo`(폰 측: 메시지, 파일 전송, 실시간 오디오/비디오 수신), `glass3-media-streaming`(WebRTC), `industry/hazard-recognition`(안경에서 Wi-Fi 로 비전 모델 호출). 즉 안경에서 직접 도는 Android 앱이 가능하다. 출처: https://github.com/RokidSuuport/glass3_sdk_demo
- **[확인]** AIUI/.aix 에이전트는 안경 위에서 실행되는 별도 계층(ADB 설치 가능).
- 정리: 안경 단독 앱(CXR-S/Android, AIUI) 과 폰 연동(CXR-M) 이 모두 존재. 단독 앱은 안경 성능/배터리 제약이 있을 것으로 **[추측]**.

### 2.5 음성 / 카메라 / 디스플레이 / AI API
CXR-M 쪽 호출(출처: https://developer.cloud.tencent.com/article/2596080, 시그니처는 글쓴이 예시이며 공식 확인 필요):
- 음성: `setAiEventListener(onAiKeyDown/onAiKeyUp/onAiExit)`, `sendTtsContent(text)`; CXR-L 은 16kHz mono PCM 스트림 (Unity 브릿지 근거)
- 카메라: `openGlassCamera(w,h,quality,cb)` 프레임 스트림, `takeGlassPhoto(w,h,quality,cb)`
- 디스플레이: `openCustomView(json)`, `updateCustomView(json)`, `closeCustomView()`, `sendCustomViewIcons()` (JSON 레이아웃을 안경에 렌더). 안경 측 Compose UI 는 glasses-app 방식.
- 전송 채널: Bluetooth(제어) + Wi-Fi P2P(대용량)
- AI/에이전트: (a) 폰 앱이 STT → LLM → TTS 를 직접 구성(RokidAIAssistant 는 AI 15종/STT 18종 지원). (b) Lingzhu 커스텀 에이전트: 2026-02 발표, SSE 기반, Rokid Open Platform 에서 URL+인증키 등록, DeepSeek/Qwen/Kimi/OpenClaw 연결 언급, 개인 개발자는 심사 없이 배포 가능하다는 보도. **[2차]** 출처: https://news.aibase.com/news/25479 (공식 문서 미확인)
- 비공식 TTS: https://github.com/bzerk/rokid-private-tts-kit (private binder, 변경 위험)

## 3. 언어/경로별 장단점

| 경로 | 장점 | 단점 |
|---|---|---|
| Kotlin + CXR-M (폰 앱) | 샘플/글 많음, 폰 연산·네트워크·저장 활용, LLM API 연동 쉬움, Claude Code 가 가장 잘 다룸 | 폰 필수, Maven 저장소/공식 문서 접근 필요, SDK 버전/allowlist 이슈 |
| Kotlin + CXR-S (안경 앱) | 폰 없이 동작 가능, 저지연 | 공식 문서·좌표 미확인, 디바이스 제약, ADB 설치 |
| AIUI (JS + Ink) | 진입 쉬움, 시뮬레이터, 공식 AI 코딩 스킬(`skills/aiui-dev`) 존재, 에이전트 스토어 배포 | 신생(2026), 디스플레이형 안경 위주, 저수준 하드웨어 접근 한계 가능 |
| Lingzhu 에이전트(서버) | 언어 자유(Python/Node 등), 모델 교체 쉬움, 배포 간단 | SSE 규격 등 공식 문서 미검증, 카메라/디스플레이 제어 제한 가능(추측) |
| Unity | 3D/게임 | 서드파티 브릿지 의존, 리플렉션 취약, Unreal 근거 없음 |

## 4. Claude Code 로 개발할 때의 추천

1. **1순위: Kotlin Android 폰 컴패니언 (CXR-M) + 필요 시 안경 모듈.** 빌드/테스트가 명확(Gradle, 에뮬레이터/실기기), 참조 구현(RokidAIAssistant, glass3_sdk_demo)이 있어 Claude Code 가 코드 생성·수정하기 가장 쉽다. [추측: 일반적 판단]
2. **AI 에이전트만 필요하면 AIUI(JS+Ink) 또는 Lingzhu 서버.** AIUI 는 AGENTS.md 와 공식 Dev Skill 이 있어 Claude Code 친화적. 단 실기기/시뮬레이터 검증이 필요.
3. Unity/RN 은 필요가 명확할 때만.
4. 시작 전 확인할 것: 어떤 모델(Rokid Glasses 디스플레이형 vs 기타)을 쓰는지, Rokid 개발자 계정/Maven 접근, CXR-M/S 공식 Reference.

## 5. 최소 샘플 프로젝트 구조 (Kotlin 폰 컴패니언 기준; RokidAIAssistant 구조를 참고한 제안)

```
rokid-app/
  settings.gradle.kts        # repositories: google(), mavenCentral(),
                             #   maven("https://maven.rokid.com/repository/maven-public/")
  gradle/libs.versions.toml
  common/                    # 폰-안경 프로토콜 메시지, 상태, 상수
  phone-app/
    build.gradle.kts         # implementation("com.rokid.cxr:client-m:<버전>")
    src/main/kotlin/.../
      cxr/CxrConnection.kt   # initBluetooth/connectBluetooth, 콜백
      ai/LlmClient.kt        # STT -> LLM -> TTS
      ui/ ...
  glasses-app/               # (선택) 안경 단독/보조 앱, CXR-S
```
AIUI 최소 구조: `app.js`, `app.json`, `AGENTS.md`, `pages/index/index.ink` (출처: jsar-project/AIUI).
위 좌표/버전은 [2차]이므로 `client-m`/`client-s` 최신 버전은 Maven 저장소에서 직접 확인할 것.

## 6. 미확인 / 추가 조사 필요
- 공식 CXR-M/CXR-S Reference (developer.rokid.com/docs) 직접 열람
- `client-s` 아티팩트 좌표, 안경 단독 앱 설치/서명 절차
- Unreal 지원, React Native 지원 (근거 없음)
- Lingzhu 에이전트 SSE 규격 공식 문서
- UXR SDK 가 AI Glasses(디스플레이형)에 해당하는지

## 출처 목록
- https://www.ithome.com/0/880/994.htm
- https://developer.cloud.tencent.com/article/2596080
- https://github.com/zero2005x/RokidAIAssistant
- https://github.com/RokidSuuport/glass3_sdk_demo
- https://github.com/ARDings/RokidAIGlassesUnityBridge
- https://github.com/jsar-project/AIUI
- https://github.com/Anezium/awesome-rokid
- https://www.androidheadlines.com/2026/09/rokid-opens-ai-glasses-development-aiui-studio.html
- https://www.androidcentral.com/gaming/virtual-reality/rokid-wants-anyone-to-build-ai-agents-for-its-smart-glasses
- https://news.aibase.com/news/25479
- https://developer.cloud.tencent.com/article/2574173
- https://libraries.io/maven/io.github.hkust-spark:xgglass-device-meta
