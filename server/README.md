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

출발지는 필수다. iPhone 위치를 서버가 받지 않기 때문.

Slack 앱 설정에 필요한 것: Socket Mode 켜기, App-Level Token(`connections:write`), 슬래시 커맨드 `/route`, 봇 스코프 `commands`.

## 안경 WebSocket 프로토콜
- 주소: `ws://HOST:PORT/glass`
- 인증: `Authorization: Bearer <GLASS_TOKEN>` (헤더를 못 넣는 클라이언트는 `?token=`)
- 서버 → 안경 (연결 직후 + 상태가 바뀔 때마다):
  ```json
  {"type":"step","index":0,"total":11,"text":"강남역 1번 출구까지 역사 내 이동","distance":96,"destination":"선릉역"}
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
| Slack Socket Mode 연결 | 토큰과 `apps.connections.open` 은 성공. 클라우드 세션 네트워크 정책이 `wss-primary.slack.com` 을 막아 WebSocket 연결은 미확인 |
| Slack `/route` 수신 | 미확인 |
| 안경 앱 연동 | 로컬 검증 필요 (안경) |
