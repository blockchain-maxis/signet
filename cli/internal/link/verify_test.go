package link

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"testing"
	"time"

	"github.com/blockchain-maxis/signet/cli/internal/api"
	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
	"github.com/blockchain-maxis/signet/cli/internal/spec"
)

var (
	testServerKey = [32]byte{
		0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
		0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
		0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18,
		0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20,
	}
	testClientKey = [32]byte{
		0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x11, 0x22,
		0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0x00,
		0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
		0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
	}
	mainnetPassphrase   = "Public Global Stellar Network ; September 2015"
	testServerPublicKey = encodeAccountID(testServerKey)
	testClientPublicKey = encodeAccountID(testClientKey)
)

func buildRawChallenge(
	envType uint32,
	txSource [32]byte,
	seqNum int64,
	condType uint32,
	minTime, maxTime uint64,
	opSourcePresent bool,
	opSource [32]byte,
	opBodyType uint32,
	dataName string,
) string {
	var buf bytes.Buffer

	// envelope_type
	_ = binary.Write(&buf, binary.BigEndian, envType)

	// tx: source_account (0 = ed25519)
	_ = binary.Write(&buf, binary.BigEndian, uint32(0))
	buf.Write(txSource[:])

	// fee
	_ = binary.Write(&buf, binary.BigEndian, uint32(200))

	// seq_num
	_ = binary.Write(&buf, binary.BigEndian, seqNum)

	// cond
	_ = binary.Write(&buf, binary.BigEndian, condType)
	if condType == 1 { // PRECOND_TIME
		_ = binary.Write(&buf, binary.BigEndian, minTime)
		_ = binary.Write(&buf, binary.BigEndian, maxTime)
	}

	// memo (0 = MEMO_NONE)
	_ = binary.Write(&buf, binary.BigEndian, uint32(0))

	// operations count
	_ = binary.Write(&buf, binary.BigEndian, uint32(1))

	// op 0: source_account
	if opSourcePresent {
		_ = binary.Write(&buf, binary.BigEndian, uint32(1))
		_ = binary.Write(&buf, binary.BigEndian, uint32(0)) // ed25519
		buf.Write(opSource[:])
	} else {
		_ = binary.Write(&buf, binary.BigEndian, uint32(0))
	}

	// op 0: body type
	_ = binary.Write(&buf, binary.BigEndian, opBodyType)

	if opBodyType == 10 { // MANAGE_DATA
		// data_name string
		nameBytes := []byte(dataName)
		_ = binary.Write(&buf, binary.BigEndian, uint32(len(nameBytes)))
		buf.Write(nameBytes)
		pad := (4 - (len(nameBytes) % 4)) % 4
		for i := 0; i < pad; i++ {
			buf.WriteByte(0)
		}

		// data_value (present, 4 bytes dummy)
		_ = binary.Write(&buf, binary.BigEndian, uint32(1))
		_ = binary.Write(&buf, binary.BigEndian, uint32(4))
		buf.Write([]byte("test"))
	}

	// ext (0)
	_ = binary.Write(&buf, binary.BigEndian, uint32(0))

	// signatures count (0)
	_ = binary.Write(&buf, binary.BigEndian, uint32(0))

	return base64.StdEncoding.EncodeToString(buf.Bytes())
}

func TestVerifyChallenge_AcceptsValidLinkChallenge(t *testing.T) {
	serverPub := encodeAccountID(testServerKey)
	clientPub := encodeAccountID(testClientKey)
	now := time.Unix(1000, 0)

	envelope := buildRawChallenge(
		2, testServerKey, 0, 1, 900, 1200, true, testClientKey, 10, "link.cli.signet.dev auth",
	)
	discovery := api.Discovery{
		NetworkPassphrase: testPassphrase,
		SigningKey:        serverPub,
	}

	err := verifyChallengeAt(envelope, testPassphrase, clientPub, spec.CliLinkPurposeLink, discovery, now)
	if err != nil {
		t.Fatalf("expected valid link challenge to pass, got: %v", err)
	}
}

func TestVerifyChallenge_AcceptsValidUnlinkChallenge(t *testing.T) {
	serverPub := encodeAccountID(testServerKey)
	clientPub := encodeAccountID(testClientKey)
	now := time.Unix(1000, 0)

	envelope := buildRawChallenge(
		2, testServerKey, 0, 1, 900, 1200, true, testClientKey, 10, "unlink.cli.signet.dev auth",
	)
	discovery := api.Discovery{
		NetworkPassphrase: testPassphrase,
		SigningKey:        serverPub,
	}

	err := verifyChallengeAt(envelope, testPassphrase, clientPub, spec.CliLinkPurposeUnlink, discovery, now)
	if err != nil {
		t.Fatalf("expected valid unlink challenge to pass, got: %v", err)
	}
}

func TestVerifyChallenge_RejectsNonV1Envelope(t *testing.T) {
	clientPub := encodeAccountID(testClientKey)
	now := time.Unix(1000, 0)

	// envType = 0 (v0 envelope)
	envelope := buildRawChallenge(
		0, testServerKey, 0, 1, 900, 1200, true, testClientKey, 10, "link.cli.signet.dev auth",
	)
	err := verifyChallengeAt(envelope, testPassphrase, clientPub, spec.CliLinkPurposeLink, api.Discovery{}, now)
	if !errors.Is(err, exitcode.ErrSigningFailure) {
		t.Fatalf("got %v, want ErrSigningFailure", err)
	}
}

func TestVerifyChallenge_RejectsNonZeroSequenceNumber(t *testing.T) {
	clientPub := encodeAccountID(testClientKey)
	now := time.Unix(1000, 0)

	// seqNum = 1
	envelope := buildRawChallenge(
		2, testServerKey, 1, 1, 900, 1200, true, testClientKey, 10, "link.cli.signet.dev auth",
	)
	err := verifyChallengeAt(envelope, testPassphrase, clientPub, spec.CliLinkPurposeLink, api.Discovery{}, now)
	if !errors.Is(err, exitcode.ErrSigningFailure) {
		t.Fatalf("got %v, want ErrSigningFailure", err)
	}
}

func TestVerifyChallenge_RejectsNonManageDataOperation(t *testing.T) {
	clientPub := encodeAccountID(testClientKey)
	now := time.Unix(1000, 0)

	// opBodyType = 1 (payment)
	envelope := buildRawChallenge(
		2, testServerKey, 0, 1, 900, 1200, true, testClientKey, 1, "link.cli.signet.dev auth",
	)
	err := verifyChallengeAt(envelope, testPassphrase, clientPub, spec.CliLinkPurposeLink, api.Discovery{}, now)
	if !errors.Is(err, exitcode.ErrSigningFailure) {
		t.Fatalf("got %v, want ErrSigningFailure", err)
	}
}

func TestVerifyChallenge_RejectsWrongFirstOperationSourceAccount(t *testing.T) {
	clientPub := encodeAccountID(testClientKey)
	wrongKey := testServerKey
	now := time.Unix(1000, 0)

	envelope := buildRawChallenge(
		2, testServerKey, 0, 1, 900, 1200, true, wrongKey, 10, "link.cli.signet.dev auth",
	)
	err := verifyChallengeAt(envelope, testPassphrase, clientPub, spec.CliLinkPurposeLink, api.Discovery{}, now)
	if !errors.Is(err, exitcode.ErrSigningFailure) {
		t.Fatalf("got %v, want ErrSigningFailure", err)
	}
}

func TestVerifyChallenge_RejectsWrongFirstOperationKeyPrefixOrSuffix(t *testing.T) {
	clientPub := encodeAccountID(testClientKey)
	now := time.Unix(1000, 0)

	for _, badKey := range []string{
		"link.cli.signet.dev login",
		"other.cli.signet.dev auth",
		"link.cli. auth",
		"plain text",
	} {
		envelope := buildRawChallenge(
			2, testServerKey, 0, 1, 900, 1200, true, testClientKey, 10, badKey,
		)
		err := verifyChallengeAt(envelope, testPassphrase, clientPub, spec.CliLinkPurposeLink, api.Discovery{}, now)
		if !errors.Is(err, exitcode.ErrSigningFailure) {
			t.Fatalf("for key %q got %v, want ErrSigningFailure", badKey, err)
		}
	}
}

func TestVerifyChallenge_RejectsWrongPurpose(t *testing.T) {
	clientPub := encodeAccountID(testClientKey)
	now := time.Unix(1000, 0)

	// Challenge minted for unlink, checked for link
	unlinkEnv := buildRawChallenge(
		2, testServerKey, 0, 1, 900, 1200, true, testClientKey, 10, "unlink.cli.signet.dev auth",
	)
	err := verifyChallengeAt(unlinkEnv, testPassphrase, clientPub, spec.CliLinkPurposeLink, api.Discovery{}, now)
	if !errors.Is(err, exitcode.ErrSigningFailure) {
		t.Fatalf("got %v, want ErrSigningFailure", err)
	}

	// Challenge minted for link, checked for unlink
	linkEnv := buildRawChallenge(
		2, testServerKey, 0, 1, 900, 1200, true, testClientKey, 10, "link.cli.signet.dev auth",
	)
	err = verifyChallengeAt(linkEnv, testPassphrase, clientPub, spec.CliLinkPurposeUnlink, api.Discovery{}, now)
	if !errors.Is(err, exitcode.ErrSigningFailure) {
		t.Fatalf("got %v, want ErrSigningFailure", err)
	}
}

func TestVerifyChallenge_RejectsSigningKeyMismatch(t *testing.T) {
	clientPub := encodeAccountID(testClientKey)
	now := time.Unix(1000, 0)

	envelope := buildRawChallenge(
		2, testServerKey, 0, 1, 900, 1200, true, testClientKey, 10, "link.cli.signet.dev auth",
	)
	discovery := api.Discovery{
		SigningKey: "GDWUSKGGFDI4FRXK5EBTRECZSVQSSWJHHJOGH6JWG3AUMFFMQ435DIAG", // does not match testServerKey
	}
	err := verifyChallengeAt(envelope, testPassphrase, clientPub, spec.CliLinkPurposeLink, discovery, now)
	if !errors.Is(err, exitcode.ErrSigningFailure) {
		t.Fatalf("got %v, want ErrSigningFailure", err)
	}
}

func TestVerifyChallenge_RejectsMissingOrInvalidTimeBounds(t *testing.T) {
	clientPub := encodeAccountID(testClientKey)

	// No time bounds (PRECOND_NONE = 0)
	noTime := buildRawChallenge(
		2, testServerKey, 0, 0, 0, 0, true, testClientKey, 10, "link.cli.signet.dev auth",
	)
	err := verifyChallengeAt(noTime, testPassphrase, clientPub, spec.CliLinkPurposeLink, api.Discovery{}, time.Unix(1000, 0))
	if !errors.Is(err, exitcode.ErrSigningFailure) {
		t.Fatalf("expected failure for missing time bounds, got %v", err)
	}

	// Expired beyond the clock-skew grace (now = 1501, bounds = [900, 1200])
	expired := buildRawChallenge(
		2, testServerKey, 0, 1, 900, 1200, true, testClientKey, 10, "link.cli.signet.dev auth",
	)
	err = verifyChallengeAt(expired, testPassphrase, clientPub, spec.CliLinkPurposeLink, api.Discovery{}, time.Unix(1501, 0))
	if !errors.Is(err, exitcode.ErrSigningFailure) {
		t.Fatalf("expected failure for expired time bounds, got %v", err)
	}

	// Not yet valid beyond the clock-skew grace (now = 599, bounds = [900, 1200])
	future := buildRawChallenge(
		2, testServerKey, 0, 1, 900, 1200, true, testClientKey, 10, "link.cli.signet.dev auth",
	)
	err = verifyChallengeAt(future, testPassphrase, clientPub, spec.CliLinkPurposeLink, api.Discovery{}, time.Unix(599, 0))
	if !errors.Is(err, exitcode.ErrSigningFailure) {
		t.Fatalf("expected failure for future time bounds, got %v", err)
	}
}

func TestVerifyChallenge_AllowsClockSkewOnBothBounds(t *testing.T) {
	serverPub := encodeAccountID(testServerKey)
	clientPub := encodeAccountID(testClientKey)
	discovery := api.Discovery{NetworkPassphrase: testPassphrase, SigningKey: serverPub}
	envelope := buildRawChallenge(
		2, testServerKey, 0, 1, 900, 1200, true, testClientKey, 10, "link.cli.signet.dev auth",
	)

	cases := []struct {
		name string
		now  int64
		ok   bool
	}{
		// The server sets min_time to its own current second, so a client
		// clock a few seconds behind sees a challenge that is not valid yet.
		{"a few seconds before min_time", 897, true},
		{"at the start of the grace", 600, true},
		{"just before the grace", 599, false},
		{"a few seconds after max_time", 1203, true},
		{"at the end of the grace", 1500, true},
		{"just after the grace", 1501, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := verifyChallengeAt(envelope, testPassphrase, clientPub, spec.CliLinkPurposeLink, discovery, time.Unix(tc.now, 0))
			if tc.ok && err != nil {
				t.Fatalf("now=%d: expected the challenge to pass, got %v", tc.now, err)
			}
			if !tc.ok && !errors.Is(err, exitcode.ErrSigningFailure) {
				t.Fatalf("now=%d: expected a signing failure, got %v", tc.now, err)
			}
		})
	}
}

func TestVerifyChallenge_RejectsMainnetPassphraseWhenNetworkIsTestnet(t *testing.T) {
	clientPub := encodeAccountID(testClientKey)
	now := time.Unix(1000, 0)

	envelope := buildRawChallenge(
		2, testServerKey, 0, 1, 900, 1200, true, testClientKey, 10, "link.cli.signet.dev auth",
	)
	discovery := api.Discovery{
		NetworkPassphrase: testPassphrase, // testnet
	}
	// Mainnet passphrase passed into verify
	err := verifyChallengeAt(envelope, mainnetPassphrase, clientPub, spec.CliLinkPurposeLink, discovery, now)
	if !errors.Is(err, exitcode.ErrSigningFailure) {
		t.Fatalf("expected failure for mainnet passphrase on testnet, got %v", err)
	}
}
