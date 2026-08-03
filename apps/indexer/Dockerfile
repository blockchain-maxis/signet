# Indexer worker image. Build from the REPO ROOT:
#   docker build -f apps/indexer/Dockerfile -t signet-indexer .
#
# Runs `prisma migrate deploy` on start (idempotent) so the schema is applied
# before the worker boots, then launches the long-running indexer.
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
# tini ensures signals (SIGTERM/SIGINT) are properly forwarded to the Node.js process
RUN corepack enable \
  && apt-get update \
  && apt-get install -y --no-install-recommends openssl tini \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Install workspace deps (cached on lockfile changes).
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/db/package.json packages/db/
COPY packages/types/package.json packages/types/
COPY apps/indexer/package.json apps/indexer/
RUN pnpm install --frozen-lockfile

# Source.
COPY . .

# Generate the Prisma client.
RUN pnpm --filter @signet/db run generate

ENV NODE_ENV=production

# Liveness: the worker rewrites $INDEXER_LIVENESS_FILE after every successful
# tick. The healthcheck reports unhealthy once that file goes stale (no tick
# within INDEXER_LIVENESS_MAX_AGE_MS, default 120s ≈ 4 missed 30s ticks) or is
# missing — so a wedged worker no longer looks healthy. start-period covers the
# initial boot + seed before failures count.
ENV INDEXER_LIVENESS_FILE=/tmp/indexer-alive
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "const fs=require('fs');const f=process.env.INDEXER_LIVENESS_FILE;const max=Number(process.env.INDEXER_LIVENESS_MAX_AGE_MS||120000);try{process.exit(Date.now()-fs.statSync(f).mtimeMs<max?0:1)}catch{process.exit(1)}"

# Apply pending migrations, then start the worker.
ENTRYPOINT ["tini", "--"]
CMD ["sh", "-c", "pnpm --filter @signet/db run migrate:deploy && pnpm --filter @signet/indexer run start"]
