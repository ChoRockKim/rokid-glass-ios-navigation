// 찾아 둔 정류장 위치를 볼륨의 JSON 파일에 기억한다 (경로 다시 찾기·재시작 때마다 카카오를 수십 번 부르지 않게).
// 키 = 종류:노선:정류장 이름. 못 찾은 것도 하루 동안 기억한다 (계속 다시 찾지 않게).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type Entry = { p: [number, number] | null; at: number };

export const MISS_TTL_MS = 24 * 3600_000;
const MAX_ENTRIES = 5000;

export class StopCache {
  private map = new Map<string, Entry>();
  private dirty = false;

  constructor(private file: string | null, private now: () => number = Date.now) {
    if (file && existsSync(file)) {
      try {
        const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, Entry>;
        for (const [k, v] of Object.entries(data)) this.map.set(k, v);
      } catch {
        // 깨진 파일은 무시하고 새로
      }
    }
  }

  static key(kind: string, line: string, name: string) {
    return `${kind}:${line}:${name}`;
  }

  /** 찾은 위치, 못 찾음(null, 하루 안), 모름(undefined) */
  get(key: string): [number, number] | null | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.p === null && this.now() - e.at > MISS_TTL_MS) return undefined;
    return e.p;
  }

  set(key: string, p: [number, number] | null) {
    this.map.delete(key);
    this.map.set(key, { p, at: this.now() });
    while (this.map.size > MAX_ENTRIES) this.map.delete(this.map.keys().next().value!);
    this.dirty = true;
  }

  /** 한 구간을 다 찾은 뒤 한 번 쓴다. 실패해도 길안내에는 영향 없음 */
  flush() {
    if (!this.file || !this.dirty) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file + ".tmp", JSON.stringify(Object.fromEntries(this.map)));
      renameSync(this.file + ".tmp", this.file);
      this.dirty = false;
    } catch {
      // 다음에 다시
    }
  }

  get size() {
    return this.map.size;
  }
}
