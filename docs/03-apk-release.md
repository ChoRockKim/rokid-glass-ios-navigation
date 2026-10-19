# Rokid AI Glasses APK 빌드 · 서명 · 배포 · 출시 조사

조사일: 2026-10-19. 방법: 웹 검색 + 페이지 열람.
표기: [확인] 출처에 직접 적힌 사실 / [커뮤니티] 비공식 커뮤니티 자료에 적힌 내용 / [추측] 근거 없는 추정 / [미확인] 찾지 못함.

주의: Rokid 공식 문서(open.rokid.com, 로그인 필요)는 직접 열람하지 못했다. 공식 사이트 본문은 로봇 접근 시 제목만 반환되었다. 그래서 아래 상당수는 커뮤니티가 정리한 내용이다. 공식 절차로 확정하려면 open.rokid.com 에 로그인해 확인해야 한다.

## 1. 플랫폼 전제

- [확인] Rokid Glasses 는 YodaOS-Sprite, AR Studio / AR Lite 는 YodaOS-Master 를 쓴다. 2025-09 개방 플랫폼에 Rokid Glasses SDK 가 공개되었고 CXR-M / CXR-S SDK 가 갱신되었다. 플랫폼 구성은 SDK, 개발 가이드, 포럼, 앱 스토어다. (https://www.ithome.com/0/880/994.htm)
- [커뮤니티] 글래스는 Android 12(API 32), arm64-v8a, Snapdragon AR1 이며 앱은 일반 Android APK 다. Gradle/Kotlin 으로 빌드해 ADB 로 설치한다. 예제는 minSdk 31 을 쓴다. (https://github.com/Youfengxu/rokid-yoda, https://raw.githubusercontent.com/Youfengxu/rokid-yoda/main/docs/DEVICE-SETUP.md)
- [확인] 역할 분담: CXR-M SDK 는 폰 쪽, CXR-S SDK 는 글래스 쪽(YodaOS-Sprite)이다. 폰 앱이 블루투스, Wi-Fi P2P 로 글래스를 제어한다. (https://juejin.cn/post/7577668116525318190, https://adg.csdn.net/696f3618437a6b403369a6e6.html)

## 2. 릴리스 APK / AAB 빌드 (Gradle CLI)

일반 Android 방식이며, Rokid 전용 빌드 도구는 필요 없어 보인다. (아래 명령은 표준 Gradle 명령이고, Rokid 프로젝트 사례로 뒷받침됨.)

- [커뮤니티] 실제 폰+글래스 프로젝트 사례: 릴리스 APK `./gradlew :phone-app:assembleGithubRelease`, Play 용 AAB `./gradlew :phone-app:bundlePlayRelease`, 글래스 앱 `:glasses-app:assembleDebug`. 출력은 `build/outputs/apk/...`, `build/outputs/bundle/playRelease/`. 툴체인: JDK 21, AGP 9.0, Gradle 9.3, compileSdk 36, minSdk 28, targetSdk 34. (https://github.com/zero2005x/RokidAIAssistant)
- 일반 명령 (표준 Android): `./gradlew assembleRelease`(APK), `./gradlew bundleRelease`(AAB).
- [추측] 글래스 앱은 minSdk 를 31 이하로 두는 것이 안전하다(기기가 Android 12). targetSdk 는 기기 OS 이하로 맞추는 편이 안전하다. 검증 안 됨.

## 3. 키스토어 서명

- [확인, 표준 Android] 키 생성: `keytool -genkeypair -v -keystore release.jks -alias myalias -keyalg RSA -keysize 2048 -validity 10000`. Gradle `signingConfigs`에 `storeFile/storePassword/keyAlias/keyPassword` 를 두고 `buildTypes.release.signingConfig` 로 연결한다. 비밀번호는 `local.properties`나 환경변수로 분리한다. 수동 서명은 `zipalign` 후 `apksigner sign`.
- [커뮤니티] 위 사례 프로젝트는 GitHub 배포용 `RELEASE_*` 키와 Play 업로드용 `PLAY_UPLOAD_*` 키를 분리한다. (https://github.com/zero2005x/RokidAIAssistant)
- [커뮤니티] 개발용 예제는 debug 키로 서명한 debug APK 를 그대로 설치한다. 즉 사이드로딩에는 Rokid 가 서명을 요구하지 않는 것으로 보인다. (DEVICE-SETUP.md) [추측] 공식 스토어 등록 시 별도 서명 요건이 있을 수 있으나 [미확인].
- 키스토어는 분실하면 같은 패키지로 업데이트할 수 없으므로 백업 필수(Android 일반 원칙).
- [확인] `.aix`(에이전트 패키지)는 별개 포맷이며 Ed25519 선택 서명을 지원한다. (https://github.com/yodaos-project/aix)

## 4. adb 사이드로딩

[커뮤니티] 절차 (https://raw.githubusercontent.com/Youfengxu/rokid-yoda/main/docs/DEVICE-SETUP.md, https://github.com/Youfengxu/rokid-yoda):
1. 글래스를 Rokid AI 폰 앱에 페어링.
2. 폰 앱의 글래스 설정에서 ADB/개발자 모드 켜기(메뉴 이름은 앱 버전마다 다름).
3. 5핀 Rokid 개발자 케이블로 PC 연결. 일반 자석 충전 케이블은 USB 데이터/ADB 가 안 된다.
4. 글래스의 USB 디버깅 허용 팝업 수락, `adb devices` 에서 `device` 확인.
5. `adb install -r app-release.apk`, 실행은 `adb shell am start -n <패키지>/.MainActivity`.

- [확인] 개발자 케이블은 시중 판매가 아니라 얼리액세스 프로그램에서 제공된다: 과정을 마치고 신청 계획을 제출한 개발자에게 ADB 지원 전용 디버그 케이블을 준다. (https://www.ithome.com/0/880/994.htm)
- [확인/커뮤니티] 폰 한 대에서 케이블 없이 설치하는 경로도 있다 (https://github.com/Anezium/Rokid-APKs):
  - CXR-M: 폰이 BLE 로 연결, Wi-Fi Direct 로 APK 업로드 후 글래스에 설치 요청. Rokid client secret 필요.
  - CXR-L: 폰의 Hi Rokid 앱에 권한 요청 후 설치.
  - 글래스용 동반 앱 + Bluetooth SPP(느림) 또는 같은 Wi-Fi LAN(빠름). 글래스 화면에서 설치 확인 필요.
  - Wi-Fi 로 PC 가 전송하는 도구, WebUSB 설치 도구 등도 있다. 목록: https://github.com/Anezium/awesome-rokid
- [커뮤니티] CXR-M 의 FileController 는 Wi-Fi Direct 위 HTTP(포트 8848)로 APK 를 업로드한다. (https://github.com/buildwithfenna/rokid-docs)
- [커뮤니티] Rokid Station/Max 등 구형 제품은 Station 의 IP 에 `adb connect <ip>:5555` 방식이라고 한 서드파티 앱 사이트가 적었으나 홍보성이고 Glasses 와 무관할 수 있다. (https://anexplorer.io/features/apk-installer/glasses) 신뢰도 낮음.

## 5. 공식 스토어 / 개발자 센터 등록 · 심사

- [확인] 개방 플랫폼(open.rokid.com)에 SDK, 가이드, 포럼, 앱 스토어 모듈이 있다고 소개된다. (ithome)
- [확인] SDK/문서는 open.rokid.com 로그인 뒤(Development Tools → SDK) 제공된다는 커뮤니티 보고가 있다. CXR-M 은 신청 방식(Glasses.BD@rokid.com 문의)이라고 한다. [커뮤니티] (rokid-yoda README)
- [미확인] 일반 APK 앱의 스토어 제출 절차, 심사 기준, 심사 기간, 수수료, 수익 배분은 공개 자료에서 찾지 못했다. 검색 결과에 없었다.
- [확인] 에이전트 경로는 별도다. 2026 IFA 에서 Rokid 가 브라우저 기반 AIUI Studio(글로벌)를 공개했고, 설계부터 게시까지 지원하며 시뮬레이터로 하드웨어 없이 테스트한다. 게시된 에이전트는 Rokid Agent Store(500개 이상 주장)에 올라간다. (https://www.adnkronos.com/immediapress/eng/rokid-launches-aiui-studio-globally-at-ifa-berlin-2026-making-ai-glasses-creation-more-accessible-for-everyone_3q0I2abZWQTqV4lsfKCYqW, https://www.androidcentral.com/gaming/virtual-reality/rokid-wants-anyone-to-build-ai-agents-for-its-smart-glasses)
  - AIUI 문서: https://js.rokid.com/AIUI?lang=en-US, 스튜디오: https://aiui-global.rokid.com/space
  - `.aix` 패키징: `npm i -g @yodaos-pkg/aix-cli`, `aix pack`, `aix install`(ADB 로 글래스에 설치). 스토어 게시 절차는 해당 README 에 없다. (https://github.com/yodaos-project/aix)
- [확인] 중국 쪽 "자체 에이전트" 기능(2026-02): 개방 플랫폼에서 등록하고 API 권한을 받아 灵珠(rizon.rokid.com)에서 만든다. 개인 개발자의 에이전트는 심사 없이 비공개 호출이 가능하다고 보도되었다. (https://tech.ifeng.com/c/8mAfQWA7izf 등 검색 요약, 본문 직접 확인은 못 함)
- [추측] 네이티브 APK 는 스토어 심사를 거치거나 거치지 않고 사이드로딩만 가능할 수 있다. 현재 근거로는 사이드로딩이 실질적 경로다.

## 6. Google Play 가능 여부

- [커뮤니티] 폰 컴패니언 앱은 일반 Android 앱이므로 Play 에 올릴 수 있다. 사례 프로젝트는 Play 버전(AAB)과 GitHub 버전(APK)을 나눠 빌드하며, Play 버전은 비공개 Rokid CXR SDK 를 제외하고 클래식 Bluetooth SPP 만 쓴다. (https://github.com/zero2005x/RokidAIAssistant) 이는 CXR SDK 의 재배포가 약관상 제한되기 때문으로 보인다. [추측]
- [확인] CXR SDK 는 Rokid 자체 약관 하의 독점 라이브러리다. (같은 출처)
- 글래스 자체에 Play 스토어가 있다는 근거는 없다 [미확인]. 글래스 앱의 Play 배포는 불가능하거나 의미가 없다고 보는 것이 합리적이다. [추측]

## 7. 폰 컴패니언 앱 (Rokid 앱 연동)

- [확인/커뮤니티] 구조: 폰 앱(CXR-M)이 글래스 앱(CXR-S 또는 일반 APK)과 BLE/Bluetooth + Wi-Fi P2P 로 통신. 인증에 `ROKID_CLIENT_SECRET` 이 필요하다. (https://github.com/zero2005x/RokidAIAssistant, Rokid-APKs)
- [커뮤니티] CXR-L 방식은 Hi Rokid 앱이 인증을 대행한다 (Rokid-APKs).
- [주의] 자기 Rokid 자격증명을 넣어 빌드한 APK 를 배포하면 자격증명이 노출된다. 재배포 금지 권고가 있다. (Rokid-APKs)
- [추측] 상용 배포 시 Rokid 와 별도로 CXR-M 사용 허가와 client secret 발급 절차를 거쳐야 하며, 이는 BD 문의 대상일 가능성이 높다.

## 8. 버전 관리 / OTA

- [표준] `versionCode` 를 매 릴리스마다 증가, `versionName` 은 시맨틱 버전. 동일 서명 키여야 `adb install -r` 로 덮어쓰기 업데이트가 된다.
- [커뮤니티] 글래스 시스템 OTA 는 `RokidOtaUpgrade`(Virtual A/B, 롤백 지원)가 담당한다. 이는 펌웨어용이며 서드파티 앱 OTA 가 아니다. (https://github.com/buildwithfenna/rokid-docs)
- [미확인] 서드파티 앱 자동 업데이트 메커니즘(스토어 경유 업데이트 등). [추측] 자체 업데이트는 폰 컴패니언 앱이 새 APK 를 CXR-M 으로 푸시하는 방식으로 구현 가능하다. Rokid-APKs 가 그 방식의 사례다.
- 펌웨어 업데이트로 SDK 좌표/동작이 바뀔 수 있다는 경고가 있다 (rokid-yoda README). 회귀 테스트 필요.

## 9. 비용 · 지역 제한 (한국)

- [확인] 해외 정식 출시는 2025-08-27 뉴욕 행사, 홍콩판(광둥어)도 발표. 2026-01 보도자료에 아시아/유럽 리테일 언급. (https://tech.ifeng.com/c/8mAfQWA7izf, https://kyodonewsprwire.jp/release/202601142404)
- [미확인] 한국 공식 판매, 한국어 지원, 한국 개발자 등록 가능 여부는 찾지 못했다.
- [커뮤니티] 기본 로케일이 zh-CN 이고 해외판 변종(OEM 105, RV101)이 있다. (rokid-docs) 지역별 펌웨어/계정 차이 가능성이 있다 [추측].
- 비용: 개방 플랫폼 가입비, 스토어 등록비 정보는 [미확인]. SDK 다운로드는 로그인만 필요하다고 보고됨 (커뮤니티). Google Play 는 일반 규정상 개발자 등록 1회 25달러(표준 사실, 이번 조사에서 재확인하지 않음).
- 개발자 케이블은 얼리액세스 신청 필요 [확인, ithome]. 비한국 개발자에게 열려 있는지 [미확인].

## 10. 권장 경로 (잠정)

1. 개발/내부 배포: 표준 Gradle 릴리스 APK + 자체 키스토어 서명 → 개발자 케이블 `adb install -r`, 또는 폰 컴패니언 앱으로 CXR-M 푸시.
2. 폰 앱: 일반 Android 앱으로 Play 배포 가능. 단 CXR SDK 라이선스 확인 선행(Play 판은 SPP 대체 사례 참고).
3. 공개 배포가 필요하면 open.rokid.com 가입 후 앱 스토어 요건을 공식 문서에서 확인하거나 BD 에 문의. 에이전트 형태라면 AIUI Studio 경로를 검토.

## 남은 확인 과제
- open.rokid.com 로그인 상태에서 앱 스토어 제출 가이드, 서명 요건, 심사 기준 열람.
- 한국 계정으로 개발자 등록과 CXR-M client secret 발급 가능 여부.
- 한국 내 Rokid Glasses 구매/펌웨어/Hi Rokid 앱 사용 가능 여부.

## 출처 모음
- https://www.ithome.com/0/880/994.htm
- https://github.com/Youfengxu/rokid-yoda
- https://raw.githubusercontent.com/Youfengxu/rokid-yoda/main/docs/DEVICE-SETUP.md
- https://github.com/buildwithfenna/rokid-docs
- https://github.com/zero2005x/RokidAIAssistant
- https://github.com/Anezium/Rokid-APKs
- https://github.com/Anezium/awesome-rokid
- https://github.com/yodaos-project/aix
- https://www.adnkronos.com/immediapress/eng/rokid-launches-aiui-studio-globally-at-ifa-berlin-2026-making-ai-glasses-creation-more-accessible-for-everyone_3q0I2abZWQTqV4lsfKCYqW
- https://www.androidcentral.com/gaming/virtual-reality/rokid-wants-anyone-to-build-ai-agents-for-its-smart-glasses
- https://tech.ifeng.com/c/8mAfQWA7izf
- https://kyodonewsprwire.jp/release/202601142404
- https://juejin.cn/post/7577668116525318190
- https://adg.csdn.net/696f3618437a6b403369a6e6.html
- https://anexplorer.io/features/apk-installer/glasses (신뢰도 낮음)
