# signet CLI

The `signet` command-line companion to the Signet developer identity registry
on Stellar/Soroban. It lives beside the pnpm workspace rather than inside it —
this is a standalone Go module, not a pnpm package — mirroring the split
between orchestration/UX (Go, here) and anything that must execute Soroban
semantics (Rust, `packages/contracts`).

This module is currently a scaffold: the command tree exists (`signet
--help`, `signet --version`), but the actual subcommands (linking a wallet,
managing keys, talking to a deployment) land in follow-up issues.

## Build

```bash
cd cli
go build -o bin/signet ./cmd/signet
```

To bake a version string and commit hash into the binary:

```bash
go build \
  -ldflags "-X main.version=$(git describe --tags --always) -X main.commit=$(git rev-parse --short HEAD)" \
  -o bin/signet ./cmd/signet
```

## Test / lint

```bash
go vet ./...
go test ./...
golangci-lint run ./...
```

No cgo is used anywhere in this module, so it cross-compiles with the
standard `GOOS`/`GOARCH` combinations, e.g.:

```bash
GOOS=darwin GOARCH=arm64 go build -o bin/signet-darwin-arm64 ./cmd/signet
GOOS=linux  GOARCH=amd64 go build -o bin/signet-linux-amd64  ./cmd/signet
```

## Layout

| Path | Purpose |
|------|---------|
| `cmd/signet` | `main.go` — the binary's entrypoint |
| `internal/cmd` | Cobra command tree |
| `internal/link` | Bind a wallet to a Signet handle (scaffolded, not yet implemented) |
| `internal/keys` | Local signing key management (scaffolded, not yet implemented) |
| `internal/spec` | Typed request/response models for a Signet deployment's HTTP API (scaffolded, not yet implemented) |
