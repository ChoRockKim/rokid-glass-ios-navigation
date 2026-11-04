<script def>
{
  "navigationBarTitleText": "길안내",
  "description": "경로 안내 서버의 현재 단계를 크게 보여 주고, 탭으로 다음 단계로 넘긴다.",
  "schema": {
    "data": {
      "type": "object",
      "properties": {}
    }
  }
}
</script>

<script setup>
import { SERVER_WS, GLASS_TOKEN, POSITION_MIN_INTERVAL_MS } from '../../lib/config.js';

const Reconnect = Object.freeze({ MIN_MS: 2000, MAX_MS: 30000 });

/**
 * 서버 메시지(step/arrived/idle)를 화면 데이터로 바꾼다.
 *
 * @param {any} m 서버가 보낸 JSON.
 * @returns {object} setData 에 넣을 값.
 */
function viewFor(m) {
  if (m.type === 'step') {
    return {
      mode: m.offRoute ? 'warn' : 'step',
      line1: m.line1 || m.text || '',
      line2: m.line2 || '',
      progress: (m.index + 1) + '/' + m.total,
      destination: m.destination ? '→ ' + m.destination : ''
    };
  }
  if (m.type === 'arrived') {
    return { mode: 'done', line1: '도착', line2: m.destination || '', progress: '', destination: '' };
  }
  return { mode: 'idle', line1: m.text || '경로 없음', line2: '폰에서 길안내를 시작하세요', progress: '', destination: '' };
}

export default {
  data: {
    mode: 'idle',
    line1: '연결 중…',
    line2: '',
    progress: '',
    destination: '',
    status: '',
    hint: '탭 다음 · ▲ 이전'
  },

  onLoad() {
    this.socket = null;
    this.reconnectMs = Reconnect.MIN_MS;
    this.reconnectTimer = null;
    this.watchId = null;
    this.lastPositionSentAt = 0;
    this.active = false;
  },

  onShow() {
    this.active = true;
    this.connect();
    this.startPosition();
  },

  onHide() {
    this.stopAll();
  },

  onUnload() {
    this.stopAll();
  },

  stopAll() {
    this.active = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.socket) {
      try { this.socket.close(1000, 'page hidden'); } catch (e) { /* 이미 닫힘 */ }
    }
    this.socket = null;
    if (this.watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
  },

  connect() {
    if (!this.active) return;
    if (!GLASS_TOKEN) {
      this.setData({ mode: 'warn', line1: '토큰 없음', line2: 'lib/config.js 의 GLASS_TOKEN', status: '' });
      return;
    }
    const url = SERVER_WS + '?token=' + encodeURIComponent(GLASS_TOKEN);
    let socket;
    try {
      socket = new WebSocket(url);
    } catch (e) {
      this.scheduleReconnect('연결 실패');
      return;
    }
    this.socket = socket;
    this.setData({ status: '연결 중…' });

    socket.addEventListener('open', () => {
      this.reconnectMs = Reconnect.MIN_MS;
      this.setData({ status: '' });
      this.send({ type: 'sync' });
    });
    socket.addEventListener('message', (event) => {
      let m;
      try { m = JSON.parse(event.data); } catch (e) { return; }
      this.setData(viewFor(m));
    });
    socket.addEventListener('close', (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      // 1008/4001 이나 서버가 401 로 끊으면 토큰 문제일 가능성이 크다
      this.scheduleReconnect(event && event.code === 1008 ? '인증 실패?' : '연결 끊김');
    });
    socket.addEventListener('error', () => {
      this.setData({ status: '연결 오류' });
    });
  },

  scheduleReconnect(reason) {
    if (!this.active) return;
    const wait = this.reconnectMs;
    this.reconnectMs = Math.min(this.reconnectMs * 2, Reconnect.MAX_MS);
    this.setData({ status: reason + ' · ' + Math.round(wait / 1000) + '초 뒤 재연결' });
    this.reconnectTimer = setTimeout(() => this.connect(), wait);
  },

  send(obj) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(obj));
  },

  startPosition() {
    if (!navigator.geolocation || this.watchId !== null) return;
    try {
      this.watchId = navigator.geolocation.watchPosition(
        (pos) => {
          const now = Date.now();
          if (now - this.lastPositionSentAt < POSITION_MIN_INTERVAL_MS) return;
          this.lastPositionSentAt = now;
          const c = pos.coords;
          this.send({ type: 'position', lat: c.latitude, lon: c.longitude, acc: c.accuracy, ts: pos.timestamp || now });
        },
        () => {
          // 위치를 못 받아도 안내 표시는 계속한다 (폰의 Overland 가 대신 보낼 수 있다)
        },
        { enableHighAccuracy: true, maximumAge: 0 }
      );
    } catch (e) {
      this.watchId = null;
    }
  },

  onKeyUp(event) {
    // 탭(Enter)·아래 = 다음, 위 = 이전. Backspace 는 기본 동작(뒤로/닫기)에 맡긴다.
    if (event.code === 'Enter' || event.code === 'ArrowDown') {
      event.preventDefault();
      this.send({ type: 'next' });
    } else if (event.code === 'ArrowUp') {
      event.preventDefault();
      this.send({ type: 'prev' });
    }
  }
};
</script>

<page>
  <view class="screen mode-{{mode}}">
    <view class="top">
      <text class="progress">{{progress}}</text>
      <text class="destination">{{destination}}</text>
    </view>
    <text class="line1">{{line1}}</text>
    <text class="line2">{{line2}}</text>
    <view class="bottom">
      <text class="status">{{status}}</text>
      <text class="hint">{{hint}}</text>
    </view>
  </view>
</page>

<style>
.screen {
  position: relative;
  width: 480px;
  height: 352px;
  box-sizing: border-box;
  padding: 16px 20px;
  overflow: hidden;
  background-color: #000000;
  color: #00ff66;
}

.top {
  display: flex;
  flex-direction: row;
  justify-content: space-between;
  height: 28px;
}

.progress,
.destination,
.status,
.hint {
  font-size: 18px;
  color: #4da86c;
}

.line1 {
  display: block;
  margin-top: 40px;
  font-size: 34px;
  line-height: 44px;
  font-weight: bold;
}

.line2 {
  display: block;
  margin-top: 16px;
  font-size: 26px;
  line-height: 34px;
}

.bottom {
  position: absolute;
  left: 20px;
  right: 20px;
  bottom: 12px;
  display: flex;
  flex-direction: row;
  justify-content: space-between;
}

.mode-warn .line1 {
  color: #ffffff;
}

.mode-idle .line1,
.mode-idle .line2 {
  color: #4da86c;
}
</style>
