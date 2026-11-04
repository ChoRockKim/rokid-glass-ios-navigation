import bolt from "@slack/bolt";
import { KakaoError } from "./kakao.js";
import { Navigator, parseRouteArgs, formatDistance, formatMinutes, messageFor } from "./navigation.js";
import { startGlassServer } from "./glass.js";
import { createApi } from "./api.js";
import { planRoute, type PlaceInput } from "./planner.js";
import { pendingTransit, planTransit, selectTransit, summarizeOption } from "./transit.js";
import { providersFromEnv, startRealtimePoller } from "./realtime.js";
import { dispatcher, proxiedFetch } from "./proxy.js";

const { App, LogLevel, SocketModeReceiver } = bolt;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`환경 변수 ${name} 가 없습니다.`);
    process.exit(1);
  }
  return v;
}

const KAKAO_REST_KEY = requireEnv("KAKAO_REST_KEY");
const SLACK_BOT_TOKEN = requireEnv("SLACK_BOT_TOKEN");
const SLACK_APP_TOKEN = requireEnv("SLACK_APP_TOKEN");
const GLASS_TOKEN = requireEnv("GLASS_TOKEN");
const PORT = Number(process.env.PORT ?? 8787);
/** 폰(단축어, Overland)용 API 토큰. 없으면 API 를 끈다 */
const API_TOKEN = process.env.API_TOKEN ?? "";
/** 알림 받을 Slack 사용자 ID. 없으면 마지막으로 /route 를 쓴 사람 */
let slackNotifyUser = process.env.SLACK_NOTIFY_USER ?? "";

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);
const nav = new Navigator();

const HELP = [
  "*사용법*",
  "`/route 강남역 > 선릉역` 경로 시작 (`->`, `→`, `강남역에서 선릉역` 도 됨)",
  "`/route 선릉역` 폰에서 받은 현재 위치에서 출발",
  "`/route next` · `/route prev` 다음/이전 단계",
  "`/route status` 현재 단계",
  "`/route detail` 카카오 원본 단계 전체",
  "`/route stop` 안내 종료",
  "`/route 대중교통 강남역 > 선릉역` (또는 `/route 대중교통 선릉역`) 버스·지하철 후보 → `/route pick 2` 로 선택",
].join("\n");

function statusText(): string {
  const a = nav.current;
  const msg = messageFor(a);
  if (msg.type === "idle") return "진행 중인 경로가 없습니다.";
  if (msg.type === "arrived") return `:checkered_flag: ${msg.text}`;
  return `*${msg.index + 1}/${msg.total}* ${msg.line1}\n${msg.line2}  _→ ${msg.destination}_`;
}

function detailText(): string {
  const a = nav.current;
  if (!a) return "진행 중인 경로가 없습니다.";
  return [
    a.mode === "transit" ? `*대중교통 ${a.guide.length}단계*` : `*카카오 원본 ${a.route.steps.length}단계* (안경에는 ${a.guide.length}단계로 합쳐서 표시)`,
    ...a.guide.flatMap((g, i) => [`*${i + 1}.* ${g.line1} · ${g.line2}`, ...g.raw.map((r) => `      ◦ ${r}`)]),
  ].join("\n");
}

const receiver = new SocketModeReceiver({ appToken: SLACK_APP_TOKEN, dispatcher, logLevel: LogLevel.INFO });
for (const ev of ["connected", "disconnected", "reconnecting"] as const) {
  receiver.client.on(ev, () => log(`slack socket ${ev}`));
}

const app = new App({
  token: SLACK_BOT_TOKEN,
  receiver,
  logLevel: LogLevel.INFO,
  ...(proxiedFetch ? { clientOptions: { fetch: proxiedFetch } } : {}),
});

app.command("/route", async ({ command, ack, respond }) => {
  const text = command.text.trim();
  log(`/route from ${command.user_id}: ${text}`);

  // 슬래시 커맨드는 3초 안에 ack 해야 한다. 짧은 명령은 ack 로 바로 답한다.
  const sub = text.toLowerCase();
  if (sub === "" || sub === "help") return ack({ response_type: "ephemeral", text: HELP });
  if (sub === "next" || sub === "prev") {
    nav.move(sub === "next" ? 1 : -1);
    return ack({ response_type: "ephemeral", text: statusText() });
  }
  if (sub === "status") return ack({ response_type: "ephemeral", text: statusText() });
  if (sub === "detail") return ack({ response_type: "ephemeral", text: detailText() });
  if (sub === "stop") {
    nav.stop();
    return ack({ response_type: "ephemeral", text: "안내를 종료했습니다." });
  }

  // ── 대중교통: 후보 조회 / 선택 ──
  const pick = text.match(/^(?:pick|선택)\s*(\d+)$/i);
  if (pick) {
    await ack({ response_type: "ephemeral", text: `:hourglass: ${pick[1]}번 경로 준비 중…` });
    try {
      const { plan, option, guide, route } = await selectTransit(Number(pick[1]) - 1, KAKAO_REST_KEY);
      nav.start({ from: plan.from, to: plan.to, route, guide, mode: "transit", startedBy: command.user_id });
      await respond({
        response_type: "ephemeral",
        text: [`:bus: *${summarizeOption(option, Number(pick[1]) - 1)}*`, ...guide.map((g, i) => `*${i + 1}.* ${g.line1}\n      ${g.line2}`), "_안경에 1단계를 보냈습니다._"].join("\n"),
      });
    } catch (e) {
      await respond({ response_type: "ephemeral", text: `:warning: ${e instanceof Error ? e.message : String(e)}` });
    }
    return;
  }
  const transitQuery = text.match(/^(?:대중교통|버스|지하철|transit)\s+(.+)$/i);
  if (transitQuery) {
    const targs = parseRouteArgs(transitQuery[1]!);
    const lastPos = nav.lastKnownPosition;
    const tFrom: PlaceInput | null = targs ? targs.from : lastPos ? { lon: lastPos.lon, lat: lastPos.lat } : null;
    const tTo = targs ? targs.to : transitQuery[1]!;
    if (!tFrom) return ack({ response_type: "ephemeral", text: "출발지도 적어 주세요. 예: `/route 대중교통 외대앞역 > 왕십리역`" });
    slackNotifyUser = command.user_id;
    await ack({ response_type: "ephemeral", text: `:mag: 대중교통 후보 검색 중…` });
    try {
      const plan = await planTransit(tFrom, tTo, KAKAO_REST_KEY);
      pendingTransit.set(plan);
      await respond({
        response_type: "ephemeral",
        text: [
          `:busstop: *${plan.from.name} → ${plan.to.name}* 대중교통 후보`,
          ...plan.options.map(summarizeOption),
          plan.landingUrl ? `<${plan.landingUrl}|카카오맵에서 보기>` : "",
          "_`/route pick 번호` 로 선택_",
        ].filter(Boolean).join("\n"),
      });
    } catch (e) {
      await respond({ response_type: "ephemeral", text: `:warning: ${e instanceof Error ? e.message : String(e)}` });
    }
    return;
  }

  // 출발지가 없으면 폰에서 받은 마지막 위치를 쓴다
  const args = parseRouteArgs(text);
  const last = nav.lastKnownPosition;
  const fromInput: PlaceInput | null = args ? args.from : last ? { lon: last.lon, lat: last.lat } : null;
  const toInput = args ? args.to : text;
  if (!fromInput) {
    return ack({
      response_type: "ephemeral",
      text: "출발지와 도착지를 같이 적어 주세요. 예: `/route 강남역 > 선릉역`\n(폰 위치를 아직 받지 못해서 출발지가 필요합니다.)",
    });
  }

  slackNotifyUser = command.user_id;
  await ack({
    response_type: "ephemeral",
    text: `:mag: ${typeof fromInput === "string" ? fromInput : "현재 위치"} → ${toInput} 검색 중…`,
  });

  try {
    const { from, to, route } = await planRoute(fromInput, toInput, KAKAO_REST_KEY);
    nav.start({ from, to, route, startedBy: command.user_id });
    const guide = nav.current!.guide;

    const lines = guide.map((g, i) => `*${i + 1}.* ${g.line1}\n      ${g.line2}`);
    await respond({
      response_type: "ephemeral",
      text: [
        `:walking: *${from.name} → ${to.name}* · ${formatDistance(route.totalDistance)} · 약 ${formatMinutes(route.totalTime)} · ${guide.length}단계 (원본 ${route.steps.length})`,
        ...lines,
        route.landingUrl ? `<${route.landingUrl}|카카오맵에서 보기>` : "",
        "_안경에 1단계를 보냈습니다. 탭 또는 `/route next` 로 다음 단계. 원문은 `/route detail`._",
      ]
        .filter(Boolean)
        .join("\n"),
    });
  } catch (e) {
    const msg = e instanceof KakaoError ? e.message : "경로 조회 중 오류가 났습니다.";
    log(`route error: ${e instanceof Error ? e.message : String(e)}`);
    await respond({ response_type: "ephemeral", text: `:warning: ${msg}` });
  }
});

nav.onChange((m) => log(`nav -> ${m.type}${m.type === "step" ? ` ${m.index + 1}/${m.total}` : ""}`));

// 단축어·Overland 에서 시작/재탐색한 경로를 Slack DM 으로도 알린다 (봇에 chat:write 필요. 실패해도 무시)
async function notifySlack(text: string) {
  if (!slackNotifyUser) return;
  try {
    await app.client.chat.postMessage({ channel: slackNotifyUser, text });
  } catch (e) {
    log(`slack notify failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const api = API_TOKEN
  ? createApi({ nav, apiToken: API_TOKEN, kakaoKey: KAKAO_REST_KEY, log, notify: (t) => void notifySlack(t) })
  : undefined;
if (!api) log("API_TOKEN 이 없어 폰용 HTTP API(/location, /route, /nav, /status)를 끕니다");

const glass = startGlassServer({ port: PORT, token: GLASS_TOKEN, nav, log, api, onPositions: api?.ingest });
const stopPoller = startRealtimePoller(nav, providersFromEnv(log), log);
await app.start();
log("slack socket mode connected");

const shutdown = async () => {
  log("shutting down");
  stopPoller();
  glass.close();
  await app.stop().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
