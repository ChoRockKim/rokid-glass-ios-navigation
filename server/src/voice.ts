// 안경 마이크로 말한 목적지 → 글자 (CLOVA Speech) → 즐겨찾기·최근 목적지와 맞춰 보기.
// CLOVA Speech 요청 형식은 네이버 클라우드 문서(장문 인식 API, 로컬 파일 /recognizer/upload, completion=sync, boostings)를 보고 쓴 것.
// 실제 호출은 아직 해 보지 못함 (키 필요) → 실서버 로그로 확인.
import { Blob } from "node:buffer";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
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
 * 서버에서 직접 돌리는 Whisper (키 없음). server/whisper/worker.py (faster-whisper small int8) 를 처음 요청 때 띄우고,
 * IDLE_MS 동안 안 쓰면 내린다 (모델이 메모리를 수백 MB 차지 → 늘 띄워 두면 Railway 메모리 요금).
 * 처음 한 번은 모델 로드(수 초)가 더해지고, 그다음은 문장 하나 약 1초 (2026-11-11 4코어 로컬 측정, Railway 는 재 봐야 함).
 * hints 는 initial_prompt 로 (고유명사 표기를 맞추는 데 도움)
 */
export function localWhisper(opts: { python?: string; script?: string; idleMs?: number; log?: (m: string) => void } = {}): Transcriber {
  const python = opts.python ?? process.env.WHISPER_PYTHON ?? "python3";
  const script = opts.script ?? process.env.WHISPER_WORKER ?? fileURLToPath(new URL("../whisper/worker.py", import.meta.url));
  const idleMs = opts.idleMs ?? Number(process.env.WHISPER_IDLE_MS ?? 10 * 60_000);
  let proc: ChildProcessWithoutNullStreams | null = null;
  let ready: Promise<void> | null = null;
  let seq = 0;
  const waiting = new Map<number, { resolve: (t: string) => void; reject: (e: Error) => void }>();
  let idle: ReturnType<typeof setTimeout> | null = null;

  const stop = () => {
    if (!proc) return;
    opts.log?.("whisper: 안 쓴 지 오래돼 내림");
    proc.kill();
    proc = null;
    ready = null;
  };
  const start = () => {
    const p = spawn(python, [script], { stdio: ["pipe", "pipe", "pipe"] });
    // 서버가 끝나면 엔진도 같이
    const killOnExit = () => p.kill();
    process.once("exit", killOnExit);
    p.once("exit", () => process.off("exit", killOnExit));
    proc = p;
    let buf = "";
    let onReady: (() => void) | null = null;
    let onFail: ((e: Error) => void) | null = null;
    ready = new Promise<void>((res, rej) => { onReady = res; onFail = rej; });
    ready.catch(() => {});
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (chunk: string) => {
      buf += chunk;
      let k: number;
      while ((k = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, k).trim();
        buf = buf.slice(k + 1);
        if (!line) continue;
        let m: { ready?: boolean; id?: number; text?: string; error?: string; ms?: number };
        try { m = JSON.parse(line); } catch { continue; }
        if (m.ready) { opts.log?.(`whisper: 모델 준비 ${m.ms}ms`); onReady?.(); continue; }
        const w = m.id === undefined ? undefined : waiting.get(m.id);
        if (!w) continue;
        waiting.delete(m.id!);
        if (m.error !== undefined) w.reject(new SttError(`음성 인식 실패 (${m.error.slice(0, 80)})`));
        else { opts.log?.(`whisper: ${m.ms}ms`); w.resolve(m.text ?? ""); }
      }
    });
    let err = "";
    p.stderr.setEncoding("utf8");
    p.stderr.on("data", (c: string) => { err = (err + c).slice(-500); });
    const fail = (why: string) => {
      if (proc === p) { proc = null; ready = null; }
      const e = new SttError(`음성 인식 실패 (${why})`);
      onFail?.(e);
      for (const w of waiting.values()) w.reject(e);
      waiting.clear();
    };
    p.on("error", (e) => fail(e.message));
    p.on("exit", (code) => { if (code !== null && code !== 0) opts.log?.(`whisper 종료 ${code}: ${err.trim().split("\n").pop() ?? ""}`); fail(`엔진 종료 ${code ?? ""}`.trim()); });
  };

  return async (audio, hints) => {
    if (idle) clearTimeout(idle);
    if (!proc) start();
    const p = proc!;
    let loadTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([ready!, new Promise((_, rej) => { loadTimer = setTimeout(() => rej(new SttError("음성 인식 실패 (모델 로드 시간 초과)")), 120_000); })]);
    } finally {
      clearTimeout(loadTimer);
    }
    const names = [...new Set(hints.map((h) => h.trim()).filter(Boolean))];
    let prompt = "";
    for (const n of names) {
      if ((prompt + n).length > 180) break;
      prompt += (prompt ? ", " : "목적지: ") + n;
    }
    const id = ++seq;
    let reqTimer: ReturnType<typeof setTimeout> | undefined;
    const text = await new Promise<string>((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      p.stdin.write(JSON.stringify({ id, wav: audio.toString("base64"), prompt }) + "\n");
      reqTimer = setTimeout(() => { if (waiting.delete(id)) reject(new SttError("음성 인식 실패 (시간 초과)")); }, 30_000);
    }).finally(() => {
      clearTimeout(reqTimer);
      if (idle) clearTimeout(idle);
      idle = setTimeout(stop, idleMs);
    });
    return dropHallucination(text.trim());
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
