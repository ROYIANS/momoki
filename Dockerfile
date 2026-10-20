# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/package.json
COPY apps/site/package.json ./apps/site/package.json
COPY apps/desktop/package.json ./apps/desktop/package.json
COPY packages/studio/package.json ./packages/studio/package.json
COPY packages/distribution/package.json ./packages/distribution/package.json
COPY packages/agent-core/package.json ./packages/agent-core/package.json
COPY packages/agent-providers/package.json ./packages/agent-providers/package.json
COPY examples/agent-todo/package.json ./examples/agent-todo/package.json
RUN pnpm install --frozen-lockfile
COPY . .
ARG VITE_UMAMI_SCRIPT_URL=""
ARG VITE_UMAMI_WEBSITE_ID=""
RUN pnpm build

FROM nginx:1.27-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
# Busybox wget ships with the alpine base; 127.0.0.1 because nginx listens on both stacks.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q --spider http://127.0.0.1/healthz || exit 1
