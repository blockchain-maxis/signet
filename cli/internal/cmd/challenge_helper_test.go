package cmd

import (
	"bytes"
	"encoding/base32"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"time"
)

const testnetSigningKey = "GBWMCCC3NHSKLAOJDBKKYW7SSH2PFTTNVFKWSGLWGDLEBKLOVP5JLBBP"

func testChallengeFor(purpose, clientKey string) string {
	now := uint64(time.Now().Unix())
	ch, err := buildTestChallenge(
		testnetSigningKey,
		clientKey,
		purpose,
		"signet.example",
		now-10,
		now+300,
	)
	if err != nil {
		panic(err)
	}
	return ch
}

// testAccountID decodes a G... strkey to its 32-byte ed25519 key. It skips
// the checksum: the keys come from the tests themselves.
func testAccountID(s string) ([32]byte, error) {
	var out [32]byte
	raw, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(s)
	if err != nil || len(raw) != 35 || raw[0] != 6<<3 {
		return out, errors.New("invalid account strkey")
	}
	copy(out[:], raw[1:33])
	return out, nil
}

// buildTestChallenge builds a base64 XDR challenge transaction envelope that
// link.VerifyChallenge accepts, for the link and unlink command tests.
func buildTestChallenge(
	serverKeyStr string,
	clientKeyStr string,
	purpose string,
	homeDomain string,
	minTime uint64,
	maxTime uint64,
) (string, error) {
	serverRaw, err := testAccountID(serverKeyStr)
	if err != nil {
		return "", fmt.Errorf("invalid server key: %w", err)
	}
	clientRaw, err := testAccountID(clientKeyStr)
	if err != nil {
		return "", fmt.Errorf("invalid client key: %w", err)
	}

	var buf bytes.Buffer
	// envelope_type = 2 (ENVELOPE_TYPE_TX)
	_ = binary.Write(&buf, binary.BigEndian, uint32(2))
	// tx: source_account = 0 (KEY_TYPE_ED25519) + 32-byte pubkey
	_ = binary.Write(&buf, binary.BigEndian, uint32(0))
	buf.Write(serverRaw[:])
	// fee = 100
	_ = binary.Write(&buf, binary.BigEndian, uint32(100))
	// seq_num = 0
	_ = binary.Write(&buf, binary.BigEndian, int64(0))
	// cond = PRECOND_TIME (1)
	_ = binary.Write(&buf, binary.BigEndian, uint32(1))
	_ = binary.Write(&buf, binary.BigEndian, minTime)
	_ = binary.Write(&buf, binary.BigEndian, maxTime)
	// memo = MEMO_NONE (0)
	_ = binary.Write(&buf, binary.BigEndian, uint32(0))
	// operations count = 1
	_ = binary.Write(&buf, binary.BigEndian, uint32(1))
	// op source: present (1) + 0 (KEY_TYPE_ED25519) + 32-byte client pubkey
	_ = binary.Write(&buf, binary.BigEndian, uint32(1))
	_ = binary.Write(&buf, binary.BigEndian, uint32(0))
	buf.Write(clientRaw[:])
	// op body: MANAGE_DATA (10)
	_ = binary.Write(&buf, binary.BigEndian, uint32(10))
	// dataName
	nameBytes := []byte(fmt.Sprintf("%s.cli.%s auth", purpose, homeDomain))
	_ = binary.Write(&buf, binary.BigEndian, uint32(len(nameBytes)))
	buf.Write(nameBytes)
	if pad := (4 - (len(nameBytes) % 4)) % 4; pad > 0 {
		buf.Write(make([]byte, pad))
	}
	// dataValue: present (1) + 64 bytes
	_ = binary.Write(&buf, binary.BigEndian, uint32(1))
	dataVal := make([]byte, 64)
	_ = binary.Write(&buf, binary.BigEndian, uint32(len(dataVal)))
	buf.Write(dataVal)
	// ext: 0
	_ = binary.Write(&buf, binary.BigEndian, uint32(0))
	// signatures count: 0
	_ = binary.Write(&buf, binary.BigEndian, uint32(0))

	return base64.StdEncoding.EncodeToString(buf.Bytes()), nil
}
