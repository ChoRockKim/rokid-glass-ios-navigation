import bolt from "@slack/bolt";
import { searchPlace, walkRoute, KakaoError } from "./kakao.js";
import { Navigator, parseRouteArgs, formatDistance, formatMinutes, messageFor } from "./navigation.js";
import { startGlassServer } from "./glass.js";
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

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);
const nav = new Navigator();

const HELP = [
  "*사용법*",
  "`/route 강남역 > 선릉역` 경로 시작 (`->`, `→`, `강남역에서 선릉역` 도 됨)",
  "`/route next` · `/route prev` 다음/이전 단계",
  "`/route status` 현재 단계",
  "`/route stop` 안내 종료",
].join("\n");

function statusText(): string {
  const a = nav.current;
  const msg = messageFor(a);
  if (msg.type === "idle") return "진행 중인 경로가 없습니다.";
  if (msg.type === "arrived") return `:checkered_flag: ${msg.text}`;
  return `*${msg.index + 1}/${msg.total}* ${msg.text} (${formatDistance(msg.distance)}) → ${msg.destination}`;
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
  if (sub === "stop") {
    nav.stop();
    return ack({ response_type: "ephemeral", text: "안내를 종료했습니다." });
  }

  const args = parseRouteArgs(text);
  if (!args) {
    return ack({
      response_type: "ephemeral",
      text: "출발지와 도착지를 같이 적어 주세요. 예: `/route 강남역 > 선릉역`\n(iPhone 위치를 서버가 받지 않아 출발지가 필요합니다.)",
    });
  }

  await ack({ response_type: "ephemeral", text: `:mag: ${args.from} → ${args.to} 검색 중…` });

  try {
    const [from, to] = await Promise.all([searchPlace(args.from, KAKAO_REST_KEY), searchPlace(args.to, KAKAO_REST_KEY)]);
    if (!from || !to) {
      await respond({ response_type: "ephemeral", text: `장소를 찾지 못했습니다: ${!from ? args.from : args.to}` });
      return;
    }
    const route = await walkRoute(from, to, KAKAO_REST_KEY);
    nav.start({ from, to, route, index: 0, startedBy: command.user_id });

    const lines = route.steps.map((s, i) => `${i + 1}. ${s.guidance}`);
    await respond({
      response_type: "ephemeral",
      text: [
        `:walking: *${from.name} → ${to.name}* · ${formatDistance(route.totalDistance)} · 약 ${formatMinutes(route.totalTime)} · ${route.steps.length}단계`,
        ...lines,
        route.landingUrl ? `<${route.landingUrl}|카카오맵에서 보기>` : "",
        "_안경에 1단계를 보냈습니다. 탭 또는 `/route next` 로 다음 단계._",
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

const glass = startGlassServer({ port: PORT, token: GLASS_TOKEN, nav, log });
await app.start();
log("slack socket mode connected");

const shutdown = async () => {
  log("shutting down");
  glass.close();
  await app.stop().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
