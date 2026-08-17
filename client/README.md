# Client UI (scaffold)

This directory is a **reference scaffold** for the optional session UI — a
toggle in the session header plus a status line under the composer. It is not
a built bundle and is not wired into the Host plugin yet.

## Why it is a scaffold, not a package

The Host half (`../lib/index.js`) ships as a pure ESM module with **no build
step**. A browser UI cannot do the same: the harness serves Client plugins as
pre-built bundles discovered through a package's `dsh.client` declaration and
`exports["./client"]`. Building that bundle requires the DeepSeek Harness
client toolchain (`tsdown` + the client bundler), which lives in the harness
monorepo.

Two integration steps remain before this UI can ship:

1. **Client↔Host RPC.** The dynamic-plugin prototype used `host.call`. A real
   package uses a Typert `@Remote` instead:
   - Host: add a service with `@Remote('getState')` / `@Remote('setEnabled')`
     methods (replacing the `commands`/`tools` control surface, or in addition
     to it), so Typert generates a `/remote` artifact.
   - Client: `import { autoRecoverRemote } from 'dsh-auto-recover/remote'`,
     then `ctx.remote.$mount(autoRecoverRemote)` and call
     `ctx.remote.autoRecover.getState(...)`.

2. **Packaging.** Either add `dsh.client` + `exports["./client"]` to this
   package pointing at the built bundle, or split into a companion
   `dsh-auto-recover-client` package (the harness convention).

## Reference UI

`index.tsx` shows the intended React components and Slot registrations,
mirroring the dynamic prototype:

- `conversation.session.header.utilities` — the enable/disable toggle.
- `conversation.composer.dock` — the status line ("已被 … 限额，预计 … 恢复").

The `host.call(...)` calls in the reference are the lines to replace with
`ctx.remote.autoRecover.*` after step 1 above.
