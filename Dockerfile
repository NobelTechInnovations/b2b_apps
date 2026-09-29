# The Nexus API: every service in one container, the gateway on $PORT.
# Build context is the repository root. Used by Railway (see railway.json).
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages ./packages
COPY services ./services
# The web app is deployed separately (Vercel); install only what the API needs.
RUN pnpm install --frozen-lockfile --prod --filter "./packages/*" --filter "./services/*"

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app ./
COPY scripts ./scripts
# Uploaded documents live here; mount a volume at /app/services/documents/.data
RUN mkdir -p services/documents/.data && chown -R node:node /app
USER node
EXPOSE 8080
CMD ["node", "scripts/start-api.js"]
