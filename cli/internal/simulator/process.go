package simulator

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"sync"
	"time"
)

const (
	// maxLineBytes is §2's 64 MiB line limit, plus room for the envelope
	// around a payload that is exactly at it.
	maxLineBytes = 64<<20 + 4096
	// stderrTailLines is how much of the simulator's stderr a failure carries.
	stderrTailLines = 50
	// stopGrace is §4's wait between SIGTERM and SIGKILL.
	stopGrace = 2 * time.Second
)

// errLineTooLong is a stdout line over maxLineBytes.
var errLineTooLong = errors.New("the simulator wrote a line longer than the 64 MiB limit")

// line is one stdout line, or the error that ended the stream (io.EOF when
// the process closed stdout).
type line struct {
	data []byte
	err  error
}

// process is one running signet-simulator. Everything about it dies with it:
// a Client replaces the whole value on respawn.
type process struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stderr *tailBuffer

	lines chan line
	// quit tells the reader to stop delivering lines.
	quit     chan struct{}
	quitOnce sync.Once
	// exited is closed once cmd.Wait has returned; exitErr is valid after.
	exited  chan struct{}
	exitErr error
}

func spawn(path string, env []string) (*process, error) {
	cmd := exec.Command(path)
	if len(env) > 0 {
		cmd.Env = append(os.Environ(), env...)
	}
	p := &process{
		cmd:    cmd,
		stderr: newTailBuffer(stderrTailLines),
		lines:  make(chan line, 16),
		quit:   make(chan struct{}),
		exited: make(chan struct{}),
	}
	cmd.Stderr = p.stderr
	// A grandchild holding stderr open must not keep Wait (and so this
	// process's goroutines) alive after the simulator itself has gone.
	cmd.WaitDelay = stopGrace

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	p.stdin = stdin

	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		p.read(stdout)
	}()
	go func() {
		// Every read from stdout must finish before Wait closes the pipe.
		<-readerDone
		p.exitErr = cmd.Wait()
		close(p.exited)
	}()
	return p, nil
}

// read delivers stdout one line at a time until EOF, an oversized line, or
// quit.
func (p *process) read(stdout io.Reader) {
	br := bufio.NewReaderSize(stdout, 64<<10)
	for {
		data, err := readLine(br)
		if err != nil {
			select {
			case p.lines <- line{err: err}:
			case <-p.quit:
			}
			if errors.Is(err, errLineTooLong) {
				// Keep draining so the process is not blocked on a full
				// pipe while it is being stopped.
				_, _ = io.Copy(io.Discard, br)
			}
			return
		}
		select {
		case p.lines <- line{data: data}:
		case <-p.quit:
			_, _ = io.Copy(io.Discard, br)
			return
		}
	}
}

func readLine(br *bufio.Reader) ([]byte, error) {
	var buf []byte
	for {
		chunk, err := br.ReadSlice('\n')
		if len(buf)+len(chunk) > maxLineBytes {
			return nil, errLineTooLong
		}
		buf = append(buf, chunk...)
		switch {
		case err == nil:
			return bytes.TrimRight(buf, "\r\n"), nil
		case errors.Is(err, bufio.ErrBufferFull):
			continue
		case errors.Is(err, io.EOF) && len(buf) > 0:
			// A last line without a newline still counts.
			return buf, nil
		default:
			return nil, err
		}
	}
}

// write sends one message as a line.
func (p *process) write(msg []byte) error {
	_, err := p.stdin.Write(append(msg, '\n'))
	return err
}

func (p *process) alive() bool {
	select {
	case <-p.exited:
		return false
	default:
		return true
	}
}

// waitExit waits up to d for the process to exit on its own.
func (p *process) waitExit(d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-p.exited:
		return true
	case <-t.C:
		return false
	}
}

// stop is §4's sequence: SIGTERM, a grace period, then SIGKILL. It returns
// once the process has exited and its goroutines are done.
func (p *process) stop() {
	p.quitOnce.Do(func() { close(p.quit) })
	_ = p.stdin.Close()
	if !p.alive() {
		return
	}
	_ = askToStop(p.cmd.Process)
	if p.waitExit(stopGrace) {
		return
	}
	_ = p.cmd.Process.Kill()
	<-p.exited
}

// shutdown asks the simulator to exit with a `shutdown` message and falls
// back to stop if it does not.
func (p *process) shutdown() {
	if p.alive() {
		msg, _ := json.Marshal(map[string]any{"version": ProtocolVersion, "id": "bye", "type": TypeShutdown})
		if p.write(msg) == nil {
			_ = p.stdin.Close()
			if p.waitExit(stopGrace) {
				p.quitOnce.Do(func() { close(p.quit) })
				return
			}
		}
	}
	p.stop()
}

// exitDescription says how the process ended, for an error message.
func (p *process) exitDescription() string {
	if !p.alive() {
		if p.exitErr == nil {
			return "exited with status 0"
		}
		var ee *exec.ExitError
		if errors.As(p.exitErr, &ee) {
			return ee.String()
		}
		return p.exitErr.Error()
	}
	return "stopped answering"
}

// tailBuffer keeps the last n lines written to it.
type tailBuffer struct {
	mu      sync.Mutex
	n       int
	lines   []string
	partial []byte
}

func newTailBuffer(n int) *tailBuffer { return &tailBuffer{n: n} }

func (t *tailBuffer) Write(b []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.partial = append(t.partial, b...)
	for {
		i := bytes.IndexByte(t.partial, '\n')
		if i < 0 {
			break
		}
		t.push(string(bytes.TrimRight(t.partial[:i], "\r")))
		t.partial = t.partial[i+1:]
	}
	// Bound an unterminated line too, so a process spewing without newlines
	// cannot grow this without limit.
	if len(t.partial) > 64<<10 {
		t.push(string(t.partial))
		t.partial = nil
	}
	return len(b), nil
}

func (t *tailBuffer) push(s string) {
	t.lines = append(t.lines, s)
	if len(t.lines) > t.n {
		t.lines = t.lines[len(t.lines)-t.n:]
	}
}

// Tail returns the kept lines, oldest first, including an unterminated
// last line.
func (t *tailBuffer) Tail() []string {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := append([]string(nil), t.lines...)
	if len(t.partial) > 0 {
		out = append(out, string(t.partial))
		if len(out) > t.n {
			out = out[len(out)-t.n:]
		}
	}
	return out
}
