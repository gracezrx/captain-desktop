# Captain: one image with the API server and the web app.
#   docker build -t captain .
#   docker run -p 8080:8080 -e DATABASE_URL=... -e APP_SECRET=... captain

# ---- web app (the same React app as the Mac app)
FROM node:22-bookworm-slim AS web
WORKDIR /src
COPY server/src/shared ./server/src/shared
COPY desktop/package.json desktop/package-lock.json ./desktop/
RUN cd desktop && npm ci --no-audit --no-fund
COPY desktop ./desktop
RUN cd desktop && npm run build

# ---- server
FROM node:22-bookworm-slim AS server
WORKDIR /src/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY server ./
RUN npm run build && npm prune --omit=dev

# ---- runtime
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=8080 \
    WEB_DIST=/app/web \
    FILES_DIR=/data/files
WORKDIR /app/server
COPY --from=server /src/server/package.json ./
COPY --from=server /src/server/node_modules ./node_modules
COPY --from=server /src/server/dist ./dist
COPY --from=server /src/server/config ./config
COPY --from=server /src/server/src/db/migrations ./src/db/migrations
COPY --from=web /src/desktop/dist /app/web
RUN mkdir -p /data/files && chown -R node:node /data
USER node
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/src/main.js"]
