import { test } from "node:test";
import assert from "node:assert/strict";
import { Pairing } from "./pairing.js";

test("pairing: 요청 → 승인 → 토큰 1회 전달 → 만료", () => {
  let now = 0;
  const p = new Pairing("GT", () => now);
  const r = p.request()!;
  assert.match(r.code, /^\d{4}$/);
  assert.deepEqual(p.status(r.id), { status: "pending" });
  assert.equal(p.approve("0000" === r.code ? "1111" : "0000"), false);
  assert.equal(p.approve(r.code), true);
  assert.deepEqual(p.status(r.id), { status: "approved", token: "GT" });
  assert.deepEqual(p.status(r.id), { status: "expired" }); // 한 번만
  const r2 = p.request()!;
  now += 6 * 60_000;
  assert.equal(p.approve(r2.code), false); // 5분 지나면 만료
  for (let i = 0; i < 5; i++) assert.ok(p.request());
  assert.equal(p.request(), null); // 동시 최대 5
});
