# glasses-app (AIUI)

Rokid Glasses 에서 도는 길안내 표시 앱. 서버(`server/`)에 WebSocket(`wss://…/glass`)으로 붙어 현재 단계를 크게 보여 주고, 탭으로 다음 단계를 보낸다.

## 화면
```
3/14                         → 왕십리역 2호선
← 외국어대교차로에서 좌회전          (line1, 34px)
회기역앞교차로까지 662m · 이문로     (line2, 26px)
                       탭 다음 · ▲ 이전
```
480×352 논리 해상도, 단색 녹색 기준.

## 입력 (문서 기준, 실기 미확인)
| 안경 | `event.code` | 동작 |
|---|---|---|
| 탭 | `Enter` | 다음 |
| 앞으로 쓸기(추정) | `ArrowDown` | 다음 |
| 뒤로 쓸기(추정) | `ArrowUp` | 이전 |
| 더블탭(추정) | `Backspace` | 기본 동작(닫기) |

## 위치
`navigator.geolocation.watchPosition` 으로 받은 위치를 2초에 한 번까지 서버로 보낸다 (`{"type":"position",lat,lon,acc,ts}`). 이 위치가 안경 자체인지 폰(Hi Rokid 앱)에서 오는지는 문서에 없다. 안 되면 폰의 Overland 가 대신 보낸다.

## 실행 (AIUI Studio 시뮬레이터)
1. https://aiui-global.rokid.com/ 로그인
2. **Import from Github** → 저장소 `ChoRockKim/rokid-glass-ios-navigation`, 브랜치 `feat/route-server`, 디렉터리 `glasses-app` (비공개 저장소라 GitHub 권한 요청이 뜰 수 있다)
3. Studio 편집기에서 `lib/config.js` 의 `GLASS_TOKEN` 에 서버 `GLASS_TOKEN` 값을 넣는다. **이 값은 저장소에 커밋하지 않는다.**
4. **Device Simulation → Preview** 에서 템플(탭·쓸기) 조작으로 확인
5. 실기: **Build & Review → Package AIX** 후 Hi Rokid 앱에서 설치

로컬 검사: `npx @yodaos-pkg/aix-cli pack ./glasses-app` (2026-11-04 패키징 성공 확인, 5KB)

## 확인 상태
- `aix show`/`aix pack` 통과 (클라우드 세션).
- 시뮬레이터·실기 동작, 키 코드 매핑, WebSocket 이 블루투스(폰 경유)로 나가는지, 위치 출처: **미확인**.
