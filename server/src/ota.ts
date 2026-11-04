// 안경 앱 OTA. 최신 APK 하나를 디스크(Railway 볼륨)에 보관한다.
//
// GET  /app/latest    → {versionCode, versionName, size, sha256, uploadedAt}   (안경 토큰: GLASS_TOKEN 또는 GLASS_DEVICE_TOKEN)
// GET  /app/download  → APK 바이너리                                           (안경 토큰)
// PUT  /app/upload?versionCode=9&versionName=0.3.1  본문 = APK                 (OTA_UPLOAD_TOKEN)
//
// APK 안에 안경 토큰이 들어 있으므로 다운로드도 안경 토큰으로 막는다.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { safeEqual, tokenFrom } from "./auth.js";

const MAX_APK = 80 * 1024 * 1024;

export interface AppMeta {
  versionCode: number;
  versionName: string;
  size: number;
  sha256: string;
  uploadedAt: string;
}

export class Ota {
  private apk: string;
  private meta: string;

  constructor(
    private dir: string,
    private uploadToken: string,
    private readTokens: string[],
    private log: (m: string) => void,
  ) {
    mkdirSync(dir, { recursive: true });
    this.apk = join(dir, "app.apk");
    this.meta = join(dir, "app.json");
  }

  latest(): AppMeta | null {
    if (!existsSync(this.meta) || !existsSync(this.apk)) return null;
    return JSON.parse(readFileSync(this.meta, "utf8")) as AppMeta;
  }

  private authed(req: IncomingMessage, tokens: string[]) {
    const t = tokenFrom(req);
    return t !== null && tokens.some((x) => x && safeEqual(t, x));
  }

  private json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  }

  /** 처리했으면 true */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = `${req.method} ${url.pathname}`;
    if (!["GET /app/latest", "GET /app/download", "PUT /app/upload"].includes(route)) return false;

    if (route === "PUT /app/upload") {
      if (!this.uploadToken || !this.authed(req, [this.uploadToken])) return this.json(res, 401, { error: "unauthorized" }), true;
      const versionCode = Number(url.searchParams.get("versionCode"));
      const versionName = url.searchParams.get("versionName") ?? "";
      if (!Number.isInteger(versionCode) || versionCode <= 0 || !versionName) return this.json(res, 400, { error: "versionCode, versionName 필요" }), true;
      const tmp = this.apk + ".part";
      const hash = createHash("sha256");
      let size = 0;
      const out = createWriteStream(tmp);
      try {
        for await (const chunk of req) {
          size += (chunk as Buffer).length;
          if (size > MAX_APK) throw new Error("too large");
          hash.update(chunk as Buffer);
          if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
        }
        await new Promise<void>((r, j) => out.end((e?: Error | null) => (e ? j(e) : r())));
      } catch (e) {
        out.destroy();
        return this.json(res, 413, { error: e instanceof Error ? e.message : String(e) }), true;
      }
      // APK(zip) 서명 확인은 하지 않는다. 최소한 zip 머리("PK")인지만 본다
      const head = readFileSync(tmp).subarray(0, 2).toString("latin1");
      if (head !== "PK") return this.json(res, 400, { error: "APK(zip) 가 아님" }), true;
      renameSync(tmp, this.apk);
      const meta: AppMeta = { versionCode, versionName, size, sha256: hash.digest("hex"), uploadedAt: new Date().toISOString() };
      writeFileSync(this.meta, JSON.stringify(meta));
      this.log(`ota upload: ${versionName} (${versionCode}) ${size}B`);
      return this.json(res, 200, meta), true;
    }

    if (!this.authed(req, this.readTokens)) return this.json(res, 401, { error: "unauthorized" }), true;
    const meta = this.latest();
    if (!meta) return this.json(res, 404, { error: "올라온 APK 없음" }), true;
    if (route === "GET /app/latest") return this.json(res, 200, meta), true;

    res.writeHead(200, {
      "content-type": "application/vnd.android.package-archive",
      "content-length": String(statSync(this.apk).size),
      "x-sha256": meta.sha256,
    });
    createReadStream(this.apk).pipe(res);
    this.log(`ota download: ${meta.versionName}`);
    return true;
  }
}
