package cmd

import (
	"time"

	"github.com/blockchain-maxis/signet/cli/internal/link"
)

const testnetSigningKey = "GBWMCCC3NHSKLAOJDBKKYW7SSH2PFTTNVFKWSGLWGDLEBKLOVP5JLBBP"

func testChallengeFor(purpose, clientKey string) string {
	now := uint64(time.Now().Unix())
	ch, err := link.BuildTestChallenge(
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
