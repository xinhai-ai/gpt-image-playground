FROM node:24-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/api/prisma apps/api/prisma
RUN pnpm install --frozen-lockfile

COPY . .
ENV VITE_API_BASE_URL=/api
RUN pnpm build \
  && pnpm --filter @gpt-image-playground/api prisma:generate \
  && pnpm --filter @gpt-image-playground/api build

FROM node:24-bookworm-slim AS runtime

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/apps/api/package.json apps/api/package.json
COPY --from=build /app/apps/api/node_modules apps/api/node_modules
COPY --from=build /app/apps/api/prisma apps/api/prisma
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/dist public

WORKDIR /app/apps/api

ENV NODE_ENV=production
ENV STATIC_DIR=/app/public

EXPOSE 3001

CMD ["sh", "-c", "pnpm prisma:migrate && pnpm start"]
