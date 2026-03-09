FROM node:22-bookworm-slim AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.30.2 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json

RUN pnpm fetch --filter api...

COPY . .

RUN pnpm install --frozen-lockfile --offline --filter api...
RUN pnpm -C apps/api exec prisma generate
RUN pnpm -C apps/api run build


FROM node:22-bookworm-slim AS runner

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.30.2 --activate

WORKDIR /app

COPY --from=build /app /app

RUN chmod +x /app/apps/api/docker-entrypoint.sh

WORKDIR /app/apps/api

ENV NODE_ENV=production
EXPOSE 3001

ENTRYPOINT ["./docker-entrypoint.sh"]
