# Railway 배포

**현재 배포 (2026-11-04, MCP 로 생성):** 프로젝트 `rokid-route` / 서비스 `route-server` / `https://route-server-production.up.railway.app` (포트 8787, `PORT=8787` 변수로 고정)

Railway 화면 구성은 바뀔 수 있다. 아래 메뉴 이름은 작성 시점의 일반적인 이름이며 직접 눌러 확인한 것은 아니다.

## 1. 서비스 만들기
1. railway.com 로그인 → **New Project → Deploy from GitHub repo** → `ChoRockKim/rokid-glass-ios-navigation`
2. 서비스 **Settings**
   - **Source → Root Directory**: `/server`
   - **Branch**: `feat/route-server` (main 에 합친 뒤에는 `main`)
   - `server/Dockerfile` 로 빌드. 헬스 체크 `/healthz`, 재시작 ON_FAILURE(5회)는 서비스 설정에 직접 넣었다 (`railway.json` 방식은 Railway 가 deprecated 로 거부해서 쓰지 않음).
   - **Replicas 는 1** 로. 진행 중 경로가 메모리에만 있다.
3. **Networking → Generate Domain** → `https://<이름>.up.railway.app` 가 생긴다. 포트는 Railway 가 `PORT` 로 넣어 준다.

## 2. 환경 변수 (Variables)
| 이름 | 값 |
|---|---|
| `KAKAO_REST_KEY` | 카카오 REST 키 (노출된 적 있으니 재발급 권장) |
| `SLACK_BOT_TOKEN` | `xoxb-…` |
| `SLACK_APP_TOKEN` | `xapp-…` |
| `GLASS_TOKEN` | 안경용. 새로 만들 것: `openssl rand -hex 16` |
| `API_TOKEN` | 폰(단축어·Overland)용. 새로 만들 것: `openssl rand -hex 16` |
| `SEOUL_SUBWAY_KEY` | (선택) 서울 열린데이터광장 |
| `DATA_GO_KR_KEY` | (선택) 공공데이터포털, Decoding 키 |
| `CLOVA_SPEECH_INVOKE_URL` | (선택) 안경 "말해서 찾기". 네이버 클라우드 CLOVA Speech 도메인 → 빌더 → Invoke URL |
| `CLOVA_SPEECH_SECRET` | (선택) 같은 곳의 Secret Key. 두 값이 다 있어야 켜진다 |

`HTTPS_PROXY` 는 넣지 않는다 (클라우드 세션 전용).

## 3. 주의: Slack 연결이 두 개면 안 된다
Socket Mode 는 같은 앱 토큰으로 연결이 여러 개면 이벤트를 나눠 보낸다. Railway 서버를 켜면 **개발용으로 띄운 서버(클라우드 세션 등)는 꺼야** `/route` 가 Railway 로만 간다.

## 4. 배포 후 확인
```bash
curl https://<도메인>/healthz
```
```bash
curl -X POST "https://<도메인>/route?token=<API_TOKEN>" -d '{"to":"선릉역","from":"강남역"}'
```
Railway 서비스 셸(또는 로컬)에서 실시간 API 확인:
```bash
npx tsx scripts/probe-realtime.ts 회기
```
(이미지에는 `scripts` 가 빠져 있다. 서비스 셸에서 돌리려면 `.dockerignore` 에서 `scripts` 를 빼고 다시 배포하거나, 로컬에서 실행.)

## 5. 폰·안경 연결
- 단축어: `docs/ios-shortcuts.md` 의 `SERVER` 에 `https://<도메인>`
- Overland: Receiver Endpoint 에 `https://<도메인>/location`, Access Token 에 `API_TOKEN`
- 안경: `wss://<도메인>/glass`, 헤더 `Authorization: Bearer <GLASS_TOKEN>` (또는 `?token=`)
