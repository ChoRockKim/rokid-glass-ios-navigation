// 안경 마이크로 말한 목적지 → 글자 (CLOVA Speech) → 즐겨찾기·최근 목적지와 맞춰 보기.
// CLOVA Speech 요청 형식은 네이버 클라우드 문서(장문 인식 API, 로컬 파일 /recognizer/upload, completion=sync, boostings)를 보고 쓴 것.
// 실제 호출은 아직 해 보지 못함 (키 필요) → 실서버 로그로 확인.
import { Blob } from "node:buffer";
import { fetch, FormData } from "undici";
import { dispatcher } from "./proxy.js";

export type Transcriber = (audio: Buffer, hints: string[]) => Promise<string>;

export class SttError extends Error {}

/** 한 번에 받는 음성 크기 상한 (16kHz mono 16bit WAV 기준 약 30초) */
export const VOICE_MAX_BYTES = 1_000_000;

/**
 * CLOVA Speech 장문 인식(동기). invokeUrl 은 콘솔의 도메인 → 빌더 → Invoke URL, secret 은 같은 곳의 Secret Key.
 * hints 는 boostings 로 넘겨 고유명사(즐겨찾기 별명, 최근 목적지) 인식을 돕는다.
 */
export function clovaSpeech(invokeUrl: string, secret: string): Transcriber {
  const base = invokeUrl.replace(/\/+$/, "");
  return async (audio, hints) => {
    const words = [...new Set(hints.map((h) => h.replace(/,/g, " ").trim()).filter(Boolean))].slice(0, 200);
    const params = {
      language: "ko-KR",
      completion: "sync",
      wordAlignment: false,
      fullText: true,
      ...(words.length ? { boostings: [{ words: words.join(",") }] } : {}),
    };
    const form = new FormData();
    form.append("media", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), "voice.wav");
    form.append("params", JSON.stringify(params));
    const res = await fetch(`${base}/recognizer/upload`, {
      method: "POST",
      headers: { "X-CLOVASPEECH-API-KEY": secret },
      body: form,
      signal: AbortSignal.timeout(15_000),
      dispatcher,
    });
    const body = (await res.json().catch(() => null)) as { result?: string; message?: string; text?: string } | null;
    if (!res.ok || !body || (body.result && body.result !== "COMPLETED")) {
      throw new SttError(`음성 인식 실패 (${res.status}${body?.message ? ` ${body.message}` : ""})`);
    }
    return (body.text ?? "").trim();
  };
}

/** 말 끝의 "으로 가자", "까지", "가 줘" 같은 말과 공백·문장부호를 뗀다 */
export function cleanSpoken(text: string): string {
  let t = text.replace(/[.,!?~"'·]/g, " ").replace(/\s+/g, " ").trim();
  const tails = [/\s*(으로|로|에|까지|쪽으로)?\s*(가자|가 ?줘|가 ?주세요|가고 ?싶어|갈래|안내해 ?줘|안내 ?해 ?주세요|길 ?찾아 ?줘|찾아 ?줘)$/, /\s*(으로|까지)$/];
  for (const r of tails) t = t.replace(r, "").trim();
  return t;
}

const norm = (s: string) => s.replace(/[\s.,!?·()\-]/g, "").toLowerCase();

/** 편집 거리 (짧은 문자열용) */
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length]![b.length]!;
}

/** 말한 것과 저장된 이름이 얼마나 닮았는지 0~1. 같으면 1, 한쪽이 다른 쪽을 품으면 0.9, 아니면 글자 차이 비율 */
export function similarity(spoken: string, name: string): number {
  const a = norm(spoken);
  const b = norm(name);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (b.length >= 2 && (a.includes(b) || b.includes(a))) return 0.9;
  return 1 - editDistance(a, b) / Math.max(a.length, b.length);
}

/** 저장된 장소 중 말한 것과 닮은 것 (0.7 이상, 닮은 순, 최대 max 개) */
export function matchSaved<T extends { name: string }>(spoken: string, saved: T[], max = 3): T[] {
  return saved
    .map((p) => ({ p, s: similarity(spoken, p.name) }))
    .filter((x) => x.s >= 0.7)
    .sort((x, y) => y.s - x.s)
    .slice(0, max)
    .map((x) => x.p);
}
