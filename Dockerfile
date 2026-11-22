# Playwright 공식 이미지(Ubuntu 24.04, 브라우저 포함). 태그는 package.json의 playwright 버전과 같아야 한다.
# v1.65.1 이미지의 Node는 26 (microsoft/playwright utils/docker/Dockerfile.noble의 NODE_VERSION) → engines(>=24.17) 충족
ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.65.1-noble

FROM ${PLAYWRIGHT_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM ${PLAYWRIGHT_IMAGE}
ENV NODE_ENV=production \
    TZ=UTC
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
COPY seed ./seed
# DB는 Railway 볼륨(/data)에만 쓴다. DATABASE_URL=file:/data/tracker.db
EXPOSE 3000
CMD ["node", "dist/index.js"]
