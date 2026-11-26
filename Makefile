# Single entrypoint across every toolchain this repo uses (TypeScript, Go for
# the CLI, Rust for the contract simulator in sandbox/ and for the Soroban
# contracts under packages/contracts). Without this, a contributor who only
# knows `pnpm lint` never runs the Go or Rust gates, and CI becomes the first
# place anyone learns the CLI or a contract is broken.
#
# `pnpm build`/`test`/`lint` keep working exactly as before (turbo only, for
# fast per-package caching); `make build`/`test`/`lint` are the one command
# that also covers the Go module, and `make fmt`/`check-fmt` don't exist as
# pnpm scripts at all today.
.PHONY: build test lint fmt check-fmt \
        ts-build ts-test ts-lint check-fmt-ts \
        go-build go-test go-lint go-fmt check-fmt-go \
        sandbox-build sandbox-test sandbox-lint check-fmt-sandbox \
        contracts-build contracts-test contracts-lint check-fmt-contracts

build: ts-build go-build sandbox-build contracts-build

test: ts-test go-test sandbox-test contracts-test

lint: ts-lint go-lint sandbox-lint contracts-lint

fmt: go-fmt

# Go and the two Rust workspaces, deliberately. `check-fmt-ts` exists below but is not aggregated
# here yet: the TypeScript workspace has pre-existing prettier drift (which is
# why CI runs `pnpm format:check || true` rather than gating on it), so folding
# it in would make `make check-fmt` fail for everyone on work they did not do.
# Add it here in the same change that clears the drift.
check-fmt: check-fmt-go check-fmt-sandbox check-fmt-contracts

## TypeScript workspace (pnpm + turbo) — unchanged from what CI already runs.
ts-build:
	pnpm build

ts-test:
	pnpm test

ts-lint:
	pnpm lint

check-fmt-ts:
	pnpm format:check

## Go module (cli/)
go-build:
	cd cli && go build ./...

go-test:
	cd cli && go test ./...

go-lint:
	@command -v golangci-lint >/dev/null 2>&1 || { \
		echo "golangci-lint not found — install: https://golangci-lint.run/usage/install/"; \
		exit 1; \
	}
	cd cli && golangci-lint run ./...

go-fmt:
	cd cli && gofmt -w .

check-fmt-go:
	@cd cli && unformatted="$$(gofmt -l .)"; \
	if [ -n "$$unformatted" ]; then \
		echo "Not gofmt'd:"; echo "$$unformatted"; \
		echo "Run 'make fmt' to fix."; \
		exit 1; \
	fi

## Rust simulator workspace (sandbox/). Each target prints a one-line skip when
## cargo is missing, so a web-only contributor's `make test` still passes.
sandbox-build:
	@command -v cargo >/dev/null 2>&1 || { echo "cargo not found - skipping sandbox build (install: https://rustup.rs)"; exit 0; }; \
	cargo build --release --locked --manifest-path sandbox/Cargo.toml

sandbox-test:
	@command -v cargo >/dev/null 2>&1 || { echo "cargo not found - skipping sandbox tests (install: https://rustup.rs)"; exit 0; }; \
	cargo test --locked --manifest-path sandbox/Cargo.toml

sandbox-lint:
	@command -v cargo >/dev/null 2>&1 || { echo "cargo not found - skipping sandbox lint (install: https://rustup.rs)"; exit 0; }; \
	cargo clippy --locked --manifest-path sandbox/Cargo.toml -- -D warnings

check-fmt-sandbox:
	@command -v cargo >/dev/null 2>&1 || { echo "cargo not found - skipping sandbox fmt check (install: https://rustup.rs)"; exit 0; }; \
	cargo fmt --all --check --manifest-path sandbox/Cargo.toml

## Soroban contracts workspace (packages/contracts). The same rule as the
## sandbox: a one-line skip when cargo is missing. The build also needs the
## stellar CLI, because soroban-sdk refuses a plain `cargo build` of a contract.
## `contracts-test` rewrites the snapshots under identity-registry/test_snapshots;
## commit what changed, since CI fails when they differ from the commit.
contracts-build:
	@command -v cargo >/dev/null 2>&1 || { echo "cargo not found - skipping contracts build (install: https://rustup.rs)"; exit 0; }; \
	command -v stellar >/dev/null 2>&1 || { echo "stellar CLI not found - skipping contracts build (install: cargo install --locked stellar-cli)"; exit 0; }; \
	cd packages/contracts && stellar contract build

contracts-test:
	@command -v cargo >/dev/null 2>&1 || { echo "cargo not found - skipping contracts tests (install: https://rustup.rs)"; exit 0; }; \
	cargo test --locked --manifest-path packages/contracts/Cargo.toml

contracts-lint:
	@command -v cargo >/dev/null 2>&1 || { echo "cargo not found - skipping contracts lint (install: https://rustup.rs)"; exit 0; }; \
	cargo clippy --locked --all-targets --manifest-path packages/contracts/Cargo.toml -- -D warnings

check-fmt-contracts:
	@command -v cargo >/dev/null 2>&1 || { echo "cargo not found - skipping contracts fmt check (install: https://rustup.rs)"; exit 0; }; \
	cargo fmt --all --check --manifest-path packages/contracts/Cargo.toml
