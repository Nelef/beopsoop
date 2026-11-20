# 법숲 이미지 — glibc 기반(onnxruntime). 임베딩 모델 · 임베딩 캐시 · 법령 원문을 이미지에 포함해 인터넷 없이도 검색이 돈다.
FROM node:22-slim
RUN npm i -g @anthropic-ai/claude-code && npm cache clean --force
WORKDIR /srv
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY mcp ./mcp
COPY web ./web
COPY server.mjs ./
COPY data/raw ./data/raw
COPY data/cache ./data/cache
COPY data/models ./data/models
COPY data/demo.jso[n] ./data/
COPY eval/results/final.json ./eval/results/final.json
ENV PORT=8000 FINLAW_OFFLINE=1 FINLAW_CLAUDE_CONFIG_DIR=/data/claude-config HOME=/data
EXPOSE 8000
CMD ["node", "server.mjs"]
