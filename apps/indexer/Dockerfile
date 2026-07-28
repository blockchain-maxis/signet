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
# Apply pending migrations, then start the worker.
ENTRYPOINT ["tini", "--"]
CMD ["sh", "-c", "pnpm --filter @signet/db run migrate:deploy && pnpm --filter @signet/indexer run start"]
