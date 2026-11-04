import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Navigator, type SavedRoute } from "./navigation.js";
import { startGlassServer } from "./glass.js";
import { createApi } from "./api.js";
import { RoadFeed } from "./roads.js";
import { providersFromEnv, startRealtimePoller } from "./realtime.js";
import { startSlack } from "./slack.js";
import { Pairing } from "./pairing.js";
import { Ota } from "./ota.js";
import { Chooser } from "./chooser.js";

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
/** 안경 APK 에 빌드 때 넣는 전용 토큰 (선택). 새면 이것만 바꾸고 APK 를 다시 빌드한다 */
const GLASS_DEVICE_TOKEN = process.env.GLASS_DEVICE_TOKEN ?? "";
const PORT = Number(process.env.PORT ?? 8787);
/** 폰(단축어, Overland)용 API 토큰. 없으면 API 를 끈다 */
const API_TOKEN = process.env.API_TOKEN ?? "";
/** Slack 은 선택. 두 토큰이 다 있을 때만 켠다 */
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? "";
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN ?? "";

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);
const nav = new Navigator();
const chooser = new Chooser();

// 진행 중인 경로를 볼륨에 저장해 두고 재시작하면 이어서 안내한다 (배포·재시작 때 안내가 사라지던 문제)
const STATE_FILE = process.env.STATE_FILE ?? "/data/nav.json";
const STATE_MAX_AGE_MS = 12 * 3600_000;
try {
  if (existsSync(STATE_FILE)) {
    const saved = JSON.parse(readFileSync(STATE_FILE, "utf8")) as SavedRoute | null;
    if (saved?.v === 1 && Date.now() - saved.savedAt < STATE_MAX_AGE_MS) {
      nav.restore(saved);
      log(`restored route: ${saved.to.name} step ${saved.index + 1}/${saved.guide.length}`);
    }
  }
} catch (e) {
  log(`restore failed: ${e instanceof Error ? e.message : String(e)}`);
}
let saveWarned = false;
nav.onSave((s) => {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE + ".tmp", JSON.stringify(s));
    renameSync(STATE_FILE + ".tmp", STATE_FILE);
  } catch (e) {
    if (!saveWarned) log(`경로 저장 실패 (${STATE_FILE}): ${e instanceof Error ? e.message : String(e)}`);
    saveWarned = true;
  }
});

nav.onChange((m) => log(`nav -> ${m.type}${m.type === "step" ? ` ${m.index + 1}/${m.total}` : ""}`));

let slack: Awaited<ReturnType<typeof startSlack>> | null = null;

const api = API_TOKEN
  ? createApi({ nav, apiToken: API_TOKEN, kakaoKey: KAKAO_REST_KEY, log, notify: (t) => slack?.notify(t), pairing: new Pairing(GLASS_TOKEN), chooser })
  : undefined;
if (!api) log("API_TOKEN 이 없어 폰용 HTTP API(/location, /route, /nav, /status)를 끕니다");

const roads = new RoadFeed(nav, log);
/** 안경 APK 보관 폴더 (Railway 볼륨 /data). 업로드 토큰이 없으면 업로드만 막힌다 */
const ota = new Ota(process.env.APP_DIR ?? "/data/app", process.env.OTA_UPLOAD_TOKEN ?? "", [GLASS_TOKEN, GLASS_DEVICE_TOKEN].filter(Boolean), log);
const glass = startGlassServer({ port: PORT, token: GLASS_TOKEN, extraTokens: GLASS_DEVICE_TOKEN ? [GLASS_DEVICE_TOKEN] : [], nav, log, api, onPositions: api?.ingest, onReroute: api?.rerouteNow, roads, ota, chooser });
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
