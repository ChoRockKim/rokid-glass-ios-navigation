# iOS 위치 전송 근거 검증

검증일: 2026-11-04. 판정: 확인 / 부분확인 / 반증 / 미확인. WebFetch는 요약 모델을 거치므로 인용은 도구가 돌려준 원문 조각이다. 페이지 전문을 직접 대조한 것은 아니다.

## 1) OwnTracks iOS HTTP 모드 (임의 서버 JSON POST, 인증)
판정: **확인**
- 출처: https://owntracks.org/booklet/tech/http/
- 인용: "An optional HTTP mode is implemented with which the OwnTracks apps use a privately configured HTTP endpoint."
- 인용(인증): HTTP Basic authentication 사용, HTTPS 강력 권장. 앱은 "include headers to identify the user (`X-Limit-U`) and the device (`X-Limit-D`)."
- 인용(전달 판정): "a successfull return code (`2xx`) is returned the payload is considered POSTed." / "In the event that the endpoint is unreachable, the payload will be queued and posted at a later time."
- 메모: 인증은 Basic auth가 기본이다. 임의 Bearer 헤더를 지원한다는 근거는 이 페이지에 없다(미확인). 이 페이지는 iOS 전용이 아니라 iOS/Android 공통 설명이다.

## 2) 모니터링 모드, Move 갱신 간격, iOS 백그라운드
판정: **확인** (Move 간격 "보장"은 반증, 아래 참조)
- 출처: https://owntracks.org/booklet/features/location/
- 모드 인용: Quiet "Only manual location reports." / Manual "Manual location reports and automated reports with region monitoring." / Significant "Standard tracking mode with automated location reports." / Move "Frequent location."
- iOS Move 간격(페이지 요약 기준): `locatorDisplacement` 미터 이동 또는 `locatorInterval` 초 경과 중 먼저 오는 쪽에서 발행. 기본값 100 m, 300 s. 수초 단위가 아니다.
- Android Move 간격 인용: "It requests a location fix every 10s (by default, configurable in the settings through `moveModeLocatorInterval`)." 이 10초는 Android 기준이다.
- iOS 백그라운드 인용: Significant "This mode allows the app to run in background and minimize the power consumption." Manual: "The app doesn't monitor location changes in _manual_ mode while in background."
- 판단: 수초 단위 갱신 보장은 문서에 없다. iOS는 거리/시간 임계값 기반이라 보장되지 않는다고 본다. 이 결론은 추론이다.

## 3) location payload 필드
판정: **확인**
- 출처: https://owntracks.org/booklet/tech/json/
- 인용:
  - "`lat` latitude _(iOS,Android/float/degree/required)_"
  - "`lon` longitude _(iOS,Android/float/degree/required)_"
  - "`acc` Accuracy of the reported location in meters without unit _(iOS,Android/integer/meters/optional)_"
  - "`vel` velocity _(iOS,Android/integer/kmh/optional)_" (단위 km/h)
  - "`cog` Course over ground _(iOS/integer/degree/optional)_" (iOS 전용, 도)
  - "`tst` UNIX … in seconds of the location fix _(iOS,Android/integer/epoch/required)_"
  - "`batt` Device battery level _(iOS,Android/integer/percent/optional)_"
- 메모: vel, cog, acc, batt는 optional이다. vel은 정수 km/h라 해상도가 낮다.

## 4) Overland iOS
판정: **부분확인**
- 출처: https://github.com/aaronpk/Overland-iOS , https://overland.p3k.app/ , https://overland.p3k.app/api , https://overland.p3k.app/settings
- 배치: "the data is sent to the server in a batch at an interval set by the user." / "Location points are queued on the phone and sent to your server in batches, so nothing is lost when you lose signal."
- 페이로드: "The POST request body is a JSON object containing a property `locations` which is an array of GeoJSON objects."
- 응답 규약: 서버가 JSON `result: ok`를 돌려줘야 앱이 전송한 포인트를 지운다. 그렇지 않으면 다음 간격에 재시도한다. 설정에 "Consider HTTP 2XX Successful" 옵션이 있다.
- 토큰: 설정 페이지 인용 "an access token which will be sent in the HTTP Authorization header". API 페이지 요약에 따르면 `Bearer` 접두어가 붙는다.
- 배치 크기: "Controls the number of location updates that will be sent with each HTTP request" (Locations per Batch).
- 백그라운드: "It logs your location in the background and sends it to a server of your choosing." / "iOS places a lot of limits on location data, and the app does the best it can to keep running in the background as long as possible."
- 간격 한계: "you can't set the app to collect and send data at a fixed interval." 즉 수초 고정 주기는 불가하다.
- 미확인: 전송 간격의 구체적 선택지(몇 분 등)는 가져온 페이지에서 확인하지 못했다.

## 5) 단축어 개인 자동화가 수초 주기 위치 전송 불가
판정: **부분확인**
- 출처: https://support.apple.com/guide/shortcuts/apdfbdbd7123/ios
- 지원 트리거 인용("The following automations can be run automatically:"): Time of Day, Alarm, Sleep, Arrive, Leave, CarPlay, Email, Message, Transaction, Wi-Fi, Bluetooth, Apple Watch Workout, NFC, App, Airplane Mode, Do Not Disturb, Low Power Mode, Battery Level, Charger, Sound Recognition.
- 자동 실행 관련 인용: "Some personal automations can run without asking you for confirmation when they're triggered." 잠금 상태 실행은 "Allow Running When Locked" 설정이 필요하다.
- 판단(추론): 목록에 "N초마다" 같은 주기 트리거가 없다. Time of Day도 시각 지정(매일/매주/매월)이며 초 단위 반복이 아니다. 따라서 수초 간격 전송은 불가능하다고 본다. "Arrive/Leave"는 이벤트 기반이다.
- 미확인: 백그라운드 제약을 직접 명시한 Apple 문장은 찾지 못했다. 위 판단은 트리거 목록 부재에서 끌어낸 추론이다.
- 참고: https://support.apple.com/guide/shortcuts/intro-to-personal-automation-apd690170742/ios 는 "events such as time of day, arrival at a location, or the opening of an app" 정도만 서술한다.

## 6) "항상 허용", 정확한 위치, 배터리
판정: **부분확인**
- 출처(배터리, Apple 아카이브): https://developer.apple.com/library/archive/documentation/Performance/Conceptual/EnergyGuide-iOS/LocationBestPractices.html
- 인용: "improper or unnecessary use of location can prevent the device from sleeping, keep location hardware powered up, drain the user's battery, and create a poor user experience."
- 인용: "Requesting higher accuracy than you need causes Core Location to power up additional hardware and waste power for unnecessary precision."
- 인용: "Significant-change location updates run continuously, around the clock, until you stop them, and can actually result in higher energy use if not employed effectively."
- 출처(사용자 가이드): https://support.apple.com/en-us/102515 에서 "Some apps ask to use your location only while the app is in use." 정도만 확인했다. 백그라운드 사용 시 "your device will remind you from time to time that an app is using your location." 라는 취지의 문구도 있었다(요약 모델 전달본).
- 미확인: "Always" 권한과 "Precise Location" 토글을 설명하는 Apple 공식 문장은 가져오지 못했다. Apple 개발자 문서 페이지는 본문이 비어 있었고 일부 URL은 404였다. Core Location의 Always/WhenInUse/reducedAccuracy 구분은 일반 지식(추측)이며 인용 근거 없음.

## 종합 시사점
- 수초 단위 연속 위치 전송은 OwnTracks(iOS)와 Overland 모두 설계상 보장하지 않는다. OwnTracks iOS Move 기본값은 100 m / 300 s이다.
- OwnTracks는 HTTP Basic 인증 JSON POST, Overland는 Bearer 토큰 + GeoJSON 배치 POST이므로 서버 수신부가 서로 다르다.
