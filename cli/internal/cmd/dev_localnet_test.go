package cmd

import (
	"strings"
	"testing"
)

func TestDevLocalnetFlagsGoTogether(t *testing.T) {
	for _, tc := range []struct {
		args []string
		want string
	}{
		{[]string{"dev", "--ci", "--localnet"}, "does not go with --ci"},
		{[]string{"dev", "--localnet-seed"}, "go with --localnet"},
		{[]string{"dev", "--localnet-bindings", "./bindings"}, "go with --localnet"},
		{[]string{"dev", "--localnet-limits", "unlimited"}, "go with --localnet"},
	} {
		isolateConfigDir(t)
		out, err := runSignet(t, tc.args...)
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("%v: err = %v, want %q\n%s", tc.args, err, tc.want, out)
		}
		if ExitCode(err) != 2 {
			t.Fatalf("%v: exit %d, want 2 (input error)", tc.args, ExitCode(err))
		}
	}
}
