# @signet/sandbox-ui

The `signet dev --ui` interface (#579): a static React app that ships inside
the `signet` binary, so it works offline with nothing to install. The CLI
serves it from 127.0.0.1 behind the locked-down server in
`cli/internal/devui` (#576) and its API (#577,
[`sandbox/protocol/devui-openapi.yaml`](../../sandbox/protocol/devui-openapi.yaml)).

```sh
pnpm --filter @signet/sandbox-ui build     # writes cli/internal/devui/dist/
(cd cli && go build ./cmd/signet)          # embeds it
signet dev <contract> --ui                 # serves it
```

A `signet` built without this step still compiles and serves a page saying
how to build the UI (`cli/internal/devui/dist-placeholder/`). The release
workflows build it before cross-compiling.

The page reads the run's token from the URL fragment the CLI opens, keeps it
for the tab, removes it from the address bar, and sends it as
`Authorization: Bearer`; it sets no cookies. The server's CSP allows only
same-origin files, no inline script and no inline style, so the app uses
Tailwind classes only (no `style` attributes).

It is a dense developer tool in `apps/web`'s palette and type: panels,
tables and monospace values. To work on it, build and restart
`signet dev --ui`; Vite's dev server cannot reach the API, which accepts only
its own `Host`.
