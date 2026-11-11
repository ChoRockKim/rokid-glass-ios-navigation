// 안경 음성 검색: 말 다듬기, 즐겨찾기 닮은 이름 찾기, CLOVA Speech 요청 형식(가짜 서버), 음성 → 안경 고르기 → 안내 시작
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

let kakao: Server;
before(async () => {
  kakao = createServer((req, res) => {
    const u = new URL(req.url!, "http://x");
    res.setHeader("content-type", "application/json");
    if (u.pathname.endsWith("keyword.json")) {
      const q = u.searchParams.get("query");
      if (q === "회기역") return res.end(JSON.stringify({ documents: [{ place_name: "회기역 1호선", address_name: "서울 동대문구", x: "127.0", y: "37.502", distance: "220" }] }));
      return res.end(JSON.stringify({ documents: [] }));
    }
    if (u.pathname.endsWith("walk"))
      return res.end(JSON.stringify({
        status: "OK",
        route: { properties: { totalDistance: 300, totalTime: 240 }, legs: [{ steps: [{ path: { points: [[127, 37.5], [127, 37.502]] }, properties: { distance: 300, guidance: "회기역까지 300m 이동", time: 240, x: 127, y: 37.5 } }] }] },
      }));
    res.writeHead(404).end("{}");
  });
  await new Promise<void>((r) => kakao.listen(0, r));
  process.env.KAKAO_BASE = `http://127.0.0.1:${(kakao.address() as { port: number }).port}`;
});
after(() => kakao.close());

test("말 끝 다듬기와 닮은 이름 찾기", async () => {
  const { cleanSpoken, matchSaved, similarity } = await import("./voice.js");
  assert.equal(cleanSpoken("회기역으로 가자."), "회기역");
  assert.equal(cleanSpoken("단골 국밥 안내해 줘"), "단골 국밥");
  assert.equal(cleanSpoken("강남역까지"), "강남역");
  assert.equal(cleanSpoken("집"), "집");
  const saved = [{ name: "집" }, { name: "회사" }, { name: "단골 국밥" }, { name: "회기역 맥도날드" }];
  assert.deepEqual(matchSaved("단골국밥", saved).map((x) => x.name), ["단골 국밥"]);
  assert.deepEqual(matchSaved("단골 국빱", saved).map((x) => x.name), ["단골 국밥"]); // 한 글자 잘못 들음
  assert.deepEqual(matchSaved("집", saved).map((x) => x.name), ["집"]);
  assert.deepEqual(matchSaved("강남역", saved), []);
  assert.ok(similarity("회기역 맥도날드", "회기역맥도날드") === 1);
});

test("CLOVA Speech: 업로드 형식 (헤더, media, params.boostings) 과 결과 글자", async () => {
  const { clovaSpeech, SttError } = await import("./voice.js");
  let seen: { path?: string; key?: string; body?: string } = {};
  let fail = false;
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen = { path: req.url, key: String(req.headers["x-clovaspeech-api-key"]), body: Buffer.concat(chunks).toString("latin1") };
      res.setHeader("content-type", "application/json");
      if (fail) return res.writeHead(401).end(JSON.stringify({ message: "Unauthorized" }));
      res.end(JSON.stringify({ result: "COMPLETED", message: "Succeeded", text: " 회기역으로 가자 " }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, r));
  const stt = clovaSpeech(`http://127.0.0.1:${(srv.address() as { port: number }).port}/external/v1/1/abc/`, "secret-x");
  const text = await stt(Buffer.from("RIFF....WAVE"), ["집", "단골 국밥", "집"]);
  assert.equal(text, "회기역으로 가자");
  assert.equal(seen.path, "/external/v1/1/abc/recognizer/upload");
  assert.equal(seen.key, "secret-x");
  assert.match(seen.body!, /name="media"; filename="voice.wav"/);
  assert.match(seen.body!, /name="params"/);
  const params = JSON.parse(Buffer.from(seen.body!.match(/name="params"\r\n\r\n(.*)\r\n/)![1]!, "latin1").toString("utf8"));
  assert.equal(params.language, "ko-KR");
  assert.equal(params.completion, "sync");
  assert.equal(params.boostings[0].words, "집,단골 국밥");
  fail = true;
  await assert.rejects(stt(Buffer.from("x"), []), (e) => e instanceof SttError && /401/.test(e.message));
  srv.close();
});

test("음성 → 들은 말 제목으로 안경에서 고름 (★ 즐겨찾기 먼저) → 가까우면 도보 안내 시작", async () => {
  const { createApi } = await import("./api.js");
  const { Navigator } = await import("./navigation.js");
  const { Chooser } = await import("./chooser.js");
  const { Favorites } = await import("./favorites.js");
  const nav = new Navigator();
  const chooser = new Chooser();
  const favorites = new Favorites(null);
  favorites.upsert({ name: "회기역 맥도날드", category: "밥", address: "회기로", place: "맥도날드 회기역점", x: 127.0001, y: 37.5005 });
  const asked: { title: string; items: string[] }[] = [];
  chooser.attach((m) => {
    if (m.type === "choose") {
      asked.push({ title: m.title, items: m.items });
      setTimeout(() => chooser.answer(m.id, 1), 5); // 두 번째(카카오 후보) 선택
    }
  });
  let hints: string[] = [];
  const api = createApi({
    nav, apiToken: "a", kakaoKey: "k", log: () => {}, chooser, favorites,
    stt: async (_audio, h) => ((hints = h), "회기역으로 가자"),
  });
  // 위치가 없으면 안내를 시작하지 않는다
  assert.match(await api.goVoice(Buffer.alloc(2000)), /현재 위치 없음/);
  api.ingest([{ lat: 37.5, lon: 127.0, ts: Date.now() }]);
  const text = await api.goVoice(Buffer.alloc(2000));
  assert.deepEqual(hints, ["회기역 맥도날드"]);
  assert.equal(asked[0]!.title, '들은 말: "회기역"');
  assert.match(asked[0]!.items[0]!, /^★ 회기역 맥도날드/);
  assert.match(asked[0]!.items[1]!, /^회기역 1호선/);
  assert.match(text, /회기역 1호선 도보 안내/);
  assert.equal(nav.current?.guide.length ? true : false, true);
});

test("음성: 못 찾거나 못 알아들으면 다시 말해 달라고", async () => {
  const { createApi } = await import("./api.js");
  const { Navigator } = await import("./navigation.js");
  const { Chooser } = await import("./chooser.js");
  const nav = new Navigator();
  let said = "";
  const api = createApi({ nav, apiToken: "a", kakaoKey: "k", log: () => {}, chooser: new Chooser(), stt: async () => said });
  api.ingest([{ lat: 37.5, lon: 127.0, ts: Date.now() }]);
  said = "";
  assert.match(await api.goVoice(Buffer.alloc(2000)), /못 알아들었어요/);
  said = "없는곳";
  assert.match(await api.goVoice(Buffer.alloc(2000)), /찾지 못함 · 다시 말해/);
  const off = createApi({ nav, apiToken: "a", kakaoKey: "k", log: () => {} });
  assert.match(await off.goVoice(Buffer.alloc(2000)), /음성 인식 키가 없음/);
});

test("안경이 알아들은 글자(키 없음): 첫 후보로 못 찾으면 다음 후보, 서버 음성 키가 없어도 됨", async () => {
  const { createApi } = await import("./api.js");
  const { Navigator } = await import("./navigation.js");
  const { Chooser } = await import("./chooser.js");
  const nav = new Navigator();
  const chooser = new Chooser();
  const asked: string[] = [];
  chooser.attach((m) => { if (m.type === "choose") { asked.push(m.title); setTimeout(() => chooser.answer(m.id, -1), 5); } });
  const api = createApi({ nav, apiToken: "a", kakaoKey: "k", log: () => {}, chooser });
  api.ingest([{ lat: 37.5, lon: 127.0, ts: Date.now() }]);
  // "없는곳" 은 카카오 결과 없음 → 두 번째 후보 "회기역" 으로 찾음
  const text = await api.goVoiceText(["없는곳으로 가자", "회기역으로 가자"]);
  assert.equal(asked[0], '들은 말: "회기역"');
  assert.match(text, /취소/);
  assert.match(await api.goVoiceText([]), /못 알아들었어요/);
});

test("서버 Whisper (키 없음): 처음 요청 때 엔진을 띄우고, 힌트를 넘기고, 지어낸 문장은 거르고, 안 쓰면 내린다", async () => {
  const { localWhisper, dropHallucination, SttError } = await import("./voice.js");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  // 모델 대신: 받은 prompt 와 WAV 길이로 답하는 가짜 워커 (실제 worker.py 와 같은 줄 단위 JSON)
  const dir = mkdtempSync(join(tmpdir(), "whisper-"));
  const script = join(dir, "fake.py");
  writeFileSync(script, [
    "import sys, json, base64",
    "print(json.dumps({'ready': True, 'ms': 5}), flush=True)",
    "for line in sys.stdin:",
    "    r = json.loads(line)",
    "    n = len(base64.b64decode(r['wav']))",
    "    if n == 3: print(json.dumps({'id': r['id'], 'text': '시청해 주셔서 감사합니다.'}), flush=True)",
    "    elif n == 4: print(json.dumps({'id': r['id'], 'error': 'bad wav'}), flush=True)",
    "    else: print(json.dumps({'id': r['id'], 'text': ' 회기역으로 가자 ' + r['prompt'], 'ms': 1}, ensure_ascii=False), flush=True)",
  ].join("\n"));
  const logs: string[] = [];
  const stt = localWhisper({ script, idleMs: 200, log: (m) => logs.push(m) });
  assert.equal(await stt(Buffer.alloc(10), ["집", "단골 국밥"]), "회기역으로 가자 목적지: 집, 단골 국밥");
  assert.equal(await stt(Buffer.alloc(3), []), ""); // 지어낸 문장
  await assert.rejects(stt(Buffer.alloc(4), []), (e) => e instanceof SttError && /bad wav/.test(e.message));
  assert.equal(logs.filter((l) => /모델 준비/.test(l)).length, 1, "엔진은 한 번만 띄움");
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(logs.some((l) => /내림/.test(l)));
  // 내린 뒤 다시 쓰면 다시 띄움
  assert.match(await stt(Buffer.alloc(10), []), /^회기역으로 가자/);
  assert.equal(logs.filter((l) => /모델 준비/.test(l)).length, 2);
  // 엔진을 못 띄우면 오류
  const broken = localWhisper({ python: "/nonexistent/python", script });
  await assert.rejects(broken(Buffer.alloc(10), []), (e) => e instanceof SttError);
  assert.equal(dropHallucination("회기역"), "회기역");
});
