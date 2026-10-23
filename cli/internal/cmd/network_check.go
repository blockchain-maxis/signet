package cmd

import (
	"context"
	"errors"
	"net/http"

	"github.com/blockchain-maxis/signet/cli/internal/api"
	"github.com/blockchain-maxis/signet/cli/internal/networkcheck"
	"github.com/blockchain-maxis/signet/cli/internal/output"
	"github.com/blockchain-maxis/signet/cli/internal/redact"
)

// checkDeploymentNetwork is the first request link and unlink make (#618):
// read the deployment's stellar.toml and refuse, with exit 3, a network it
// does not serve — before an identity is resolved or a pairing is opened.
//
// A deployment that predates the document (404) is not refused: the server
// still checks the network at pair/start (#616), so the run goes on with a
// note. Any other failure to discover is returned as is — a deployment that
// cannot serve a static document will not serve the rest of the flow either.
func checkDeploymentNetwork(ctx context.Context, client *api.Client, requested string, printer *output.Printer) error {
	deployment, err := client.Discover(ctx)
	if err != nil {
		var apiErr *api.Error
		if errors.As(err, &apiErr) && apiErr.Status == http.StatusNotFound {
			printer.Diagnostic("note: " + redact.Secrets(client.BaseURL()) +
				" publishes no stellar.toml, so its network is checked when pairing starts instead")
			return nil
		}
		return err
	}
	return networkcheck.Compare(requested, deployment)
}
