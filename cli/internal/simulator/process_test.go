package simulator

import (
	"bufio"
	"bytes"
	"errors"
	"io"
	"strings"
	"testing"
)

func TestReadLine(t *testing.T) {
	cases := []struct {
		name    string
		input   []byte
		want    string
		wantErr error
	}{
		{
			name:  "normal line",
			input: []byte("hello\nsecond\n"),
			want:  "hello",
		},
		{
			name:  "crlf line",
			input: []byte("hello\r\n"),
			want:  "hello",
		},
		{
			name:  "longer than default 4KiB bufio buffer across chunks",
			input: append(bytes.Repeat([]byte("a"), 100<<10), '\n'),
			want:  strings.Repeat("a", 100<<10),
		},
		{
			name:    "over maxLineBytes",
			input:   append(bytes.Repeat([]byte("x"), maxLineBytes+2), '\n'),
			wantErr: errLineTooLong,
		},
		{
			name:  "last line without newline",
			input: []byte("final-line"),
			want:  "final-line",
		},
		{
			name:  "last line without newline but trailing cr",
			input: []byte("final-line\r"),
			want:  "final-line",
		},
		{
			name:    "empty stream",
			input:   nil,
			wantErr: io.EOF,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			br := bufio.NewReaderSize(bytes.NewReader(tc.input), 4096)
			got, err := readLine(br)
			if tc.wantErr != nil {
				if !errors.Is(err, tc.wantErr) {
					t.Fatalf("err = %v, want %v", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if string(got) != tc.want {
				t.Fatalf("len(got)=%d want %d (first 32=%q)", len(got), len(tc.want), string(got[:min(32, len(got))]))
			}
		})
	}
}

func TestTailBuffer(t *testing.T) {
	t.Run("split writes mid-line and trim cr", func(t *testing.T) {
		tb := newTailBuffer(5)
		_, _ = tb.Write([]byte("hel"))
		_, _ = tb.Write([]byte("lo\r\nwor"))
		_, _ = tb.Write([]byte("ld\n"))
		got := tb.Tail()
		if len(got) != 2 || got[0] != "hello" || got[1] != "world" {
			t.Fatalf("Tail() = %#v", got)
		}
	})

	t.Run("more than n lines keeps newest n", func(t *testing.T) {
		tb := newTailBuffer(3)
		for _, line := range []string{"l1", "l2", "l3", "l4", "l5"} {
			_, _ = tb.Write([]byte(line + "\n"))
		}
		got := tb.Tail()
		want := []string{"l3", "l4", "l5"}
		if len(got) != len(want) {
			t.Fatalf("Tail() = %#v, want %#v", got, want)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("Tail()[%d] = %q, want %q", i, got[i], want[i])
			}
		}
	})

	t.Run("unterminated line included in Tail", func(t *testing.T) {
		tb := newTailBuffer(2)
		_, _ = tb.Write([]byte("one\ntwo\npartial"))
		got := tb.Tail()
		if len(got) != 2 || got[0] != "two" || got[1] != "partial" {
			t.Fatalf("Tail() = %#v", got)
		}
	})

	t.Run("over 64KiB unterminated write is bounded", func(t *testing.T) {
		tb := newTailBuffer(5)
		big := bytes.Repeat([]byte("z"), (64<<10)+100)
		_, _ = tb.Write(big)
		if len(tb.partial) != 0 {
			t.Fatalf("expected partial buffer flushed, got %d bytes", len(tb.partial))
		}
		got := tb.Tail()
		if len(got) != 1 || len(got[0]) != len(big) {
			t.Fatalf("Tail() len=%d item0len=%d", len(got), len(got[0]))
		}
	})
}
