// 브라우저용 안경 화면. GET /viewer
// 페이지(앱) 전체가 480x282 dp 안경 화면이다. 바깥 UI 없음. 화면은 칠하지 않고 얇은 테두리만, 페이지 바탕은 검정.
// 안경 앱과 같은 WebSocket(/glass)에 붙어 같은 메시지를 보여 준다.
//
// 조작: 화면 탭/클릭·Enter·↓ = 다음, ↑ = 이전
// 토큰: /viewer?token=… 로 한 번 열면 그 브라우저 localStorage 에 저장하고 주소창에서 지운다.
//       토큰이 없으면 화면 안에 입력 칸을 보여 준다. (서버 코드·저장소에는 토큰 없음)
// 위치: /viewer?geo=1 이면 브라우저 위치를 2초 간격까지 서버로 보낸다.
export const VIEWER_HTML = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=480, height=282, initial-scale=1, user-scalable=no">
<title>안경 화면</title>
<style>
  :root { --g: #00ff66; --dim: #4da86c; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; width: 480px; height: 282px; overflow: hidden; background: #000; color: var(--g);
    font-family: -apple-system, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif; -webkit-user-select: none; user-select: none; }
  /* 화면(앱)은 칠하지 않고 얇은 테두리만. 페이지 바탕은 검정(투과형 안경에서는 검정 = 안 보임) */
  #app { position: relative; width: 480px; height: 282px; padding: 14px 18px; overflow: hidden; cursor: pointer; background: transparent; border: 1px solid var(--dim); border-radius: 12px; }
  .top, .bottom { display: flex; justify-content: space-between; font-size: 13px; height: 18px; color: var(--dim); }
  .bottom { position: absolute; left: 18px; right: 18px; bottom: 10px; font-size: 12px; height: 16px; }
  .line1 { margin-top: 14px; font-size: 22px; line-height: 30px; max-height: 60px; overflow: hidden; font-weight: 700; word-break: keep-all; }
  .line2 { margin-top: 6px; font-size: 17px; line-height: 24px; max-height: 48px; overflow: hidden; word-break: keep-all; }
  .warn .line1 { color: #fff; }
  .idle .line1, .idle .line2 { color: var(--dim); }
  #tokenForm { position: absolute; left: 18px; right: 18px; bottom: 36px; display: none; gap: 8px; }
  #tokenForm input, #tokenForm button { font: inherit; font-size: 14px; padding: 8px; border-radius: 8px; border: 1px solid var(--g); background: transparent; color: var(--g); }
  #tokenForm input { flex: 1; min-width: 0; }
</style>
</head>
<body>
<div id="app" class="idle">
  <div class="top"><span id="progress"></span><span id="dest"></span></div>
  <div id="line1" class="line1">연결 전</div>
  <div id="line2" class="line2"></div>
  <form id="tokenForm"><input id="token" type="password" placeholder="GLASS_TOKEN" autocomplete="off"><button>연결</button></form>
  <div class="bottom"><span id="status"></span><span id="geoStatus"></span></div>
</div>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const KEY = 'glassToken';
  const store = {
    get: () => { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } },
    set: (v) => { try { localStorage.setItem(KEY, v); } catch (e) {} },
  };
  let ws = null, wait = 2000, timer = null, lastSent = 0;

  // ?token= 은 저장하고 주소창에서 지운다
  const params = new URLSearchParams(location.search);
  if (params.get('token')) { store.set(params.get('token')); params.delete('token'); }
  const geoOn = params.get('geo') === '1';
  history.replaceState(null, '', location.pathname + (params.toString() ? '?' + params : ''));

  const show = (m) => {
    const app = $('app');
    if (m.type === 'step') {
      app.className = m.offRoute ? 'warn' : 'step';
      $('line1').textContent = m.line1 || m.text || '';
      $('line2').textContent = m.line2 || '';
      $('progress').textContent = (m.index + 1) + '/' + m.total;
      $('dest').textContent = m.destination ? '→ ' + m.destination : '';
    } else if (m.type === 'arrived') {
      app.className = 'step';
      $('line1').textContent = '도착'; $('line2').textContent = m.destination || '';
      $('progress').textContent = ''; $('dest').textContent = '';
    } else {
      app.className = 'idle';
      $('line1').textContent = m.text || '경로 없음'; $('line2').textContent = '폰에서 길안내를 시작하세요';
      $('progress').textContent = ''; $('dest').textContent = '';
    }
  };
  const status = (t) => { $('status').textContent = t; };
  const send = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };

  function connect() {
    clearTimeout(timer);
    const token = store.get();
    if (!token) { $('tokenForm').style.display = 'flex'; status('토큰 없음'); return; }
    $('tokenForm').style.display = 'none';
    if (ws) { try { ws.onclose = null; ws.close(); } catch (e) {} }
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/glass?token=' + encodeURIComponent(token));
    status('연결 중…');
    ws.onopen = () => { wait = 2000; status(''); send({ type: 'sync' }); };
    ws.onmessage = (e) => { try { show(JSON.parse(e.data)); } catch (err) {} };
    ws.onclose = () => {
      status('끊김 · ' + Math.round(wait / 1000) + '초 뒤 재연결');
      timer = setTimeout(connect, wait); wait = Math.min(wait * 2, 30000);
    };
  }

  $('tokenForm').onsubmit = (e) => { e.preventDefault(); const v = $('token').value.trim(); if (v) store.set(v); $('token').value = ''; connect(); };
  $('app').addEventListener('click', (e) => { if (!e.target.closest('#tokenForm')) send({ type: 'next' }); });
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); send({ type: 'next' }); }
    if (e.key === 'ArrowUp') { e.preventDefault(); send({ type: 'prev' }); }
  });

  if (geoOn && navigator.geolocation) {
    navigator.geolocation.watchPosition((p) => {
      const now = Date.now();
      if (now - lastSent < 2000) return;
      lastSent = now;
      send({ type: 'position', lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, ts: p.timestamp || now });
      $('geoStatus').textContent = '위치 ±' + Math.round(p.coords.accuracy) + 'm';
    }, () => { $('geoStatus').textContent = '위치 실패'; }, { enableHighAccuracy: true, maximumAge: 0 });
  }
  connect();
})();
</script>
</body>
</html>
`;
