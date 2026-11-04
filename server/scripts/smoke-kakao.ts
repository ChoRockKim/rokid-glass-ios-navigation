// 카카오 실 API 스모크 테스트: npx tsx scripts/smoke-kakao.ts [출발] [도착]
import { searchPlace, walkRoute } from "../src/kakao.js";

const key = process.env.KAKAO_REST_KEY;
if (!key) throw new Error("KAKAO_REST_KEY 없음");
const [fromQ = "서울역", toQ = "남대문시장"] = process.argv.slice(2);

const [a, b] = await Promise.all([searchPlace(fromQ, key), searchPlace(toQ, key)]);
if (!a || !b) throw new Error(`장소 못 찾음: ${!a ? fromQ : toQ}`);
console.log(`${a.name} (${a.address}) -> ${b.name} (${b.address})`);
const r = await walkRoute(a, b, key);
console.log(`${r.totalDistance}m, ${r.totalTime}s, ${r.steps.length} steps`);
r.steps.forEach((s, i) => console.log(`${i + 1}. ${s.guidance} [${s.distance}m]`));
console.log("없는 장소 검색:", await searchPlace("ㅁㄴㅇㄹ없는장소ㅁㄴㅇㄹ", key));
