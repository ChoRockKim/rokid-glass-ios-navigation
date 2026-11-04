# route server

Slack `/route` → 카카오 지오코딩 + 도보 경로 → 안경 WebSocket 으로 한 단계씩 전달.

```
Slack /route ─(Socket Mode)─> server ─> dapi.kakao.com (keyword, routing/walk)
                                 └─ ws://host:PORT/glass ─> 안경 앱
```

## 실행
```bash
cd server
npm install
cp .env.example .env   # 값 채우기 (또는 환경 변수로 직접)
npm run dev            # tsx watch
npm test               # 단위 테스트
npx tsx scripts/smoke-kakao.ts 강남역 선릉역   # 카카오 실 API 확인
```
`.env` 는 자동으로 읽지 않는다. `node --env-file=.env` 를 쓰거나 셸에서 export 할 것.

## Slack 명령
| 명령 | 동작 |
|---|---|
| `/route 강남역 > 선릉역` | 경로 시작 (`->`, `→`, `강남역에서 선릉역` 도 됨) |
| `/route next` / `prev` | 다음/이전 단계 |
| `/route status` | 현재 단계 |
| `/route stop` | 종료 |

출발지를 안 쓰면(`/route 선릉역`) 폰에서 받은 마지막 위치(`POST /location`)에서 출발한다. 받은 위치가 없으면 출발지 필수.

Slack 앱 설정에 필요한 것: Socket Mode 켜기, App-Level Token(`connections:write`), 슬래시 커맨드 `/route`, 봇 스코프 `commands`.

## 폰 HTTP API (`API_TOKEN` 이 있을 때만 켜짐)
인증: `Authorization: Bearer <API_TOKEN>` 또는 `?token=`

| 요청 | 본문 | 설명 |
|---|---|---|
| `POST /location` | Overland `{"locations":[GeoJSON…]}` / `{"lat","lon","acc"}` / OwnTracks | 위치 반영. 응답 `{"result":"ok", index, offset, offRoute…}` |
| `POST /route` | `{"to":"왕십리역","lat":..,"lon":..}` 또는 `{"to","from"}` | 경로 시작. 출발지가 없으면 마지막 받은 위치. 응답에 `speech` |
| `POST /transit` | `{"to","lat","lon"}` 또는 `{"to","from"}` | 대중교통 후보 최대 5개 (`options`, `speech`) |
| `POST /transit/select` | `{"option":1}` | 후보 선택(1부터) → 안경 안내 시작 |
| `POST /nav` | `{"action":"next"\|"prev"\|"stop"}` | 수동 진행 |
| `GET /status` | | 현재 상태와 단계 목록 |

위치 추적 규칙 (`src/navigation.ts`):
- 경로선에 투영해 진행 거리를 구하고, 다음 회전 지점 12m 안이면 다음 단계로 넘긴다.
- 정확도 60m 초과, 이전보다 오래된 시각의 위치는 버린다.
- 경로선에서 35m(또는 정확도×1.5) 넘게 떨어지면 이탈. 3번 연속이면 현재 위치에서 재탐색 (30초 간격 제한).
- 수동 next/prev 후 60초 동안은 위치가 단계를 되돌리지 않는다.
- 안경에는 단계·이탈이 바뀌거나 남은 거리가 10m 단위로 바뀔 때만 보낸다.

대중교통 (`src/transit.ts`, `src/realtime.ts`):
- 카카오 `routing/publictraffic` 후보 → 고르면 [앞 도보(카카오 도보 API)] + [구간별 도보/버스/지하철] + [뒤 도보] 로 안경 단계를 만든다.
- 버스·지하철 단계: 타기 전 `🚌 421 3분 후 · 421 9분 후`, 탄 뒤(정류장에서 80m+ 진행) `🚌 421 탑승 중 / 성동구청 하차 · 약 2정거장`. 남은 정거장은 거리 비율 추정(정류장 좌표가 응답에 없음).
- 실시간 도착: 현재 또는 다음 단계의 아직 안 탄 구간만 `REALTIME_POLL_MS`(기본 20초)마다 조회. 키 없으면 꺼짐. **서울 지하철·버스 API 명세는 미검증** → 키를 받으면 `npx tsx scripts/probe-realtime.ts` 로 실제 응답 확인.
- 대중교통 중 이탈은 표시만 하고 도보 재탐색은 하지 않는다. 지하철 안에서는 GPS 가 안 잡혀 진행이 멈출 수 있다 (탭으로 넘김).
- Slack: `/route 대중교통 외대앞역 > 왕십리역` → `/route pick 3`

단축어 만드는 법: `../docs/ios-shortcuts.md`

```bash
API_TOKEN=... npx tsx scripts/simulate-walk.ts 37.5962 127.0633 왕십리역 20       # 경로 따라 걷기
API_TOKEN=... npx tsx scripts/simulate-walk.ts 37.5962 127.0633 왕십리역 20 600   # 600m 지점에서 이탈
```

## 안경 WebSocket 프로토콜
- 주소: `ws://HOST:PORT/glass`
- 인증: `Authorization: Bearer <GLASS_TOKEN>` (헤더를 못 넣는 클라이언트는 `?token=`)
- 서버 → 안경 (연결 직후 + 상태가 바뀔 때마다):
  ```json
  {"type":"step","index":1,"total":14,"turn":"left","line1":"← 외국어대교차로에서 좌회전","line2":"회기역앞교차로까지 662m · 이문로",
   "text":"← 외국어대교차로에서 좌회전 · 회기역앞교차로까지 662m · 이문로","distance":795,"remaining":662,"offRoute":false,"destination":"왕십리역 2호선"}
  {"type":"arrived","destination":"선릉역","text":"도착: 선릉역"}
  {"type":"idle","text":"경로 없음 · Slack에서 /route"}
  ```
- 안경 → 서버: `{"type":"next"}`, `{"type":"prev"}`, `{"type":"sync"}`
- 헬스 체크: `GET /healthz`

## 프록시
`HTTPS_PROXY` 가 있으면 카카오 fetch 와 Slack Socket Mode WebSocket 을 그 프록시로 보낸다 (`src/proxy.ts`). Node 기본 fetch 와 Slack WebSocket 은 프록시 환경 변수를 스스로 읽지 않는다.

## 검증 상태 (2026-11-04)
| 항목 | 상태 |
|---|---|
| 카카오 키워드 검색, 도보 경로 (서버 코드로) | 직접 실행 확인 |
| 안경 WS 인증(정상 토큰 연결, 틀린 토큰 401), 초기 메시지 | 로컬 클라이언트로 확인 |
| Slack Socket Mode 연결 | 확인 |
| Slack `/route 외대앞역 > 왕십리역` → 카카오 32단계 → 안경 WS 1단계 push | 실제 Slack 에서 확인 |
| `/route next` → 안경 WS 2단계 | 확인 |
| 단계 병합·회전 방향 (외대앞→왕십리 32→14~15단계) | 실제 카카오 응답으로 확인 |
| `/location` 자동 진행·남은 거리·이탈·재탐색 | 실제 경로 좌표로 만든 가짜 위치로 확인 (`simulate-walk.ts`). 실제 걸어 본 것 아님 |
| 대중교통 후보·선택·안경 단계 (외대앞→왕십리, 273번→경의중앙선) | 실제 카카오 응답으로 확인 |
| 실시간 도착 폴링 | 가짜 데이터로만 확인. 서울 API 는 키 없음·도메인 차단으로 미호출 |
| 단축어, Overland 실기 | 미확인 (폰이 이 서버에 닿으려면 배포 필요) |
| 안경 앱 연동 | 로컬 검증 필요 (안경) |

클라우드 세션(프록시 환경)에서 돌릴 때 허용 도메인에 필요한 것: `dapi.kakao.com`, `slack.com`, `wss-primary.slack.com`, `hooks.slack.com`(슬래시 커맨드 응답).

Slack 앱 DM에서 쓰려면 App Home → Messages Tab 켜고 "Allow users to send Slash commands and messages from the messages tab" 체크.
