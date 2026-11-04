// 실시간 도착 API 실제 응답 확인용 (키를 받은 뒤 1회 실행). 응답 원문 앞부분과 파싱 결과를 출력한다.
// SEOUL_SUBWAY_KEY=... DATA_GO_KR_KEY=... npx tsx scripts/probe-realtime.ts [역명=회기] [정류장명=외대역앞] [경도 위도]
import { fetch } from "undici";
import { dispatcher } from "../src/proxy.js";
import { subwayProvider, seoulBusProvider } from "../src/realtime.js";

const [station = "회기", stop = "외대역앞", lon = "127.0631", lat = "37.5966"] = process.argv.slice(2);
const show = async (label: string, url: string) => {
  try {
    const r = await fetch(url, { dispatcher, signal: AbortSignal.timeout(8000) });
    console.log(`\n## ${label} → HTTP ${r.status}\n${(await r.text()).slice(0, 1500)}`);
  } catch (e) {
    console.log(`\n## ${label} → 실패: ${e instanceof Error ? e.message : String(e)}`);
  }
};

if (process.env.SEOUL_SUBWAY_KEY) {
  const k = process.env.SEOUL_SUBWAY_KEY;
  await show("지하철 원문", `http://swopenapi.seoul.go.kr/api/subway/${encodeURIComponent(k)}/json/realtimeStationArrival/0/5/${encodeURIComponent(station)}`);
  const p = subwayProvider(k);
  console.log("파싱:", await p.fetch({ kind: "subway", lines: ["경의중앙선"], board: station, alight: "왕십리", stops: [station, "청량리", "왕십리"], boardPoint: null, live: null, liveAt: null }).catch((e) => String(e)));
} else console.log("SEOUL_SUBWAY_KEY 없음");

if (process.env.DATA_GO_KR_KEY) {
  const k = process.env.DATA_GO_KR_KEY;
  await show("버스 정류소(좌표) 원문", `http://ws.bus.go.kr/api/rest/stationinfo/getStationByPos?serviceKey=${k}&tmX=${lon}&tmY=${lat}&radius=150&resultType=json`);
  const p = seoulBusProvider(k);
  console.log("파싱:", await p.fetch({ kind: "bus", lines: ["273"], board: stop, alight: "회기시장", stops: [stop, "회기시장"], boardPoint: [Number(lon), Number(lat)], live: null, liveAt: null }).catch((e) => String(e)));
} else console.log("DATA_GO_KR_KEY 없음");
