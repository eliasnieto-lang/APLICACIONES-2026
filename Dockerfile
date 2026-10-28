# Official multi-platform Node 24 image, resolved from Docker Hub on 2026-10-27.
ARG NODE_IMAGE=node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df

FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
COPY package.json package-lock.json ./
# Keep development dependencies: TypeScript/Vite build the UI and tsx runs the API.
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then \
      NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca npm ci --no-audit --no-fund; \
    else npm ci --no-audit --no-fund; fi
COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src
COPY shared ./shared
COPY server ./server
COPY public ./public
RUN npm run build

FROM ${NODE_IMAGE} AS runtime
RUN apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=30 update \
    && apt-get install -y --no-install-recommends \
       ca-certificates poppler-utils tesseract-ocr tesseract-ocr-spa \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3001 \
    DATA_DIR=/app/data \
    NPM_CONFIG_UPDATE_NOTIFIER=false
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/shared ./shared
RUN mkdir -p /app/data && chown node:node /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 3001
HEALTHCHECK --interval=20s --timeout=5s --start-period=20s --retries=3 \
  CMD node --input-type=module -e "const r=await fetch('http://127.0.0.1:'+process.env.PORT+'/api/state');if(!r.ok)process.exit(1);const s=await r.json();if(!Array.isArray(s.students)||!s.settings||!Array.isArray(s.pdfs))process.exit(1);"
CMD ["./node_modules/.bin/tsx", "server/index.ts"]
