import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ota } from "./ota.js";

test("ota: 업로드(OTA 토큰) → latest/다운로드(안경 토큰), 잘못된 토큰 거절", async () => {
  const ota = new Ota(join(mkdtempSync(join(tmpdir(), "ota-")), "app"), "UP", ["G1", "G2"], () => {});
  const srv = createServer(async (req, res) => { if (!(await ota.handle(req, res))) res.writeHead(404).end(); });
  await new Promise<void>((r) => srv.listen(0, r));
  const base = `http://localhost:${(srv.address() as { port: number }).port}`;
  const apk = Buffer.concat([Buffer.from("PK"), Buffer.alloc(1000, 7)]);
  assert.equal((await fetch(`${base}/app/upload?versionCode=9&versionName=0.3.1`, { method: "PUT", body: apk, headers: { authorization: "Bearer G1" } })).status, 401);
  assert.equal((await fetch(`${base}/app/latest`, { headers: { authorization: "Bearer G2" } })).status, 404);
  const up = await fetch(`${base}/app/upload?versionCode=9&versionName=0.3.1`, { method: "PUT", body: apk, headers: { authorization: "Bearer UP" } });
  assert.equal(up.status, 200);
  const meta = (await (await fetch(`${base}/app/latest`, { headers: { authorization: "Bearer G2" } })).json()) as { versionCode: number; size: number };
  assert.equal(meta.versionCode, 9);
  assert.equal(meta.size, apk.length);
  const dl = await fetch(`${base}/app/download?token=G1`);
  assert.equal(dl.status, 200);
  assert.deepEqual(Buffer.from(await dl.arrayBuffer()), apk);
  assert.equal((await fetch(`${base}/app/download`, { headers: { authorization: "Bearer UP" } })).status, 401);
  assert.equal((await fetch(`${base}/app/upload?versionCode=10&versionName=x`, { method: "PUT", body: Buffer.from("nope"), headers: { authorization: "Bearer UP" } })).status, 400);
  srv.close();
});
