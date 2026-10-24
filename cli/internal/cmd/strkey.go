package cmd

import (
	"encoding/base32"
	"fmt"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
)

// inputError is a malformed argument: exit 2, like link.ValidationError.
type inputError struct{ msg string }

func (e *inputError) Error() string { return e.msg }

func (e *inputError) ExitCode() int { return exitcode.InvalidInput }

// strkeyVersion reads a Stellar strkey's version byte after checking its
// base32 and CRC16 checksum. This is the address text format, not XDR, so
// the CLI may read it; anything it needs inside XDR the simulator decodes.
func strkeyVersion(s string) (byte, bool) {
	raw, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(s)
	if err != nil || len(raw) < 3 {
		return 0, false
	}
	body, sum := raw[:len(raw)-2], raw[len(raw)-2:]
	crc := crc16XModem(body)
	if byte(crc) != sum[0] || byte(crc>>8) != sum[1] {
		return 0, false
	}
	return body[0], true
}

func crc16XModem(data []byte) uint16 {
	var crc uint16
	for _, b := range data {
		crc ^= uint16(b) << 8
		for i := 0; i < 8; i++ {
			if crc&0x8000 != 0 {
				crc = crc<<1 ^ 0x1021
			} else {
				crc <<= 1
			}
		}
	}
	return crc
}

// Strkey version bytes (stellar-strkey): the first character a person sees.
const (
	strkeyAccount  = 6 << 3  // G
	strkeyMuxed    = 12 << 3 // M
	strkeyContract = 2 << 3  // C
)

// requireContract refuses anything but a valid contract strkey (C...), and
// says what an account address is when it gets one.
func requireContract(address string) error {
	version, ok := strkeyVersion(address)
	switch {
	case ok && version == strkeyContract && len(address) == 56:
		return nil
	case ok && (version == strkeyAccount || version == strkeyMuxed):
		return &inputError{fmt.Sprintf("%s is an account address, not a contract — pass the contract's C… address", address)}
	default:
		return &inputError{fmt.Sprintf("%q is not a contract address (C…, 56 characters)", address)}
	}
}
