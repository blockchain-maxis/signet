//go:build !windows

package dev

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestCancellingABuildLeavesNoProcessBehind(t *testing.T) {
	b := testBuilder(t)
	pidFile := filepath.Join(t.TempDir(), "pids")
	t.Setenv("FAKESTELLAR_BUILD", "slow")
	t.Setenv("FAKESTELLAR_PID_FILE", pidFile)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := b.Build(ctx)
		done <- err
	}()
	var pids []int
	deadline := time.Now().Add(20 * time.Second)
	for len(pids) < 2 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
		raw, _ := os.ReadFile(pidFile)
		pids = pids[:0]
		for _, f := range strings.Fields(string(raw)) {
			if n, err := strconv.Atoi(f); err == nil {
				pids = append(pids, n)
			}
		}
	}
	if len(pids) < 2 {
		t.Fatal("the slow build never started its child")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("err = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a cancelled build did not return")
	}
	// The build and the process it started are both gone, reaped.
	for _, pid := range pids {
		gone := false
		for i := 0; i < 100 && !gone; i++ {
			gone = errors.Is(syscall.Kill(pid, 0), syscall.ESRCH)
			if !gone {
				time.Sleep(20 * time.Millisecond)
			}
		}
		if !gone {
			t.Errorf("process %d outlived the cancelled build", pid)
		}
	}
}
