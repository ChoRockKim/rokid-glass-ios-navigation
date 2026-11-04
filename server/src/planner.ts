// 장소 이름 또는 좌표 → 카카오 도보 경로. Slack 과 HTTP API 가 같이 쓴다.
import { searchPlace, walkRoute, KakaoError, type Place, type WalkRoute } from "./kakao.js";

export type PlaceInput = string | { lon: number; lat: number; name?: string };

export async function resolvePlace(input: PlaceInput, key: string): Promise<Place> {
  if (typeof input !== "string") {
    return { name: input.name ?? "현재 위치", address: "", x: input.lon, y: input.lat };
  }
  const p = await searchPlace(input, key);
  if (!p) throw new KakaoError(`장소를 찾지 못했습니다: ${input}`);
  return p;
}

export async function planRoute(
  from: PlaceInput,
  to: PlaceInput,
  key: string,
): Promise<{ from: Place; to: Place; route: WalkRoute }> {
  const [f, t] = await Promise.all([resolvePlace(from, key), resolvePlace(to, key)]);
  const route = await walkRoute(f, t, key);
  return { from: f, to: t, route };
}
