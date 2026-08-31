// Package keys resolves which Stellar identity `signet` signs with.
//
// It never reads, parses, or stores a secret key itself: every operation
// shells out to the `stellar` CLI (`stellar keys ls`, `stellar keys
// public-key`), which already owns the keystore's on-disk format, OS
// secure-store integration, and hardware-wallet (`--ledger`) support. Signet
// inherits all of that for free and never holds secret key material in its
// own memory, argv, logs, or a crash dump.
package keys
