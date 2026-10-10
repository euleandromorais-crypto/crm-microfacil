# Imagem única: compila servidor + interface e roda a API (com a fila de jobs no mesmo processo)
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production TZ=America/Sao_Paulo HOST=0.0.0.0 PORT=3000 RUN_WORKER_IN_PROCESS=true STORAGE_DIR=/data/storage
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/package.json ./server/
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist
RUN mkdir -p /data/storage && chown -R node:node /data
USER node
WORKDIR /app/server
EXPOSE 3000
CMD ["node", "dist/index.js"]
