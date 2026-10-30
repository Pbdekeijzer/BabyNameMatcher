FROM node:25-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json vitest.config.ts ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY vendor ./vendor
RUN npm ci --ignore-scripts
RUN npm rebuild esbuild

COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
RUN npm run build
RUN npm prune --omit=dev --ignore-scripts

FROM node:25-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    RUNTIME_DIR=/app/runtime \
    WEB_DIST=/app/apps/web/dist \
    COOKIE_SECURE=true

WORKDIR /app
COPY package.json package-lock.json ./
COPY LICENSE THIRD_PARTY_NOTICES.md ./
COPY notices ./notices
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY vendor ./vendor

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages/shared/dist ./packages/shared/dist

RUN mkdir -p /app/runtime && chown node:node /app/runtime
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "apps/server/dist/index.js"]
