package config

import "context"

type contextKey struct{}

// WithResolved attaches a Resolved configuration to ctx, for subcommands to
// read back via FromContext instead of re-resolving it themselves.
func WithResolved(ctx context.Context, r Resolved) context.Context {
	return context.WithValue(ctx, contextKey{}, r)
}

// FromContext retrieves the Resolved configuration the root command attached
// in its PersistentPreRunE. ok is false if nothing was ever set — that's a
// programmer error (every command runs through the root's PersistentPreRunE),
// not a runtime condition callers need to design around.
func FromContext(ctx context.Context) (r Resolved, ok bool) {
	r, ok = ctx.Value(contextKey{}).(Resolved)
	return r, ok
}
