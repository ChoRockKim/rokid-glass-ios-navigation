// 브라우저용 안경 화면 미리보기. GET /viewer (화면 480x282 dp)
// 안경 앱과 같은 WebSocket(/glass)에 붙어 같은 메시지를 480x282 화면으로 보여 준다.
// 토큰은 페이지에서 입력받아 그 브라우저 localStorage 에만 저장한다 (서버 코드·저장소에 없음).
export const VIEWER_HTML = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>안경 화면 미리보기</title>
<style>
  :root { --g: #00ff66; --dim: #4da86c; --bg: #0b0f0c; }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--g); font-family: -apple-system, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif; }
  main { max-width: 520px; margin: 0 auto; padding: 16px; }
  /* 안경 화면: 480x282 dp */
  .stage-wrap { position: relative; width: 100%; overflow: hidden; border-radius: 14px; box-shadow: 0 0 0 1px #133, 0 8px 30px #0008; }
  .stage { position: absolute; left: 0; top: 0; width: 480px; height: 282px; transform-origin: top left; background: #000; }
  .glass { position: absolute; left: 0; top: 0; width: 480px; height: 282px; padding: 14px 18px; overflow: hidden; }
  .top, .bottom { display: flex; justify-content: space-between; font-size: 16px; height: 22px; color: var(--dim); }
  .bottom { position: absolute; left: 18px; right: 18px; bottom: 10px; font-size: 14px; height: 18px; }
  .line1 { margin-top: 18px; font-size: 30px; line-height: 38px; max-height: 76px; overflow: hidden; font-weight: 700; word-break: keep-all; }
  .line2 { margin-top: 10px; font-size: 22px; line-height: 30px; max-height: 60px; overflow: hidden; word-break: keep-all; }
  .warn .line1 { color: #fff; }
  .idle .line1, .idle .line2 { color: var(--dim); }
  .controls { display: grid; grid-template-columns: 1fr 2fr; gap: 10px; margin-top: 14px; }
  button { font: inherit; font-size: 17px; padding: 14px; border-radius: 12px; border: 1px solid #1f5; background: #062; color: #dfe; }
  button.secondary { background: transparent; color: var(--g); }
  .row { display: flex; gap: 8px; align-items: center; margin-top: 14px; font-size: 14px; color: var(--dim); flex-wrap: wrap; }
  input[type=password] { flex: 1; min-width: 0; font: inherit; padding: 10px; border-radius: 10px; border: 1px solid #1f5; background: #000; color: var(--g); }
  label { display: flex; gap: 6px; align-items: center; }
  small { color: var(--dim); }
</style>
</head>
<body>
<main>
  <div id="wrap" class="stage-wrap">
    <div id="stage" class="stage">
      <div id="glass" class="glass idle">
        <div class="top"><span id="progress"></span><span id="dest"></span></div>
        <div id="line1" class="line1">연결 전</div>
        <div id="line2" class="line2">아래에 GLASS_TOKEN 을 넣으세요</div>
        <div class="bottom"><span id="status"></span><span>탭 다음 · ▲ 이전</span></div>
      </div>
    </div>
  </div>

  <div class="controls">
    <button id="prev" class="secondary">▲ 이전</button>
    <button id="next">탭 · 다음 ▼</button>
  </div>

  <div class="row">
    <input id="token" type="password" placeholder="GLASS_TOKEN" autocomplete="off">
    <button id="save" class="secondary">연결</button>
  </div>
  <div class="row">
    <label><input id="geo" type="checkbox"> 이 브라우저 위치 보내기</label>
    <small id="geoStatus"></small>
  </div>
  <div class="row"><small>키보드: Enter/↓ 다음, ↑ 이전. 토큰은 이 브라우저에만 저장됩니다.</small></div>
</main>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  // 480x282 dp 화면을 그대로 그리고 폭에 맞춰 통째로 축소/확대 (줄바꿈이 안경과 같게)
  const fit = () => { const w = $('wrap').clientWidth; const k = w / 480; $('stage').style.transform = 'scale(' + k + ')'; $('wrap').style.height = (282 * k) + 'px'; };
  window.addEventListener('resize', fit); fit();
  const KEY = 'glassToken';
  let ws = null, wait = 2000, timer = null, watchId = null, lastSent = 0;

  const show = (m) => {
    const g = $('glass');
    if (m.type === 'step') {
      g.className = 'glass ' + (m.offRoute ? 'warn' : 'step');
      $('line1').textContent = m.line1 || m.text || '';
      $('line2').textContent = m.line2 || '';
      $('progress').textContent = (m.index + 1) + '/' + m.total;
      $('dest').textContent = m.destination ? '→ ' + m.destination : '';
    } else if (m.type === 'arrived') {
      g.className = 'glass step';
      $('line1').textContent = '도착'; $('line2').textContent = m.destination || '';
      $('progress').textContent = ''; $('dest').textContent = '';
    } else {
      g.className = 'glass idle';
      $('line1').textContent = m.text || '경로 없음'; $('line2').textContent = '폰에서 길안내를 시작하세요';
      $('progress').textContent = ''; $('dest').textContent = '';
    }
  };
  const status = (t) => { $('status').textContent = t; };
  const send = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };

  function connect() {
    clearTimeout(timer);
    const token = localStorage.getItem(KEY) || '';
    if (!token) { status('토큰 없음'); return; }
    if (ws) { try { ws.onclose = null; ws.close(); } catch (e) {} }
    const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/glass?token=' + encodeURIComponent(token);
    ws = new WebSocket(url);
    status('연결 중…');
    ws.onopen = () => { wait = 2000; status('연결됨'); send({ type: 'sync' }); };
    ws.onmessage = (e) => { try { show(JSON.parse(e.data)); } catch (err) {} };
    ws.onclose = () => {
      status('끊김 · ' + Math.round(wait / 1000) + '초 뒤 재연결');
      timer = setTimeout(connect, wait); wait = Math.min(wait * 2, 30000);
    };
  }

  $('next').onclick = () => send({ type: 'next' });
  $('prev').onclick = () => send({ type: 'prev' });
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); send({ type: 'next' }); }
    if (e.key === 'ArrowUp') { e.preventDefault(); send({ type: 'prev' }); }
  });
  $('save').onclick = () => {
    const v = $('token').value.trim();
    if (v) { localStorage.setItem(KEY, v); $('token').value = ''; }
    connect();
  };
  $('geo').onchange = (e) => {
    if (!e.target.checked) { if (watchId !== null) navigator.geolocation.clearWatch(watchId); watchId = null; $('geoStatus').textContent = ''; return; }
    if (!navigator.geolocation) { $('geoStatus').textContent = '이 브라우저는 위치 미지원'; return; }
    watchId = navigator.geolocation.watchPosition((p) => {
      const now = Date.now();
      if (now - lastSent < 2000) return;
      lastSent = now;
      send({ type: 'position', lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, ts: p.timestamp || now });
      $('geoStatus').textContent = '±' + Math.round(p.coords.accuracy) + 'm 보냄 ' + new Date().toLocaleTimeString();
    }, (err) => { $('geoStatus').textContent = '위치 실패: ' + err.message; }, { enableHighAccuracy: true, maximumAge: 0 });
  };
  connect();
})();
</script>
</body>
</html>
`;
