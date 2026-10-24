package rpc

import (
	"context"
	"fmt"
	"strings"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
	"github.com/blockchain-maxis/signet/cli/internal/networkcheck"
)

// DefaultTestnetURL is SDF's public testnet RPC, the same default
// apps/web/lib/server/registry-read.ts uses. Mainnet has no bundled default:
// a public mainnet RPC is a choice the developer should make on purpose.
const DefaultTestnetURL = "https://soroban-testnet.stellar.org"

// Network is the network a sandbox command runs against.
type Network struct {
	// Name is the canonical name (testnet, mainnet, futurenet, local) or the
	// developer's own name for a custom network.
	Name       string
	Passphrase string
	RPCURL     string
}

// Selection is what the flags, environment and config file said.
type Selection struct {
	// Network is --network as resolved by the root (flag > SIGNET_NETWORK >
	// context > testnet).
	Network string
	// RPCURL is --rpc-url; ConfigRPCURL is the context's rpcUrl.
	RPCURL       string
	ConfigRPCURL string
	// Passphrase is --network-passphrase.
	Passphrase string
}

// Select turns a Selection into a Network: the passphrase from the known
// table (or --network-passphrase for a custom network), and the RPC URL from
// --rpc-url, then the config file's rpcUrl, then the testnet default.
func Select(s Selection) (Network, error) {
	name := strings.TrimSpace(s.Network)
	if name == "" {
		name = "testnet"
	}
	n := Network{Name: name}

	if canonical, known := networkcheck.Normalize(name); known {
		n.Name = canonical
		n.Passphrase, _ = networkcheck.PassphraseFor(canonical)
		if s.Passphrase != "" && s.Passphrase != n.Passphrase {
			return Network{}, fmt.Errorf("%w: --network-passphrase %q is not %s's passphrase (%q); drop it, or pick the network it belongs to",
				exitcode.ErrConfiguration, s.Passphrase, n.Name, n.Passphrase)
		}
	} else {
		if s.Passphrase == "" {
			return Network{}, fmt.Errorf("%w: %q is not a network signet knows (testnet, mainnet, futurenet, local); for a custom network pass --network-passphrase and --rpc-url",
				exitcode.ErrConfiguration, name)
		}
		n.Passphrase = s.Passphrase
	}

	switch {
	case s.RPCURL != "":
		n.RPCURL = s.RPCURL
	case s.ConfigRPCURL != "":
		n.RPCURL = s.ConfigRPCURL
	case n.Name == "testnet":
		n.RPCURL = DefaultTestnetURL
	default:
		return Network{}, fmt.Errorf("%w: %s has no default RPC URL; pass --rpc-url, or save one with `signet config set rpc-url <url>`",
			exitcode.ErrConfiguration, n.Name)
	}
	return n, nil
}

// PassphraseMismatchError is an RPC serving a different network from the one
// selected. Without this check, testnet state could be forked and labelled
// mainnet.
type PassphraseMismatchError struct {
	Selected Network
	Served   string
}

func (e *PassphraseMismatchError) Error() string {
	served := fmt.Sprintf("%q", e.Served)
	if name, ok := networkcheck.NameFor(e.Served); ok {
		served = name + " (" + served + ")"
	}
	return fmt.Sprintf("the RPC at %s serves %s, but %s (%q) is selected — point --rpc-url at a %s RPC, or select the network it serves",
		e.Selected.RPCURL, served, e.Selected.Name, e.Selected.Passphrase, e.Selected.Name)
}

func (e *PassphraseMismatchError) Unwrap() error { return exitcode.ErrConfiguration }

// Connect returns a client for n's RPC after checking, with getNetwork, that
// it serves n's passphrase.
func Connect(ctx context.Context, n Network, opts ...Option) (*Client, NetworkInfo, error) {
	c := New(n.RPCURL, opts...)
	info, err := c.GetNetwork(ctx)
	if err != nil {
		return nil, NetworkInfo{}, err
	}
	if info.Passphrase != n.Passphrase {
		return nil, NetworkInfo{}, &PassphraseMismatchError{Selected: n, Served: info.Passphrase}
	}
	return c, info, nil
}
