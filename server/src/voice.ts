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

/**
 * Whisper (OpenAI 호환 /audio/transcriptions). 기본은 Groq (무료 사용량 있음, 키 필요).
 * hints 는 prompt 로 넘긴다 (Whisper 는 앞 문맥처럼 받아 고유명사 표기를 맞추는 데 쓴다, 길이 제한이 있어 앞쪽 일부만).
 * 요청 형식은 Groq·OpenAI 공개 문서 기준, 실호출은 키를 넣은 뒤 실서버 로그로 확인
 */
export function whisperApi(key: string, base = "https://api.groq.com/openai/v1", model = "whisper-large-v3"): Transcriber {
  const url = `${base.replace(/\/+$/, "")}/audio/transcriptions`;
  return async (audio, hints) => {
    const names = [...new Set(hints.map((h) => h.trim()).filter(Boolean))];
    let prompt = "";
    for (const n of names) {
      if ((prompt + n).length > 180) break;
      prompt += (prompt ? ", " : "목적지: ") + n;
    }
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), "voice.wav");
    form.append("model", model);
    form.append("language", "ko");
    form.append("response_format", "json");
    form.append("temperature", "0");
    if (prompt) form.append("prompt", prompt);
    const res = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(15_000), dispatcher });
    const body = (await res.json().catch(() => null)) as { text?: string; error?: { message?: string } } | null;
    if (!res.ok || !body) {
      const why = res.status === 401 ? "키 확인 필요" : res.status === 429 ? "사용량 초과, 잠시 뒤 다시" : `${res.status}`;
      throw new SttError(`음성 인식 실패 (${why}${body?.error?.message ? ` · ${body.error.message.slice(0, 80)}` : ""})`);
    }
    return dropHallucination((body.text ?? "").trim());
  };
}

/**
 * Whisper 는 조용하거나 잡음만 있으면 학습 데이터에 흔한 문장을 지어낸다 (한국어: "시청해 주셔서 감사합니다" 등).
 * 그런 문장이면 못 알아들은 것으로
 */
export function dropHallucination(text: string): string {
  const t = text.replace(/[\s.!?,~]/g, "");
  if (/시청해주셔서감사|구독과좋아요|구독좋아요|시청해주셔서고맙|다음영상에서|MBC뉴스|자막제공|자막by|감사합니다$/.test(t) && t.length < 30) return "";
  return text;
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
