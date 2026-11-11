# Railway 등 컨테이너 배포용. 빌드 컨텍스트는 server/
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

# 말해서 찾기: 키 없는 서버 음성 인식 (faster-whisper small int8, rokid-conversate 와 같은 모델).
# 모델은 이미지에 넣어 둔다 (재시작마다 약 500MB 를 다시 받지 않게). 엔진은 첫 요청 때 띄우고 10분 안 쓰면 내린다
ENV HF_HOME=/models WHISPER_PYTHON=/opt/whisper/bin/python WHISPER_MODEL=small WHISPER_COMPUTE_TYPE=int8
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv && rm -rf /var/lib/apt/lists/* \
  && python3 -m venv /opt/whisper && /opt/whisper/bin/pip install --no-cache-dir "faster-whisper>=1.1,<2" \
  && /opt/whisper/bin/python -c "from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8')"
COPY whisper ./whisper
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# PORT 는 Railway 가 주입한다. 상태(진행 중 경로)는 메모리에만 있으므로 인스턴스는 1개로.
CMD ["node", "dist/index.js"]
