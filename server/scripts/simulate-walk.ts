// 실제 카카오 경로를 따라 걷는 위치를 Overland 형식으로 서버에 보낸다 (로컬 검증용)
// API_TOKEN=... npx tsx scripts/simulate-walk.ts <lat> <lon> <목적지> [간격m=20] [이탈 지점 m]
import { planRoute } from "../src/planner.js";
import { buildGuide, distanceM } from "../src/guide.js";
import type { LonLat } from "../src/kakao.js";

const [lat, lon, to, stepArg = "20", detourArg] = process.argv.slice(2);
const base = process.env.SERVER ?? "http://localhost:8787";
const H = { Authorization: `Bearer ${process.env.API_TOKEN}`, "content-type": "application/json" };
const { route } = await planRoute({ lat: Number(lat), lon: Number(lon) }, to!, process.env.KAKAO_REST_KEY!);
const pts: LonLat[] = buildGuide(route.steps).flatMap((g) => g.points);

// 경로를 일정 간격으로 샘플
const every = Number(stepArg);
const samples: LonLat[] = [pts[0]!];
let acc = 0;
for (let i = 1; i < pts.length; i++) {
  acc += distanceM(pts[i - 1]!, pts[i]!);
  if (acc >= every) { samples.push(pts[i]!); acc = 0; }
}
// 서버는 이전보다 오래된 시각의 위치를 버린다. 반복 실행해도 시각이 앞으로 가도록 TS_BASE 로 조정
let ts = Number(process.env.TS_BASE ?? Date.now());
const post = async (p: LonLat, label = "") => {
  ts += 15_000;
  const body = { locations: [{ type: "Feature", geometry: { type: "Point", coordinates: p }, properties: { timestamp: new Date(ts).toISOString(), horizontal_accuracy: 6 } }] };
  const r = (await (await fetch(`${base}/location`, { method: "POST", headers: H, body: JSON.stringify(body) })).json()) as any;
  return r;
};
const detourAt = detourArg ? Number(detourArg) : -1;
let walked = 0;
for (let i = 0; i < samples.length; i++) {
  if (i) walked += distanceM(samples[i - 1]!, samples[i]!);
  if (detourAt >= 0 && walked >= detourAt) {
    const d = samples[i]!;
    for (let k = 1; k <= 4; k++) { // 동쪽으로 60m, 100m … 벗어남
      const r = await post([d[0] + (20 + 40 * k) / 88_300, d[1]], "detour");
      console.log(`detour ${k}: off=${r.offset?.toFixed(0)}m offRoute=${r.offRoute} count=${r.offRouteCount}`);
      await new Promise((res) => setTimeout(res, 1500));
    }
    console.log("detour done; status:", JSON.stringify(((await (await fetch(`${base}/status`, { headers: H })).json()) as any).message));
    break;
  }
  const r = await post(samples[i]!);
  if (i % 10 === 0) console.log(`${walked.toFixed(0)}m: step ${(r.index ?? 0) + 1} off=${r.offset?.toFixed(0)}m`);
}
const st = (await (await fetch(`${base}/status`, { headers: H })).json()) as any;
console.log("final:", JSON.stringify(st.message));
