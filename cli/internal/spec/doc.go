// Package spec holds the request/response types for a Signet deployment's CLI
// routes, and the failure codes their error bodies carry, so the rest of the
// CLI talks to a deployment through typed Go values instead of hand-built JSON.
//
// zz_generated_api.go is generated from packages/types/src/cli-api.ts by
// scripts/generate-cli-spec-go.mjs — never edit it by hand; change the
// TypeScript and regenerate. errors.go is hand-written: it maps each failure
// code to the exit code it produces.
package spec
