# infra

Local development infrastructure.

## Postgres

A single Postgres 16 container for local dev.

```bash
# From repo root
pnpm db:up      # docker compose up -d
pnpm db:down    # docker compose down
```

| Setting  | Value    |
| -------- | -------- |
| Host     | localhost |
| Port     | 5432     |
| User     | signet   |
| Password | signet   |
| Database | signet   |

Connection string (already in `.env.example`):

```
postgresql://signet:signet@localhost:5432/signet
```

Data persists in the named volume `signet-pgdata`. To wipe it:

```bash
docker compose -f infra/docker/docker-compose.yml down -v
```
