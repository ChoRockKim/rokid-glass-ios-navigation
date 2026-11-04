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
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# PORT 는 Railway 가 주입한다. 상태(진행 중 경로)는 메모리에만 있으므로 인스턴스는 1개로.
CMD ["node", "dist/index.js"]
