# Single entrypoint across every toolchain this repo uses (TypeScript today,
# Go for the CLI, Rust for the Soroban contracts as that gets wired in here
# too). Without this, a contributor who only knows `pnpm lint` never runs the
# Go gates, and CI becomes the first place anyone learns the CLI is broken.
#
# `pnpm build`/`test`/`lint` keep working exactly as before (turbo only, for
# fast per-package caching); `make build`/`test`/`lint` are the one command
# that also covers the Go module, and `make fmt`/`check-fmt` don't exist as
# pnpm scripts at all today.
.PHONY: build test lint fmt check-fmt \
        ts-build ts-test ts-lint \
        go-build go-test go-lint go-fmt check-fmt-go

build: ts-build go-build

test: ts-test go-test

lint: ts-lint go-lint

fmt: go-fmt

check-fmt: check-fmt-go

## TypeScript workspace (pnpm + turbo) — unchanged from what CI already runs.
ts-build:
	pnpm build

ts-test:
	pnpm test

ts-lint:
	pnpm lint

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
