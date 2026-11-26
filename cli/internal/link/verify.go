package link

import (
	"encoding/base32"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/blockchain-maxis/signet/cli/internal/api"
	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
	"github.com/blockchain-maxis/signet/cli/internal/spec"
)

// VerifyChallenge verifies that an unsigned challenge transaction envelope returned by
// a deployment has the expected shape and parameters before signing it.
func VerifyChallenge(
	envelope string,
	passphrase string,
	publicKey string,
	purpose spec.CliLinkPurpose,
	discovery api.Discovery,
) error {
	return verifyChallengeAt(envelope, passphrase, publicKey, purpose, discovery, time.Now())
}

// ChallengeClockSkew is how far this machine's clock may differ from the
// deployment's when checking a challenge's time bounds. The server sets
// min_time to its own current second, so a client clock even slightly behind
// would otherwise refuse a genuine challenge. Five minutes matches the grace
// the Stellar SDK allows for SEP-10 challenges.
const ChallengeClockSkew = 5 * time.Minute

// withinTimeBounds reports whether now falls inside [minTime, maxTime],
// widened by ChallengeClockSkew on both sides. A maxTime of 0 means no upper
// bound.
func withinTimeBounds(now time.Time, minTime, maxTime uint64) bool {
	grace := uint64(ChallengeClockSkew / time.Second)
	var nowUnix uint64
	if now.Unix() > 0 {
		nowUnix = uint64(now.Unix())
	}
	if nowUnix+grace < minTime {
		return false
	}
	if maxTime != 0 && maxTime <= math.MaxUint64-grace && nowUnix > maxTime+grace {
		return false
	}
	return true
}

func verifyChallengeAt(
	envelope string,
	passphrase string,
	publicKey string,
	purpose spec.CliLinkPurpose,
	discovery api.Discovery,
	now time.Time,
) error {
	trimmed := strings.TrimSpace(envelope)
	if trimmed == "" {
		return fmt.Errorf("%w: challenge envelope is empty", exitcode.ErrSigningFailure)
	}

	raw, err := base64.StdEncoding.DecodeString(trimmed)
	if err != nil || len(raw) == 0 {
		return fmt.Errorf("%w: invalid challenge transaction envelope", exitcode.ErrSigningFailure)
	}

	r := &xdrReader{data: raw}

	// 1. Must be a v1 transaction envelope
	envType, err := r.uint32()
	if err != nil {
		return fmt.Errorf("%w: malformed challenge envelope: %v", exitcode.ErrSigningFailure, err)
	}
	if envType != 2 { // 2 = ENVELOPE_TYPE_TX (TransactionV1Envelope)
		return fmt.Errorf("%w: not a v1 transaction envelope (type %d)", exitcode.ErrSigningFailure, envType)
	}

	// Transaction: source_account
	txSourceAccount, err := r.muxedAccount()
	if err != nil {
		return fmt.Errorf("%w: malformed transaction source account: %v", exitcode.ErrSigningFailure, err)
	}

	// fee
	if _, err := r.uint32(); err != nil {
		return fmt.Errorf("%w: malformed transaction fee: %v", exitcode.ErrSigningFailure, err)
	}

	// sequence number: must be 0
	seqNum, err := r.int64()
	if err != nil {
		return fmt.Errorf("%w: malformed transaction sequence number: %v", exitcode.ErrSigningFailure, err)
	}
	if seqNum != 0 {
		return fmt.Errorf("%w: sequence number is not 0 (%d)", exitcode.ErrSigningFailure, seqNum)
	}

	// preconditions: time bounds must be present and now must fall inside them
	condType, err := r.uint32()
	if err != nil {
		return fmt.Errorf("%w: malformed preconditions: %v", exitcode.ErrSigningFailure, err)
	}

	var hasTimeBounds bool
	var minTime, maxTime uint64
	switch condType {
	case 0: // PRECOND_NONE
		hasTimeBounds = false
	case 1: // PRECOND_TIME
		hasTimeBounds = true
		minTime, err = r.uint64()
		if err != nil {
			return fmt.Errorf("%w: malformed time bounds min_time: %v", exitcode.ErrSigningFailure, err)
		}
		maxTime, err = r.uint64()
		if err != nil {
			return fmt.Errorf("%w: malformed time bounds max_time: %v", exitcode.ErrSigningFailure, err)
		}
	case 2: // PRECOND_V2
		hasTime, err := r.uint32()
		if err != nil {
			return fmt.Errorf("%w: malformed precond_v2 time bounds flag: %v", exitcode.ErrSigningFailure, err)
		}
		if hasTime != 0 {
			hasTimeBounds = true
			minTime, err = r.uint64()
			if err != nil {
				return fmt.Errorf("%w: malformed time bounds min_time: %v", exitcode.ErrSigningFailure, err)
			}
			maxTime, err = r.uint64()
			if err != nil {
				return fmt.Errorf("%w: malformed time bounds max_time: %v", exitcode.ErrSigningFailure, err)
			}
		}
	default:
		return fmt.Errorf("%w: unsupported precondition type %d", exitcode.ErrSigningFailure, condType)
	}

	if !hasTimeBounds {
		return fmt.Errorf("%w: transaction has no time bounds", exitcode.ErrSigningFailure)
	}

	if !withinTimeBounds(now, minTime, maxTime) {
		return fmt.Errorf(
			"%w: current time %s is outside transaction time bounds [%d, %d] (allowing %s of clock skew)",
			exitcode.ErrSigningFailure, now.UTC().Format(time.RFC3339), minTime, maxTime, ChallengeClockSkew,
		)
	}

	// memo
	memoType, err := r.uint32()
	if err != nil {
		return fmt.Errorf("%w: malformed memo type: %v", exitcode.ErrSigningFailure, err)
	}
	switch memoType {
	case 0: // MEMO_NONE
	case 1: // MEMO_TEXT
		if _, err := r.string(); err != nil {
			return fmt.Errorf("%w: malformed memo text: %v", exitcode.ErrSigningFailure, err)
		}
	case 2: // MEMO_ID
		if _, err := r.uint64(); err != nil {
			return fmt.Errorf("%w: malformed memo id: %v", exitcode.ErrSigningFailure, err)
		}
	case 3, 4: // MEMO_HASH, MEMO_RETURN
		if _, err := r.bytes(32); err != nil {
			return fmt.Errorf("%w: malformed memo hash: %v", exitcode.ErrSigningFailure, err)
		}
	default:
		return fmt.Errorf("%w: unsupported memo type %d", exitcode.ErrSigningFailure, memoType)
	}

	// operations: every operation must be manage_data
	opCount, err := r.uint32()
	if err != nil {
		return fmt.Errorf("%w: malformed operations count: %v", exitcode.ErrSigningFailure, err)
	}
	if opCount == 0 {
		return fmt.Errorf("%w: transaction has no operations", exitcode.ErrSigningFailure)
	}

	for i := uint32(0); i < opCount; i++ {
		hasSrc, err := r.uint32()
		if err != nil {
			return fmt.Errorf("%w: malformed operation source flag: %v", exitcode.ErrSigningFailure, err)
		}
		var opSource string
		if hasSrc != 0 {
			opSource, err = r.muxedAccount()
			if err != nil {
				return fmt.Errorf("%w: malformed operation source account: %v", exitcode.ErrSigningFailure, err)
			}
		}

		bodyType, err := r.uint32()
		if err != nil {
			return fmt.Errorf("%w: malformed operation body type: %v", exitcode.ErrSigningFailure, err)
		}
		if bodyType != 10 { // 10 = MANAGE_DATA
			return fmt.Errorf("%w: operation %d is not manage_data (type %d)", exitcode.ErrSigningFailure, i, bodyType)
		}

		dataName, err := r.string()
		if err != nil {
			return fmt.Errorf("%w: malformed manage_data data_name: %v", exitcode.ErrSigningFailure, err)
		}

		hasVal, err := r.uint32()
		if err != nil {
			return fmt.Errorf("%w: malformed manage_data value flag: %v", exitcode.ErrSigningFailure, err)
		}
		if hasVal != 0 {
			valLen, err := r.uint32()
			if err != nil {
				return fmt.Errorf("%w: malformed manage_data value length: %v", exitcode.ErrSigningFailure, err)
			}
			if _, err := r.bytes(int(valLen)); err != nil {
				return fmt.Errorf("%w: malformed manage_data value: %v", exitcode.ErrSigningFailure, err)
			}
		}

		if i == 0 {
			if opSource != publicKey {
				return fmt.Errorf(
					"%w: first operation source account %q does not match public key %q",
					exitcode.ErrSigningFailure, opSource, publicKey,
				)
			}

			prefix := fmt.Sprintf("%s.cli.", purpose)
			suffix := " auth"
			if !strings.HasPrefix(dataName, prefix) || !strings.HasSuffix(dataName, suffix) || len(dataName) <= len(prefix)+len(suffix) {
				return fmt.Errorf(
					"%w: first operation key %q does not match purpose %q",
					exitcode.ErrSigningFailure, dataName, purpose,
				)
			}
		}
	}

	// When stellar.toml publishes a SIGNING_KEY, the transaction's source account equals it
	if discovery.SigningKey != "" && txSourceAccount != discovery.SigningKey {
		return fmt.Errorf(
			"%w: transaction source account %q does not match discovered signing key %q",
			exitcode.ErrSigningFailure, txSourceAccount, discovery.SigningKey,
		)
	}

	// Passphrase check: equals the discovered passphrase when there is one
	if discovery.NetworkPassphrase != "" && passphrase != discovery.NetworkPassphrase {
		return fmt.Errorf(
			"%w: challenge network passphrase %q does not match %q",
			exitcode.ErrSigningFailure, passphrase, discovery.NetworkPassphrase,
		)
	}

	return nil
}

type xdrReader struct {
	data []byte
	pos  int
}

func (r *xdrReader) uint32() (uint32, error) {
	if r.pos+4 > len(r.data) {
		return 0, errors.New("unexpected end of XDR")
	}
	v := binary.BigEndian.Uint32(r.data[r.pos : r.pos+4])
	r.pos += 4
	return v, nil
}

func (r *xdrReader) int64() (int64, error) {
	if r.pos+8 > len(r.data) {
		return 0, errors.New("unexpected end of XDR")
	}
	v := int64(binary.BigEndian.Uint64(r.data[r.pos : r.pos+8]))
	r.pos += 8
	return v, nil
}

func (r *xdrReader) uint64() (uint64, error) {
	if r.pos+8 > len(r.data) {
		return 0, errors.New("unexpected end of XDR")
	}
	v := binary.BigEndian.Uint64(r.data[r.pos : r.pos+8])
	r.pos += 8
	return v, nil
}

func (r *xdrReader) bytes(n int) ([]byte, error) {
	if n < 0 || r.pos+n > len(r.data) {
		return nil, errors.New("unexpected end of XDR")
	}
	b := r.data[r.pos : r.pos+n]
	r.pos += n
	pad := (4 - (n % 4)) % 4
	if r.pos+pad > len(r.data) {
		return nil, errors.New("unexpected end of XDR padding")
	}
	r.pos += pad
	return b, nil
}

func (r *xdrReader) string() (string, error) {
	l, err := r.uint32()
	if err != nil {
		return "", err
	}
	b, err := r.bytes(int(l))
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func (r *xdrReader) muxedAccount() (string, error) {
	disc, err := r.uint32()
	if err != nil {
		return "", err
	}
	switch disc {
	case 0: // KEY_TYPE_ED25519
		b, err := r.bytes(32)
		if err != nil {
			return "", err
		}
		var pk [32]byte
		copy(pk[:], b)
		return encodeAccountID(pk), nil
	case 0x100: // KEY_TYPE_MUXED_ED25519
		if _, err := r.uint64(); err != nil {
			return "", err
		}
		b, err := r.bytes(32)
		if err != nil {
			return "", err
		}
		var pk [32]byte
		copy(pk[:], b)
		return encodeAccountID(pk), nil
	default:
		return "", fmt.Errorf("unsupported account type %d", disc)
	}
}

func encodeAccountID(pubKey [32]byte) string {
	raw := make([]byte, 35)
	raw[0] = 6 << 3 // 48 = version byte for 'G'
	copy(raw[1:33], pubKey[:])
	crc := crc16XModem(raw[:33])
	raw[33] = byte(crc)
	raw[34] = byte(crc >> 8)
	return base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(raw)
}

func decodeAccountID(s string) ([32]byte, error) {
	var out [32]byte
	raw, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(s)
	if err != nil || len(raw) != 35 || raw[0] != 6<<3 {
		return out, errors.New("invalid account strkey")
	}
	crc := crc16XModem(raw[:33])
	if byte(crc) != raw[33] || byte(crc>>8) != raw[34] {
		return out, errors.New("invalid strkey checksum")
	}
	copy(out[:], raw[1:33])
	return out, nil
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
