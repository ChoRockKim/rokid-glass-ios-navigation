# Rokid Glasses (RG-glasses / RV101) 하드웨어·소프트웨어 사양 근거 검증

조사일: 2026-11-04. 대상: 디스플레이 탑재 "Rokid Glasses"(1세대, 모델명 RV101 / RG-glasses). Glasses 2는 별개 제품으로 구분.

신뢰도 순서: (A) 공식 스펙 페이지 > (B) 리뷰/리테일 스펙표 > (C) 팀 분해 기사 > (D) GitHub README/커뮤니티.
이번 조사에서 **공식 스펙 페이지(global.rokid.com)와 분해 기사는 직접 열람하지 못했다(미확인)**. 아래 근거는 주로 (B) 리테일/뉴스, (D) 커뮤니티이며, 검색 요약 도구가 전달한 인용을 그대로 옮긴 것이다. PhoneArena는 403으로 직접 열람 실패, 검색 스니펫으로만 확인했다.

## 요약 판정표

| # | 항목 | 판정 |
|---|------|------|
| 1 | GPS/GNSS 내장 | 미확인(내장 증거 없음, 정황상 없음 추측) |
| 2 | 나침반/IMU | IMU 확인 / 자기계(나침반) 미확인 |
| 3a | 해상도 480x640 | 부분확인(출처 간 불일치) |
| 3b | 녹색 단색 | 확인 |
| 3c | 시야각 | 확인(25~30도, 출처별 상이) |
| 3d | 밝기 | 부분확인(1500 nits 다수, 1000 nits 일부) |
| 4a | Snapdragon AR1 / 2GB RAM | 확인 |
| 4b | Android 12 | 부분확인(커뮤니티 테스트 기반, 공식 아님) |
| 4c | YodaOS-Sprite | 부분확인(Android 커스텀 OS로 기술) |
| 5a | Wi-Fi 내장 | 확인(Wi-Fi 6) |
| 5b | 폰 없이 인터넷 앱 설치/실행 | 부분확인(ADB 사이드로드 후 가능 정황, 인터넷 permission 직접 근거 없음) |
| 5c | 폰 앱 없이 Wi-Fi 설정 | 부분확인(커뮤니티 앱 존재, 최초 ADB/폰 필요 가능성) |
| 6 | 마이크/스피커/카메라/터치패드 | 확인 |
| 7 | 한국 정식 출시·한국어 | 미확인(출시 근거 없음) / 한국어 부분확인 |

## 1) GPS/GNSS 내장 여부 — [미확인]

- 스펙표에 GPS 항목 없음. 출처: Wellbots 스펙표 (B). "GPS: Not listed."(WebFetch 요약) https://www.wellbots.com/products/rokid-glasses-display-smart-glasses
- 중국어 스펙표(ai-bot.cn, B)도 GPS 미기재. https://ai-bot.cn/rokid-glasses/
- 일본어 개발 가이드(D)는 "GPS does not work" 라고 서술, 이유로 Google Mobile Services 미동작을 듦. 즉 안드로이드 위치 서비스가 동작하지 않는다는 서술이지 GNSS 칩 유무를 직접 증명하지 않음. https://note.com/kotauchisunsun/n/nc1dc3286798b
- 리뷰 요약(검색 스니펫, B)에 "GPS 신호 끊김" 언급이 있으나 이는 폰 연동 내비게이션 맥락으로 추정.
- 추측: 내장 GNSS 칩은 없고 폰 위치를 쓰는 구조일 가능성이 높다. 단, 분해 기사로 검증하지 못함.

## 2) 자기계/IMU — IMU [확인], 자기계 [미확인]

- Wellbots(B): 센서는 IMU만 표기. "IMU: Supported"
- ai-bot.cn(B): "支持 IMU", "佩戴检测"(착용 감지).
- awesome-rokid(D): "Camera2 face-tracking and IMU sci-fi HUD tested on RG-glasses/Android 12"; "direction sensing and physical glasses behavior still need validation" (방향 감지는 미검증이라고 명시). https://github.com/Anezium/awesome-rokid
- 9축 IMU(자력계 포함) 표기는 Rokid Air, AR Spatial 등 다른 제품에서만 확인됨(vrarwiki 등). Rokid Glasses의 자기계는 근거 없음.
- 축 수, 센서 모델은 미확인.

## 3) 디스플레이

- 해상도 [부분확인]. 출처가 갈린다.
  - Wellbots 주요특징: "480 × 640", 같은 페이지 스펙표는 "480 × 400" (자체 모순). (B)
  - ai-bot.cn: 显示分辨率 "640*480" (B)
  - Notebookcheck 등: 480 x 380 (검색 요약, 직접 열람 안 함)
  - awesome-rokid(D): 앱이 "480x640 Rokid glasses app"으로 스트리밍. 개발자가 실제 쓰는 UI 해상도가 480x640(세로 640)이라는 정황. 
  - 판단: 480x640(세로형 포트레이트, 개발자 관점 UI 해상도) 주장은 개발자 커뮤니티 근거로 가장 유력. 단 JBD 0.13" VGA 패널(640x480 계열)이며 광학 유효 영역은 더 작을 수 있다(추측).
- 컬러 [확인: 녹색 단색]. Wellbots "Binocular Micro LED waveguide"(single green); 일본어 가이드 "Monochrome green binocular display"; awesome-rokid "single-green Micro-LED glasses". 
- 시야각 [확인, 값은 상이]. Wellbots "30°", ai-bot.cn "30度", Notebookcheck 요약 25°.
- 밝기 [부분확인]. Wellbots "1,500 nits", 일본어 가이드 아마존 표기 "1500ニトの明るさ", ai-bot.cn "1000nits".

## 4) 프로세서/RAM/OS

- SoC [확인]: Wellbots "Qualcomm Snapdragon AR1", ai-bot.cn "高通AR1". 보조칩 NXP RT600은 검색 요약만(미직접확인).
- RAM/저장 [확인]: Wellbots "2GB", ai-bot.cn "运行内存 2GB, 存储 32GB". "12GB RAM" 류 주장은 반증.
- Android 12 [부분확인]: KangChansoo/rokid-glasses-dev README "Pairing, authenticated connection and device information confirmed on Rokid RG-glasses / Android 12 / API 32." (D) https://github.com/KangChansoo/rokid-glasses-dev. 공식 문서는 Android 버전을 명시하지 않는다는 검색 요약이 있음.
- YodaOS-Sprite [부분확인]: 일본어 개발 가이드(D) "YodaOS-Sprite" 를 "a customized Android"로 설명. 중국 뉴스(검색 요약)에서도 개발 플랫폼이 YodaOS-Sprite를 지원한다고 전함. 공식 스펙 페이지에서는 확인하지 못함.
- 참고: 검색 중 AnExplorer 페이지의 "Android 12" 표기는 Rokid Station(별도 제품) 것이었다는 요약이 있어, 글래스의 Android 12 근거는 위 GitHub 쪽만 사용했다.

## 5) Wi-Fi / 단독 인터넷 / 폰 없는 설정

- Wi-Fi 내장 [확인]: Wellbots "Wi-Fi 6, Bluetooth 5.3"; ai-bot.cn "WiFi 6".
- 기본 동작: 일본어 가이드(D) "Wi-Fi is basically OFF on Rokid Glasses", "Turning on Wi-Fi ... drains the battery rapidly"; 대만 가이드(D) "Wi-Fi 功能通常是被手機上的 Hi Rokid app 喚醒". https://vocus.cc/article/6982c1adfd89780001347b25
- 폰 없이 앱 실행 [부분확인]: 일본어 가이드 "the apk simply runs within the Rokid Glasses." 일반 Android APK를 ADB(개발자 케이블, 5핀 데이터 케이블 필요 / Hi Rokid의 ADB 스위치)로 설치해 실행. 설치 시 Hi Rokid(폰)가 필요한 경로도 있음(KangChansoo README: "install it on the glasses through Hi Rokid").
- 인터넷 permission [미확인]: 어떤 출처도 INTERNET permission 요구/제한을 직접 다루지 않음. 일반 Android 모델이므로 manifest에 선언하면 될 것이라는 것은 **추측**이며, 실기 검증 필요.
- 폰 앱 없이 Wi-Fi 설정 [부분확인]: awesome-rokid(D)에 "Wi-Fi ON: Standalone recovery app that turns Wi-Fi back on and reconnects RV101 to a saved network", "Rokid_Wifi: WiFi connection tool for touchless Rokid AR glasses with gesture and offline voice input", "WifiScan: Scans a Wi-Fi QR code with the glasses camera." 대만 가이드: "透過 Rokid Manager 就可以直接在眼鏡中打開 Wi-Fi 常駐", Wi-Fi 비밀번호 입력에 Gboard 필요. 단 최초 앱 설치 자체가 ADB/폰을 거치므로 완전한 폰 무관 부트스트랩은 증명되지 않음. 페이지도 "full phone-free setup" 을 확인하지 않음.

## 6) 마이크/스피커/카메라/터치패드 — [확인]

- 카메라: Wellbots "12MP", 사진 "3024 × 4032", 영상 "Up to 3K at 30 fps". ai-bot.cn 조리개 F2.25, 촬영 표시등. IMX681 센서는 검색 요약만(미확인).
- 마이크: Wellbots "4-microphone array" (ai-bot.cn은 "定向拾音麦克风").
- 스피커: Wellbots "Dual linear directional high-fidelity speakers"; ai-bot.cn "2颗超线性定向高保真扬声器".
- 터치패드: ai-bot.cn "触摸板x2", 별도 "拍照键". (Wellbots는 미기재)

## 7) 한국 출시/한국어 — 출시 [미확인], 한국어 [부분확인]

- 한국 출시 근거 없음. 한국어/영어 검색에서 출시국으로 확인된 곳: 캐나다, 호주, 프랑스, 영국(Selfridges), 필리핀, 대만, 홍콩, 일본(Makuake). Kyodo PR(B) 목록에 한국 없음. https://kyodonewsprwire.jp/release/202601132381 "across Asia and Europe"라고만 하고 한국 지명 없음.
- 한국어: 실시간 번역 "89 languages"(Wellbots)이며 한국어 포함 여부는 확인 못함. 오프라인 번역 5~6개국어 목록(일/영/중/독/프/스)에 한국어 없음(검색 요약). Knox Labs는 다른 모델(AI Glasses Style)에 대해 음성 AI 12개 언어에 한국어 포함이라 서술 — 이 제품 근거로 쓰면 안 됨. awesome-rokid(D)에 "Korean menus", "Offline English-Korean text translation app" 등 서드파티 한국어 앱이 있음.
- 결론: 한국 정식 판매는 확인되지 않음. 직구/글로벌 사이트 구매 가정이 안전.

## 한계

- 공식 스펙 페이지, 분해 기사, PhoneArena 원문을 직접 열람하지 못했다. 인용 일부는 검색·요약 도구를 거친 것이라 원문과 미세하게 다를 수 있다.
- 핵심 미해결: GNSS 유무, 자기계 유무, 실제 표시 해상도(480x640 vs 640x480 vs 480x400), INTERNET permission 실동작, 폰 없는 Wi-Fi 최초 설정. 실기 또는 분해 자료로 확인 필요.
