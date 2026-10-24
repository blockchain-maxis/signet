package simulator

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/blockchain-maxis/signet/cli/internal/exitcode"
)

const (
	// DefaultTimeout bounds one request (§4).
	DefaultTimeout = 10 * time.Second
	// DefaultIdleTimeout is how long a process may sit unused before it is
	// stopped to free the resident host state (§4).
	DefaultIdleTimeout = 5 * time.Minute
	// TimeoutEnv overrides DefaultTimeout; --timeout overrides it in turn.
	TimeoutEnv = "SIGNET_SIMULATOR_TIMEOUT"
)

// FetchFunc answers the simulator's ledger_fetch while a Call is in flight.
// It returns one Entry per key it was asked for; an Entry with a nil
// EntryXDR means the key does not exist on the network. An error wrapping
// exitcode.ErrTimeout or exitcode.ErrNetwork is reported to the simulator as
// such; any other error as a rejected fetch.
type FetchFunc func(keys []string) ([]Entry, error)

// Client is the one way the CLI talks to signet-simulator. It serialises
// calls (the simulator is single-threaded), answers ledger_fetch, enforces
// the per-request timeout by killing the process, and respawns transparently
// on the next call, replaying the session's setup so callers never see the
// restart.
type Client struct {
	path        string
	env         []string
	timeout     time.Duration
	idleTimeout time.Duration
	clock       Clock

	mu      sync.Mutex
	proc    *process
	ack     HelloAck
	nextID  uint64
	fetch   FetchFunc
	setup   []setupStep
	alias   map[string]string // caller-visible checkpoint id -> current process's id
	idle    Timer
	idleGen uint64
	closed  bool
}

// Option configures a Client.
type Option func(*Client)

// WithTimeout sets the per-request timeout, as --timeout does. It takes
// precedence over SIGNET_SIMULATOR_TIMEOUT.
func WithTimeout(d time.Duration) Option { return func(c *Client) { c.timeout = d } }

// WithIdleTimeout sets how long an unused process lives.
func WithIdleTimeout(d time.Duration) Option { return func(c *Client) { c.idleTimeout = d } }

// WithClock replaces the clock that schedules the idle stop.
func WithClock(clk Clock) Option { return func(c *Client) { c.clock = clk } }

// WithEnv adds KEY=VALUE pairs to the simulator's environment.
func WithEnv(env ...string) Option { return func(c *Client) { c.env = append(c.env, env...) } }

// ParseTimeout reads a timeout as a Go duration ("30s", "1m") or a whole
// number of seconds ("30").
func ParseTimeout(s string) (time.Duration, error) {
	s = strings.TrimSpace(s)
	if n, err := strconv.Atoi(s); err == nil {
		if n <= 0 {
			return 0, fmt.Errorf("timeout must be positive, got %q", s)
		}
		return time.Duration(n) * time.Second, nil
	}
	d, err := time.ParseDuration(s)
	if err != nil {
		return 0, fmt.Errorf("timeout %q is neither a duration (30s, 1m) nor a number of seconds", s)
	}
	if d <= 0 {
		return 0, fmt.Errorf("timeout must be positive, got %q", s)
	}
	return d, nil
}

// Start spawns the simulator at path and completes the handshake. A
// different protocol version, or anything but a valid hello_ack, is a
// *StartError carrying the note's exact message.
func Start(ctx context.Context, path string, opts ...Option) (*Client, error) {
	c := &Client{
		path:        path,
		timeout:     DefaultTimeout,
		idleTimeout: DefaultIdleTimeout,
		clock:       realClock{},
		alias:       map[string]string{},
	}
	if v := os.Getenv(TimeoutEnv); v != "" {
		d, err := ParseTimeout(v)
		if err != nil {
			return nil, fmt.Errorf("%w: %s: %v", exitcode.ErrConfiguration, TimeoutEnv, err)
		}
		c.timeout = d
	}
	for _, o := range opts {
		o(c)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.spawnLocked(ctx); err != nil {
		return nil, err
	}
	c.armIdleLocked()
	return c, nil
}

// HelloAck is what the running build reported in its handshake.
func (c *Client) HelloAck() HelloAck {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ack
}

// HandleFetch registers the handler for ledger_fetch requests.
func (c *Client) HandleFetch(f FetchFunc) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.fetch = f
}

// Call sends one request and decodes its result into result (which may be
// nil). A contract_error answer is returned as a value with a nil error: the
// call ran. A Go error is a simulator failure (*Error, wrapping
// exitcode.ErrSimulator), a *TimeoutError (wrapping exitcode.ErrTimeout), or
// the context ending.
func (c *Client) Call(ctx context.Context, typ string, params, result any) (*ContractError, error) {
	body, err := toFields(params)
	if err != nil {
		return nil, fmt.Errorf("encode %s params: %w", typ, err)
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil, &Error{Message: "the simulator client is closed"}
	}
	c.stopIdleLocked()
	defer c.armIdleLocked()

	if c.proc == nil || !c.proc.alive() {
		c.dropProcLocked()
		if err := c.spawnLocked(ctx); err != nil {
			return nil, err
		}
	}

	sent := body
	if typ == TypeLedgerRollback {
		sent = c.rewriteCheckpointLocked(body)
	}
	ce, raw, err := c.exchangeLocked(ctx, typ, sent)
	if err != nil || ce != nil {
		return ce, err
	}
	if result != nil {
		if err := json.Unmarshal(raw, result); err != nil {
			return nil, &Error{Message: fmt.Sprintf("could not decode the %s result: %v", typ, err)}
		}
	}
	c.recordLocked(typ, body, raw)
	return nil, nil
}

// Close shuts the simulator down. The Client cannot be used afterwards.
func (c *Client) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil
	}
	c.closed = true
	c.stopIdleLocked()
	if c.proc != nil {
		c.proc.shutdown()
		c.proc = nil
	}
	return nil
}

func (c *Client) spawnLocked(ctx context.Context) error {
	p, err := spawn(c.path, c.env)
	if err != nil {
		return &StartError{Cause: err}
	}
	ack, err := c.handshake(ctx, p)
	if err != nil {
		p.stop()
		return err
	}
	c.proc, c.ack = p, ack
	if err := c.replayLocked(ctx); err != nil {
		c.dropProcLocked()
		return err
	}
	return nil
}

func (c *Client) handshake(ctx context.Context, p *process) (HelloAck, error) {
	msg, _ := json.Marshal(map[string]any{
		"version": ProtocolVersion, "id": "hello", "type": TypeHello,
		"client_protocol_version": ProtocolVersion,
	})
	startErr := func(cause error) error {
		// Give a dying binary a moment so its last stderr lines are kept.
		p.waitExit(100 * time.Millisecond)
		return &StartError{Cause: cause, Stderr: p.stderr.Tail()}
	}
	// The write can fail if the binary exits at once; the read below then
	// reports it the same way.
	_ = p.write(msg)

	timer := time.NewTimer(c.timeout)
	defer timer.Stop()
	var l line
	select {
	case l = <-p.lines:
	case <-timer.C:
		return HelloAck{}, startErr(errors.New("no hello_ack before the timeout"))
	case <-ctx.Done():
		return HelloAck{}, ctxErr(ctx)
	}
	if l.err != nil {
		return HelloAck{}, startErr(fmt.Errorf("no hello_ack: %w", l.err))
	}
	var ack struct {
		Type string `json:"type"`
		HelloAck
	}
	if err := json.Unmarshal(l.data, &ack); err != nil {
		return HelloAck{}, startErr(fmt.Errorf("first line is not JSON: %w", err))
	}
	if ack.Type != TypeHelloAck {
		return HelloAck{}, startErr(fmt.Errorf("first line has type %q, not hello_ack", ack.Type))
	}
	if ack.ServerProtocolVersion == 0 {
		return HelloAck{}, startErr(errors.New("hello_ack has no server_protocol_version"))
	}
	if ack.ServerProtocolVersion != ProtocolVersion {
		return HelloAck{}, &StartError{Mismatch: true, Server: ack.ServerProtocolVersion}
	}
	return ack.HelloAck, nil
}

// exchangeLocked sends one request and waits for its answer, serving any
// ledger_fetch that arrives first. On a timeout, a cancelled context or a
// failure that leaves the process unusable, it stops the process and clears
// c.proc so the next Call respawns.
func (c *Client) exchangeLocked(ctx context.Context, typ string, body map[string]json.RawMessage) (*ContractError, json.RawMessage, error) {
	p := c.proc
	c.nextID++
	id := fmt.Sprintf("req-%d", c.nextID)
	msg, err := envelopeBytes(id, typ, body)
	if err != nil {
		return nil, nil, fmt.Errorf("encode %s: %w", typ, err)
	}

	timer := time.NewTimer(c.timeout)
	defer timer.Stop()

	// Writes go through a goroutine so a simulator that stops reading cannot
	// hold the request past its deadline; stopping the process unblocks it.
	writes := make(chan error, 1)
	go func() { writes <- p.write(msg) }()

	fail := func(e *Error) (*ContractError, json.RawMessage, error) {
		c.dropProcLocked()
		e.Stderr = p.stderr.Tail()
		return nil, nil, e
	}
	// fetches carries a FetchFunc's answer back into this loop.
	type fetched struct {
		id      string
		entries []Entry
		err     error
	}
	fetches := make(chan fetched)
	// done releases fetch goroutines whose answer nobody will read because
	// the request already ended.
	done := make(chan struct{})
	defer close(done)
	deliver := func(f fetched) {
		select {
		case fetches <- f:
		case <-done:
		}
	}

	for {
		select {
		case err := <-writes:
			if err != nil {
				p.waitExit(stopGrace)
				return fail(&Error{Message: fmt.Sprintf("could not send %s: the simulator %s", typ, p.exitDescription())})
			}

		case f := <-fetches:
			reply, err := fetchReply(f.id, f.entries, f.err)
			if err == nil {
				err = p.write(reply)
			}
			if err != nil {
				return fail(&Error{Message: fmt.Sprintf("could not answer ledger_fetch %s: %v", f.id, err)})
			}

		case l := <-p.lines:
			if l.err != nil {
				p.waitExit(stopGrace)
				if errors.Is(l.err, errLineTooLong) {
					return fail(&Error{Message: l.err.Error()})
				}
				return fail(&Error{Message: fmt.Sprintf("the simulator %s during %s", p.exitDescription(), typ)})
			}
			var env envelope
			if err := json.Unmarshal(l.data, &env); err != nil || env.Type == "" {
				return fail(&Error{Message: fmt.Sprintf("the simulator wrote a line that is not a protocol message: %s", clip(l.data))})
			}
			if env.Version != ProtocolVersion {
				return fail(&Error{Message: fmt.Sprintf("the simulator wrote a protocol %d message; this CLI speaks %d", env.Version, ProtocolVersion)})
			}

			if env.Type == TypeLedgerFetch && env.ID != nil {
				var req LedgerFetch
				if err := json.Unmarshal(l.data, &req); err != nil {
					return fail(&Error{Message: fmt.Sprintf("malformed ledger_fetch: %v", err)})
				}
				handler, fid := c.fetch, *env.ID
				go func() {
					if handler == nil {
						deliver(fetched{id: fid, err: errNoFetchHandler})
						return
					}
					entries, err := handler(req.KeysXDR)
					deliver(fetched{id: fid, entries: entries, err: err})
				}()
				continue
			}

			if env.ID == nil {
				// An error with a null id is the simulator giving up on the
				// whole process (internal_panic); it exits right after.
				if env.Type == TypeError {
					var em ErrorMessage
					_ = json.Unmarshal(l.data, &em)
					p.waitExit(stopGrace)
					return fail(&Error{Code: em.Code, Message: em.Message, Detail: em.Detail})
				}
				continue
			}
			if *env.ID != id {
				// A late answer to a request that already gave up; the
				// process it belonged to would have been stopped, so this
				// can only be noise. Ignore it.
				continue
			}

			switch env.Type {
			case TypeResult:
				return nil, l.data, nil
			case TypeContractError:
				var ce ContractError
				if err := json.Unmarshal(l.data, &ce); err != nil {
					return fail(&Error{Message: fmt.Sprintf("malformed contract_error: %v", err)})
				}
				return &ce, nil, nil
			case TypeError:
				var em ErrorMessage
				if err := json.Unmarshal(l.data, &em); err != nil {
					return fail(&Error{Message: fmt.Sprintf("malformed error: %v", err)})
				}
				// The process is still alive and answered; keep it.
				return nil, nil, &Error{Code: em.Code, Message: em.Message, Detail: em.Detail, Stderr: p.stderr.Tail()}
			default:
				return fail(&Error{Message: fmt.Sprintf("the simulator answered %s with a %q message", typ, env.Type)})
			}

		case <-timer.C:
			c.dropProcLocked()
			return nil, nil, &TimeoutError{Type: typ, Timeout: c.timeout}

		case <-ctx.Done():
			// No in-band cancel exists (§2), so the process has to go.
			c.dropProcLocked()
			return nil, nil, ctxErr(ctx)
		}
	}
}

// ctxErr maps a finished context onto the exit-code taxonomy.
func ctxErr(ctx context.Context) error {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return fmt.Errorf("%w: %w", exitcode.ErrTimeout, ctx.Err())
	}
	return fmt.Errorf("%w: %w", exitcode.ErrInterrupted, ctx.Err())
}

var errNoFetchHandler = errors.New("no ledger source is configured for this session")

// fetchReply is Go's answer to a ledger_fetch: ledger_entries, or an error
// with code fetch_failed when the handler could not answer.
func fetchReply(id string, entries []Entry, err error) ([]byte, error) {
	if err == nil {
		if entries == nil {
			entries = []Entry{}
		}
		return json.Marshal(map[string]any{
			"version": ProtocolVersion, "id": id, "type": TypeLedgerEntries, "entries": entries,
		})
	}
	kind := "rejected"
	switch {
	case errors.Is(err, exitcode.ErrTimeout):
		kind = "timeout"
	case errors.Is(err, exitcode.ErrNetwork):
		kind = "rpc_unavailable"
	}
	msg := err.Error()
	if msg == "" {
		msg = "fetch failed"
	}
	return json.Marshal(map[string]any{
		"version": ProtocolVersion, "id": id, "type": TypeError,
		"code": "fetch_failed", "message": msg, "detail": map[string]any{"kind": kind},
	})
}

// dropProcLocked stops the current process, if any, and forgets it.
func (c *Client) dropProcLocked() {
	if c.proc != nil {
		c.proc.stop()
		c.proc = nil
	}
}

func (c *Client) stopIdleLocked() {
	c.idleGen++
	if c.idle != nil {
		c.idle.Stop()
		c.idle = nil
	}
}

func (c *Client) armIdleLocked() {
	if c.closed || c.idleTimeout <= 0 {
		return
	}
	c.stopIdleLocked()
	gen := c.idleGen
	c.idle = c.clock.AfterFunc(c.idleTimeout, func() { c.idleStop(gen) })
}

// idleStop ends a process nobody has used for idleTimeout. The next Call
// respawns it and replays the session.
func (c *Client) idleStop(gen uint64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed || gen != c.idleGen || c.proc == nil {
		return
	}
	c.idle = nil
	c.proc.shutdown()
	c.proc = nil
}

// setupStep is one state-changing request, kept so a fresh process can be
// brought back to where the session was.
type setupStep struct {
	typ  string
	body map[string]json.RawMessage
	// checkpoint is the id the caller was given, for ledger_checkpoint.
	checkpoint string
}

// setupTypes are the requests that change simulator state a later request
// depends on. Everything else (simulate, the spec and XDR helpers, status)
// is either read-only or rebuilt on demand (fetched entries come back
// through ledger_fetch).
var setupTypes = map[string]bool{
	TypeLedgerOpen:       true,
	TypeLedgerPut:        true,
	TypeLedgerImport:     true,
	TypeContractInstall:  true,
	TypeContractSwap:     true,
	TypeLedgerCheckpoint: true,
	TypeLedgerRollback:   true,
}

func (c *Client) recordLocked(typ string, body map[string]json.RawMessage, result json.RawMessage) {
	if !setupTypes[typ] {
		return
	}
	step := setupStep{typ: typ, body: body}
	switch typ {
	case TypeLedgerOpen:
		// Opening resets the ledger, so nothing before it matters.
		c.setup = nil
		c.alias = map[string]string{}
	case TypeContractInstall:
		// Pin the id the simulator chose, so a replay installs at the same
		// address even if id assignment ever changes.
		if _, ok := body["contract_id"]; !ok {
			var r ContractInstallResult
			if json.Unmarshal(result, &r) == nil && r.ContractID != "" {
				step.body = withField(body, "contract_id", r.ContractID)
			}
		}
	case TypeLedgerCheckpoint:
		var r LedgerCheckpointResult
		if json.Unmarshal(result, &r) == nil {
			step.checkpoint = r.Checkpoint
			c.alias[r.Checkpoint] = r.Checkpoint
		}
	}
	c.setup = append(c.setup, step)
}

// rewriteCheckpointLocked maps a caller's checkpoint id to the one the
// current process knows it by; they differ only after a respawn.
func (c *Client) rewriteCheckpointLocked(body map[string]json.RawMessage) map[string]json.RawMessage {
	var cp string
	if json.Unmarshal(body["checkpoint"], &cp) != nil {
		return body
	}
	if cur, ok := c.alias[cp]; ok && cur != cp {
		return withField(body, "checkpoint", cur)
	}
	return body
}

// replayLocked brings a freshly spawned process back to the session's state.
func (c *Client) replayLocked(ctx context.Context) error {
	for _, step := range c.setup {
		body := step.body
		if step.typ == TypeLedgerRollback {
			body = c.rewriteCheckpointLocked(body)
		}
		ce, raw, err := c.exchangeLocked(ctx, step.typ, body)
		if err == nil && ce != nil {
			err = fmt.Errorf("%s was refused: %s", ce.Code, ce.Message)
		}
		if err != nil {
			var timeout *TimeoutError
			if errors.As(err, &timeout) || errors.Is(err, exitcode.ErrInterrupted) {
				return err
			}
			return &Error{Message: fmt.Sprintf("could not restore the session after restarting the simulator: replaying %s: %v", step.typ, err)}
		}
		if step.typ == TypeLedgerCheckpoint {
			var r LedgerCheckpointResult
			if json.Unmarshal(raw, &r) == nil {
				c.alias[step.checkpoint] = r.Checkpoint
			}
		}
	}
	return nil
}

func toFields(params any) (map[string]json.RawMessage, error) {
	if params == nil {
		return map[string]json.RawMessage{}, nil
	}
	b, err := json.Marshal(params)
	if err != nil {
		return nil, err
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, errors.New("params must encode to a JSON object")
	}
	if m == nil {
		m = map[string]json.RawMessage{}
	}
	for _, k := range []string{"version", "id", "type"} {
		if _, ok := m[k]; ok {
			return nil, fmt.Errorf("params must not set the envelope field %q", k)
		}
	}
	return m, nil
}

func withField(body map[string]json.RawMessage, key string, v any) map[string]json.RawMessage {
	out := make(map[string]json.RawMessage, len(body)+1)
	for k, val := range body {
		out[k] = val
	}
	out[key], _ = json.Marshal(v)
	return out
}

func envelopeBytes(id, typ string, body map[string]json.RawMessage) ([]byte, error) {
	m := withField(body, "version", ProtocolVersion)
	m["id"], _ = json.Marshal(id)
	m["type"], _ = json.Marshal(typ)
	return json.Marshal(m)
}

// clip quotes the start of a bad line for an error message.
func clip(b []byte) string {
	const limit = 200
	if len(b) > limit {
		return strconv.Quote(string(b[:limit])) + "…"
	}
	return strconv.Quote(string(b))
}
