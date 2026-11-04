import { Navigator } from "./navigation.js";
import { startGlassServer } from "./glass.js";
import { createApi } from "./api.js";
import { RoadFeed } from "./roads.js";
import { providersFromEnv, startRealtimePoller } from "./realtime.js";
import { startSlack } from "./slack.js";
import { Pairing } from "./pairing.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`환경 변수 ${name} 가 없습니다.`);
    process.exit(1);
  }
  return v;
}

const KAKAO_REST_KEY = requireEnv("KAKAO_REST_KEY");
const GLASS_TOKEN = requireEnv("GLASS_TOKEN");
const PORT = Number(process.env.PORT ?? 8787);
/** 폰(단축어, Overland)용 API 토큰. 없으면 API 를 끈다 */
const API_TOKEN = process.env.API_TOKEN ?? "";
/** Slack 은 선택. 두 토큰이 다 있을 때만 켠다 */
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? "";
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN ?? "";

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);
const nav = new Navigator();

nav.onChange((m) => log(`nav -> ${m.type}${m.type === "step" ? ` ${m.index + 1}/${m.total}` : ""}`));

let slack: Awaited<ReturnType<typeof startSlack>> | null = null;

const api = API_TOKEN
  ? createApi({ nav, apiToken: API_TOKEN, kakaoKey: KAKAO_REST_KEY, log, notify: (t) => slack?.notify(t), pairing: new Pairing(GLASS_TOKEN) })
  : undefined;
if (!api) log("API_TOKEN 이 없어 폰용 HTTP API(/location, /route, /nav, /status)를 끕니다");

const roads = new RoadFeed(nav, log);
const glass = startGlassServer({ port: PORT, token: GLASS_TOKEN, nav, log, api, onPositions: api?.ingest, roads });
const stopPoller = startRealtimePoller(nav, providersFromEnv(log), log);

if (SLACK_BOT_TOKEN && SLACK_APP_TOKEN) {
  slack = await startSlack({ botToken: SLACK_BOT_TOKEN, appToken: SLACK_APP_TOKEN, nav, kakaoKey: KAKAO_REST_KEY, log, notifyUser: process.env.SLACK_NOTIFY_USER });
} else {
  log("Slack 토큰이 없어 Slack 을 끕니다 (단축어·HTTP API 로 사용)");
}

const shutdown = async () => {
  log("shutting down");
  stopPoller();
  glass.close();
  await slack?.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
