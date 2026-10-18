package cmd

import (
	"sort"

	"github.com/spf13/cobra"

	"github.com/blockchain-maxis/signet/cli/internal/config"
	"github.com/blockchain-maxis/signet/cli/internal/keys"
)

func registerFlagCompletions(root *cobra.Command, base Deps) {
	completeIdentity := completeIdentitiesFunc(base)
	_ = root.RegisterFlagCompletionFunc("source", completeIdentity)
	_ = root.RegisterFlagCompletionFunc("sign-with-key", completeIdentity)
	_ = root.RegisterFlagCompletionFunc("context", completeContextsFunc)
	_ = root.RegisterFlagCompletionFunc("network", completeNetworksFunc)
}

func completeIdentitiesFunc(base Deps) func(*cobra.Command, []string, string) ([]string, cobra.ShellCompDirective) {
	return func(cmd *cobra.Command, _ []string, _ string) ([]string, cobra.ShellCompDirective) {
		binary := base.KeysBinary
		if d, err := depsFor(cmd); err == nil && d.KeysBinary != "" {
			binary = d.KeysBinary
		}
		names, err := keys.List(binary)
		if err != nil {
			return nil, cobra.ShellCompDirectiveNoFileComp
		}
		return names, cobra.ShellCompDirectiveNoFileComp
	}
}

func completeContextsFunc(_ *cobra.Command, _ []string, _ string) ([]string, cobra.ShellCompDirective) {
	f, err := config.Load()
	if err != nil || len(f.Contexts) == 0 {
		return nil, cobra.ShellCompDirectiveNoFileComp
	}
	names := make([]string, 0, len(f.Contexts))
	for name := range f.Contexts {
		names = append(names, name)
	}
	sort.Strings(names)
	return names, cobra.ShellCompDirectiveNoFileComp
}

func completeNetworksFunc(_ *cobra.Command, _ []string, _ string) ([]string, cobra.ShellCompDirective) {
	return []string{"testnet", "mainnet"}, cobra.ShellCompDirectiveNoFileComp
}
