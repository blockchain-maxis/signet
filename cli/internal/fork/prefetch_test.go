package fork

import (
	"reflect"
	"testing"
)

func TestPrefetchRemembersEachFunctionsMissesAcrossForks(t *testing.T) {
	root := t.TempDir()
	const pass, contract = "Test SDF Network ; September 2015", "CABC"
	if keys, err := PrefetchKeys(root, pass, contract, "claim"); err != nil || len(keys) != 0 {
		t.Fatalf("nothing remembered yet: %v %v", keys, err)
	}
	if err := RememberMisses(root, pass, contract, "claim", []string{"k2", "k1"}); err != nil {
		t.Fatal(err)
	}
	if err := RememberMisses(root, pass, contract, "claim", []string{"k1", "k3"}); err != nil {
		t.Fatal(err)
	}
	if err := RememberMisses(root, pass, contract, "count", []string{"k9"}); err != nil {
		t.Fatal(err)
	}
	if keys, _ := PrefetchKeys(root, pass, contract, "claim"); !reflect.DeepEqual(keys, []string{"k1", "k2", "k3"}) {
		t.Fatalf("claim = %v, want the union, sorted", keys)
	}
	if keys, _ := PrefetchKeys(root, pass, contract, "count"); !reflect.DeepEqual(keys, []string{"k9"}) {
		t.Fatalf("count = %v", keys)
	}
	if keys, _ := PrefetchKeys(root, "another network", contract, "claim"); len(keys) != 0 {
		t.Fatalf("per network: %v", keys)
	}
	// The memory sits beside the forks and is not one.
	if forks, err := List(root); err != nil || len(forks) != 0 {
		t.Fatalf("listed as a fork: %v %v", forks, err)
	}
}
