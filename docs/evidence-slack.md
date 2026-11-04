# Slack 공식 문서 근거 검증

검증일: 2026-11-04

## 방법과 한계

- api.slack.com 의 개발자 문서는 모두 docs.slack.dev 로 302 리디렉션된다. 즉 docs.slack.dev 는 Slack 공식 문서의 새 주소다. 아래 출처는 이 새 주소를 쓴다. 옛 api.slack.com 주소도 병기한다.
- 페이지는 WebFetch(요약 모델 경유)로 읽었다. 그래서 인용문은 페이지 원문 그대로가 아니라 요약 과정을 거친 것일 수 있다. 따옴표 안의 영어는 도구가 "verbatim"이라고 돌려준 문장이다. 중요한 수치는 최종 사용 전에 원 페이지에서 한 번 더 눈으로 확인하는 것을 권한다.
- 네트워크 오류로 실패한 항목은 없다. 다만 일부 URL이 404 라서 검색으로 올바른 주소를 찾아 다시 읽었다.
- 판정: 확인 / 부분확인 / 반증 / 미확인. "(추측)" 표시는 문서에서 직접 확인하지 못한 내용이다.

---

## 1) Socket Mode

판정: **확인** (토큰 scope 이름은 부분확인)

- 출처: https://docs.slack.dev/apis/events-api/using-socket-mode (옛 주소 https://api.slack.com/apis/socket-mode)
- 공개 URL 불필요. Events API 와 상호작용을 "without exposing a public HTTP Request URL" 로 쓸 수 있다. 앱이 런타임에 WebSocket URL 을 열어 연결한다.
- 슬래시 커맨드, 이벤트, 버튼, 모달 등을 지원한다. 문서의 슬래시 커맨드 예시 페이로드에 `"type": "slash_commands"` 와 `envelope_id` 가 들어 있다.
- 토큰: app-level token(`xapp-` 로 시작). 인용: "Your app-level token allows your app ... to generate a WebSocket URL for communication with Slack via the apps.connections.open method."
  - 필요 scope 가 `connections:write` 라는 점은 이번에 읽은 요약본에는 나오지 않았다. 이 scope 이름은 내 기존 지식이다(추측). 확인하려면 https://docs.slack.dev/reference/methods/apps.connections.open 를 보면 된다.
- 제약:
  - 동시 연결 최대 10개. 인용: "up to 10 open WebSocket connections at the same time."
  - 공개 Slack Marketplace 등록 불가. 인용: "Apps using Socket Mode are not currently allowed in the public Slack Marketplace."
  - 연결은 몇 시간마다 갱신되므로 새 WebSocket URL 처리가 필요하다. 끊기기 약 10초 전에 경고 메시지가 오고, `refresh_requested` 메시지도 온다. 테스트용으로 `&debug_reconnects=true` 를 붙이면 약 360초마다 끊긴다.
  - 각 이벤트를 반드시 ack 해야 한다. 인용: "Your app still needs to acknowledge receiving each event so that Slack knows whether to retry."

## 2) 슬래시 커맨드와 Socket Mode, 3초 ack 제한

판정: **확인** (Socket Mode 에서 동작은 1번 문서로 확인, 3초는 슬래시 커맨드 문서로 확인)

- Socket Mode 에서 슬래시 커맨드가 동작한다는 근거는 위 1번 문서다. 슬래시 커맨드 문서 자체에는 Socket Mode 언급이 없었다.
- 출처(3초): https://docs.slack.dev/interactivity/implementing-slash-commands (옛 주소 https://api.slack.com/interactivity/slash-commands)
- 인용: "This confirmation must be received by Slack within 3000 milliseconds of the original request being sent, otherwise an `operation_timeout` error will be displayed to the user."
- Events API(HTTP) 쪽도 비슷하다. 출처 https://docs.slack.dev/apis/events-api/ 인용: "Your app should respond to the event request with an HTTP 2xx within three seconds." 실패하면 재시도 3회(거의 즉시, 1분 후, 5분 후).
- Socket Mode 에서 ack 의 구체적 시간 제한 수치는 Socket Mode 문서 요약에 없었다. 슬래시 커맨드 3초를 그대로 적용한다고 보는 것은 추측이다.
- `response_url` 을 "30분 안에 5회" 쓸 수 있다는 내 기억은 이번 페이지에서 확인되지 않았다. 해당 항목은 미확인이다.

## 3) 레이트 리밋

판정: **부분확인** (Tier 수치와 채널당 1건/초, Events 30,000/시간은 확인. 워크스페이스 전체 chat.postMessage 한도는 미확인)

- 출처: https://docs.slack.dev/apis/web-api/rate-limits (옛 주소 https://api.slack.com/docs/rate-limits)
- Tier(메서드별, 워크스페이스별, 분당):

  | Tier | 문서 설명 | 대략 수치 |
  |---|---|---|
  | 1 | "Access tier 1 methods infrequently." | 분당 약 1회 + 소량 버스트 |
  | 2 | "Most methods allow at least 20 requests per minute." | 20회 이상 |
  | 3 | "Tier 3 methods allow a larger number of requests." | 50회 이상 |
  | 4 | "Enjoy a large request quota for Tier 4 methods." | 100회 이상 |

  Tier 3 의 50+, Tier 4 의 100+ 는 문서 문장이 아니라 요약 모델이 정리한 수치다. 부분확인으로 본다.
- chat.postMessage 는 Tier 가 아니라 Special tier 다. 출처 https://docs.slack.dev/reference/methods/chat.postMessage
  - 인용: "Special rate limits apply."
  - 인용: "It will generally allow an app to post 1 message per second to a specific channel."
  - 워크스페이스 전체 한도는 요약에 "few hundred per minute" 정도로만 나왔다. 정확한 수치는 확인하지 못했다(미확인).
- Events API: 인용: "Event deliveries currently max out at 30,000 per workspace/team per app per 60 minutes." 초과하면 `app_rate_limited` 이벤트가 매분 온다.
- 메시지 길이(참고): `text` 는 4,000자 권장, 40,000자 초과 시 잘림(`message_truncated`), `markdown_text` 는 12,000자 상한이라고 요약됐다.
- 기억하던 "2025년 비 Marketplace 앱의 conversations.history 제한 강화"는 이번 페이지에서 확인되지 않았다(미확인). 별도 changelog 를 봐야 한다.

## 4) Slack 의 실시간 위치 공유 기능

판정: **미확인** (실시간 위치 공유가 없다는 직접 근거는 찾지 못함. 있다는 근거도 못 찾음)

- 시도한 것:
  - slack.com 도메인 검색(share location, mobile 등)에서 위치 공유 도움말 문서가 하나도 나오지 않았다. 나온 것은 상태, 가용성, 메시지 공유, 파일 첨부, 프로필 문서뿐이다.
  - 모바일 권한 문서는 주소(404) 오류로 읽지 못했다.
- 따라서 "Slack 에는 네이티브 실시간 위치 공유가 없다"는 것은 **추측**이다. 공식 문서에 부재 근거(명시적 "없다" 문장)는 없다. 부재는 문서로 증명하기 어렵다.
- 비공식 참고: 제3자 앱(Re:loc 등)이 위치를 이모지/지명으로 알리는 방식으로 쓰인다. 이는 공식 문서가 아니므로 근거로 쓰지 않는다.
- 부재를 확인하는 방법(권장):
  1. iOS/Android Slack 앱의 메시지 입력창 "+" 첨부 메뉴에 위치 항목이 있는지 직접 확인한다. 이것이 가장 확실하다.
  2. 모바일 릴리스 노트(https://slack.com/release-notes/ios , https://slack.com/release-notes/android)에서 "location" 을 검색한다.
  3. Slack 도움말 센터 검색창에 "share location" 을 넣어 결과가 없는지 본다.
  4. 개발자 쪽에서는 Block Kit 에 위치 요소가 없다는 점을 https://docs.slack.dev/reference/block-kit 에서 본다.
- 설계 시 대안(추측): 위치는 Rokid 앱이 좌표를 텍스트/지도 링크(Google Maps URL 등) 또는 이미지로 만들어 chat.postMessage 나 파일 업로드로 보내는 방식이 현실적이다.

## 5) 파일/이미지 업로드 API, 비공개 채널 가시성

### 5-1) 업로드 API

판정: **확인** (파일 크기 상한은 부분확인)

- `files.upload` 는 폐기됐다. 출처 https://docs.slack.dev/changelog/2024-04-a-better-way-to-upload-files-is-here-to-stay/ (옛 주소 https://api.slack.com/changelog/2024-04-a-better-way-to-upload-files-is-here-to-stay)
  - 문서에 날짜가 수정된 흔적이 있다. 인용: "is being sunset on March 11, 2025 November 12, 2025". 최신 날짜는 2025-11-12 로 보인다. 오늘(2026-11-04)은 이미 지난 시점이다.
  - 신규 앱은 2024-05-16 부터 `files.upload` 를 못 쓴다(검색 결과 요약).
- 대체: `files.getUploadURLExternal` + 업로드 + `files.completeUploadExternal` 의 2단계. 인용: "leverage a combination of two APIs". SDK 는 이 흐름을 감싼 `filesUploadV2`(Node), `files_upload_v2`(Python)를 제공한다(검색 결과 요약).
- 출처 https://docs.slack.dev/reference/methods/files.getUploadURLExternal
  - Rate limit: "Tier 4: 100+ per minute". scope: bot/user 토큰 모두 `files:write`.
  - 인용: 완료 호출이 없으면 "the upload will be aborted".
  - `length` 는 "Size in bytes of the file being uploaded."
  - 스니펫은 1MB 상한(`snippet_too_large`). 워크스페이스가 큰 업로드를 제한하면 `file_upload_size_restricted` 오류.
- 일반 파일 크기: Slack 도움말(https://slack.com/help/articles/201330736-Add-files-to-Slack) 검색 요약은 "Members and guests can add files up to 1GB" 라고 한다. 이번에 이 페이지 본문을 직접 읽지는 않았으므로 부분확인이다. API 문서에는 일반 상한 수치가 없었다.
- 참고: Block Kit file input 요소는 100MB 상한(검색 요약).

### 5-2) 비공개 채널을 관리자/Owner 가 볼 수 있는가

판정: **부분확인**

- 출처: https://slack.com/help/articles/201658943-Export-your-workspace-data
- Free/Pro: 인용: "Workspace Owners and Admins can export messages and file links from public channels in JSON format." 비공개 채널과 DM 은 일반 내보내기에 없다. 다만 Owner 가 Slack 에 신청해서 제한된 상황에서만 내보낼 수 있다(검색 요약: 유효한 법적 절차, 구성원 동의, 법적 요구/권리를 입증해야 한다).
- Business+: 인용: "Workspace Owners can apply to access a self-serve data export tool" (공개/비공개 채널, DM 포함). 인용: "Applications require approval from the Workspace Primary Owner."
- Enterprise: 인용: "Org Owners can contact our Support team to request access to self-serve data export tools."
- 결론: 비공개 채널 메시지는 기본적으로 Owner/Admin 이 평소에 열람하는 권한이 아니다. 하지만 플랜에 따라 신청/승인 절차를 거쳐 내보낼 수 있다. 즉 "관리자가 볼 수 없다"고 단정하면 안 된다.
- 반대 정보: Slack 요금제 페이지는 Owner 가 모든 데이터를 내보낼 수 있다고 쓴다는 검색 요약이 있었다(신청 절차 언급 없음). 도움말 문서가 더 구체적이라 그쪽을 따른다. 요금제 페이지 본문은 직접 읽지 않았다.
- 채널 관리 도구 문서(https://slack.com/help/articles/360047512554-Use-channel-management-tools)에 관한 검색 요약: 비공개 채널의 메시지와 파일은 채널 관리 도구로 볼 수 없다(다른 수단으로는 볼 수 있음). 이 문서는 본문을 직접 읽지 않았다.

### 5-3) 데이터 보존 정책

판정: **부분확인**

- 출처(검색 요약): https://slack.com/help/articles/203457187-Customize-data-retention-in-Slack
- Workspace Owner 가 공개/비공개 채널의 메시지 보존 기간을 설정할 수 있다. 기본값은 조직 정책이 변경을 막는 경우가 있다. 유료 구독에서는 구성원이 자기 비공개 채널과 DM 의 보존 기간을 직접 정하게 허용할 수도 있다. 선택지는 영구 보관, 수정/삭제 기록 미추적, 90일 후 삭제, 사용자 지정 등이다. 파일은 1년~영구 등이다.
- 이 페이지는 본문을 직접 읽지 않고 검색 요약만 확인했다.

### 5-4) Discovery API

판정: **부분확인**

- 출처: https://slack.com/help/articles/204897248-Guide-to-Slack-import-and-export-tools
- 인용: Discovery API 는 "to export, archive, or meet other security and compliance obligations for any organization content" 용이며 Enterprise 플랜 대상이다.
- 인용: "At the organization level, the Discovery API export mechanism is available to Org Owners".
- 인용: "export content from all channels and conversations, including private channels, direct messages".
- 파트너 도구 승인이 필요하고 Enterprise Grid 전용이다. 이 승인 요건은 이번 페이지 요약에 명확히 나오지 않아 미확인이다. Discovery API 레퍼런스 주소(docs.slack.dev/admins/discovery-api)는 404 였다.
- Slack Connect 공유 채널은 자기 조직 구성원이 보낸 것만 편집/삭제할 수 있다(검색 요약).

## 6) 무료 플랜 메시지 보관 제한

판정: **확인** (90일 열람 제한), **부분확인** (1년 후 영구 삭제, 5GB)

- 출처: https://slack.com/intl/en-ca/help/articles/115002422943-Message-file-and-app-limits-on-the-free-version-of-Slack
- 인용: "You can view and search messages and files from the last 90 days."
- 인용: "Slack will start hiding messages and files older than 90 days to make room for new ones." (삭제가 아니라 숨김)
- 요약 모델은 "1년이 지나면 영구 삭제"라고 덧붙였는데 이 문장은 인용으로 받지 못했다. 한편 내보내기 문서 검색 요약에는 "Data more than a year old will not be included on the Free plan" 이 있다. 1년 영구 삭제는 부분확인이다.
- 인용: "Upgrading to a paid plan will remove message, file, and app limits, plus provide more data retention options."
- 앱 수: "You can add up to 10 third-party or custom apps."
- 5GB 파일 저장: 직접 읽은 페이지에는 없었고, 검색 요약에만 5GB 라는 말이 있었다. 부분확인이다.

---

## 설계에 중요한 결론 (추측 포함 표시)

- 공개 URL 없는 Socket Mode 로 슬래시 커맨드와 이벤트를 받을 수 있다. 사내 비공개 사용이면 Marketplace 제한은 문제가 안 된다.
- 슬래시 커맨드는 3초 안에 ack 하고, 길게 걸리는 처리는 이후 응답으로 보내야 한다.
- 채널에 초당 1건 안팎으로 보내는 전제로 설계한다(메시지 묶음 처리 권장).
- 이미지는 `files.getUploadURLExternal` + `files.completeUploadExternal` 을 써야 한다. `files.upload` 는 끝났다.
- Free 플랜은 90일 지난 메시지가 숨겨지므로 장기 기록용 저장소로 쓰면 안 된다.
- 비공개 채널은 Owner/Admin 이 평소에는 못 보지만, 플랜별 신청/승인으로 열람/내보내기가 가능하다고 가정해야 한다.
- 실시간 위치 공유는 Slack 에 있다는 근거도 없다는 근거도 못 찾았다. 앱에서 직접 확인이 필요하다.
