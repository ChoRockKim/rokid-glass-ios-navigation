// 즐겨찾기 관리 페이지 (/places). 폰 브라우저에서 별명·주소·카테고리를 넣고 지운다.
// 토큰은 폰 단축어와 같은 API_TOKEN. 페이지에 한 번 넣으면 이 브라우저에만 저장한다.
export const PLACES_HTML = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>즐겨찾기</title>
<style>
  :root { --bg: #0b0f0c; --fg: #e6f2ea; --dim: #8aa596; --g: #00d65a; --line: #24352a; --card: #111a14; --err: #ff7a7a; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", sans-serif; }
  main { max-width: 560px; margin: 0 auto; padding: 16px; }
  h1 { font-size: 20px; margin: 4px 0 16px; }
  h2 { font-size: 14px; color: var(--dim); margin: 22px 0 8px; font-weight: 600; }
  form, .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 14px; }
  label { display: block; font-size: 13px; color: var(--dim); margin: 10px 0 4px; }
  label:first-child { margin-top: 0; }
  input { width: 100%; font: inherit; color: var(--fg); background: #0a120d; border: 1px solid var(--line); border-radius: 8px; padding: 10px; }
  input:focus { outline: 2px solid var(--g); outline-offset: -1px; }
  .row { display: flex; gap: 8px; margin-top: 12px; }
  button { font: inherit; border-radius: 8px; padding: 10px 14px; border: 1px solid var(--g); background: var(--g); color: #04140a; font-weight: 600; }
  button.ghost { background: transparent; color: var(--g); }
  button.del { background: transparent; border-color: var(--line); color: var(--dim); padding: 6px 10px; font-size: 14px; font-weight: 400; }
  .row button { flex: 1; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-top: 1px solid var(--line); }
  li:first-child { border-top: 0; }
  li .t { flex: 1; min-width: 0; }
  li .n { font-weight: 600; }
  li .a { color: var(--dim); font-size: 13px; overflow-wrap: anywhere; }
  #msg { min-height: 22px; margin: 10px 2px 0; font-size: 14px; color: var(--g); }
  #msg.err { color: var(--err); }
  .empty { color: var(--dim); font-size: 14px; }
</style>
</head>
<body>
<main>
  <h1>즐겨찾기</h1>
  <form id="tokenForm" hidden>
    <label for="token">API 토큰 (폰 단축어와 같은 값, 이 브라우저에만 저장)</label>
    <input id="token" type="password" autocomplete="off">
    <div class="row"><button>저장</button></div>
  </form>
  <form id="add" hidden>
    <label for="name">별명</label>
    <input id="name" placeholder="집, 회사, 단골 국밥" required>
    <label for="address">주소 또는 장소 이름</label>
    <input id="address" placeholder="서울 동대문구 이문로 107 / 맥도날드 외대점">
    <label for="category">카테고리</label>
    <input id="category" list="cats" placeholder="기타">
    <datalist id="cats"></datalist>
    <div class="row">
      <button type="submit">추가</button>
      <button type="button" class="ghost" id="here">지금 위치로 추가</button>
    </div>
  </form>
  <div id="msg"></div>
  <div id="list"></div>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  const store = { get: () => { try { return localStorage.getItem('apiToken'); } catch (e) { return null; } }, set: (v) => { try { localStorage.setItem('apiToken', v); } catch (e) {} } };
  const params = new URLSearchParams(location.search);
  if (params.get('token')) { store.set(params.get('token')); history.replaceState(null, '', location.pathname); }
  const say = (t, err) => { $('msg').textContent = t || ''; $('msg').className = err ? 'err' : ''; };
  async function api(method, path, body) {
    const r = await fetch(path, { method, headers: { authorization: 'Bearer ' + store.get(), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) { showToken(); throw new Error('토큰이 맞지 않습니다'); }
    if (!r.ok) throw new Error(j.error || ('오류 ' + r.status));
    return j;
  }
  function showToken() { $('tokenForm').hidden = false; $('add').hidden = true; }
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  async function load() {
    if (!store.get()) return showToken();
    $('tokenForm').hidden = true; $('add').hidden = false;
    const { categories, items } = await api('GET', '/favorites');
    $('cats').replaceChildren(...categories.map((c) => { const o = el('option'); o.value = c; return o; }));
    const list = $('list'); list.replaceChildren();
    if (!items.length) { list.append(el('p', 'empty', '아직 없습니다. 위에서 추가하면 안경 메뉴 → 즐겨찾기에 나옵니다.')); return; }
    for (const c of categories) {
      list.append(el('h2', '', c));
      const card = el('div', 'card'); const ul = el('ul');
      for (const f of items.filter((x) => x.category === c)) {
        const li = el('li'); const t = el('div', 't');
        t.append(el('div', 'n', f.name), el('div', 'a', f.place === f.address ? f.address : f.place + ' · ' + f.address));
        const del = el('button', 'del', '삭제');
        del.onclick = async () => { if (!confirm(f.name + ' 삭제할까요?')) return; try { await api('POST', '/favorites/delete', { name: f.id }); say(f.name + ' 삭제'); load(); } catch (e) { say(e.message, true); } };
        li.append(t, del); ul.append(li);
      }
      card.append(ul); list.append(card);
    }
  }
  async function add(extra) {
    const name = $('name').value.trim();
    if (!name) { say('별명을 넣어 주세요', true); return; }
    say('찾는 중…');
    try {
      const r = await api('POST', '/favorites', { name, category: $('category').value.trim(), ...extra });
      say(r.speech); $('name').value = ''; $('address').value = ''; load();
    } catch (e) { say(e.message, true); }
  }
  $('tokenForm').onsubmit = (e) => { e.preventDefault(); const v = $('token').value.trim(); if (v) { store.set(v); $('token').value = ''; load().catch((er) => say(er.message, true)); } };
  $('add').onsubmit = (e) => { e.preventDefault(); const a = $('address').value.trim(); if (!a) { say('주소를 넣거나 "지금 위치로 추가"를 누르세요', true); return; } add({ address: a }); };
  $('here').onclick = () => {
    if (!$('name').value.trim()) { say('별명을 넣어 주세요', true); return; }
    say('위치 확인 중…');
    navigator.geolocation.getCurrentPosition((p) => add({ lat: p.coords.latitude, lon: p.coords.longitude }), (e) => say('위치를 못 받았습니다: ' + e.message, true), { enableHighAccuracy: true, timeout: 15000 });
  };
  load().catch((e) => say(e.message, true));
</script>
</body>
</html>`;
