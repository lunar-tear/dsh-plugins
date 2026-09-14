# dsh-markdown-preview

A Markdown preview that lives beside the conversation. A toggle in the session
header opens a right-hand drawer showing one workspace Markdown file, rendered
with the GUI's own renderer — so TeX/KaTeX math, fenced code with highlighting,
tables, task lists, footnotes and links behave exactly as they do in the chat —
and a document's **local images actually render**, which the chat renderer alone
cannot do.

Both halves are plain JavaScript. No build step, no `node_modules`, nothing
added to the DSH checkout.

## Using it

**Click the file.** Two ways, both landing in the panel:

- a **prose mention** — `docs/implementation_plan.md` written in the closing
  message — now opens the panel instead of the Host editor (see below);
- the **chips row** under a message that names Markdown files: `docs/` muted,
  `implementation_plan.md` bold. Only files the workspace confirms are offered,
  so a chip always opens something; a path the model quoted from another
  checkout stays out of the row instead of becoming a dead click.

The panel is built so the **document owns it**: it opens at **80% of the
viewport** (the frame keeps a strip beside it, and the width you drag is
remembered), and the file lists are an aside capped at **20% of the panel's
height**, scrolling inside that — so opening them never squeezes the Markdown
into a strip at the bottom. Opening the panel also **collapses the frame's own
right column** (the details panel): two panels fighting for the same edge leave
neither readable.

1. Or click the preview toggle in the session header (the panel-with-document
   icon beside the session utilities) — the panel opens on the right.
2. The file **follows the conversation**: every `.md` path the messages mention
   becomes a candidate, and the newest one that actually resolves is shown. So
   as you and the agent talk about `docs/design/overview.md`, it appears.
3. The dropdown in the drawer header offers:
   - **对话里提到过** — the paths mentioned in this conversation, newest first.
   - **工作区里的 Markdown** — the newest Markdown files in the workspace
     (bounded walk: at most 6 levels, 4000 entries, skipping dot-directories,
     `node_modules`/`dist`/`build`/`vendor`/`venv` and symlinks).
   - a text box for any workspace-relative path (`docs/design/overview.md`).
4. The drag grip on the left edge resizes the drawer (320–900 px). The 🔄
   button forces an immediate re-read; the drawer otherwise revalidates the
   file every 2.5 s and only re-renders when it changed.

## How it is built

| Half | File | Role |
|---|---|---|
| Host | `index.js` | three read-only routes: Markdown text, image bytes, workspace `.md` listing |
| Browser | `client.js` | a Conversation Definition that publishes the chips node and feeds the file list, a chat-node renderer for those chips, the header toggle, and the overlay drawer |

Rendering reuses `MarkdownText` from `@deepseek-ai/dsh-client-ui-primitives` —
the same component the chat uses — so this plugin owns no Markdown pipeline of
its own. Math, code highlighting and every other construct come from the shell.

The one gap it fills: that renderer accepts **absolute http(s) image URLs
only**, so a document's `![](figure.png)` would silently render as plain text.
The plugin rewrites each local destination to the host's image route, resolved
**relative to the document's own directory** (`docs/design/overview.md` +
`../img/a.png` → `docs/img/a.png`). Destinations it cannot serve — a `~` path, a
path escaping the workspace, an absolute path outside it — are left exactly as
authored, so the reader sees the original text or the alt label rather than a
broken image.

The chips node's kind is 50-59 characters long on purpose: the Chat view breaks
ties between nodes sharing an anchor sequence by comparing keys, a key is
`<kind.length>:<kind><id>`, and every shipped kind keys with a digit below 5 —
so that length is what puts the chips *below* the message that named the files.
The test asserts it.

Two placements matter, and both are the shipped extension points rather than
new seams: the toggle registers into `conversation.session.header.utilities`
(a session-scoped list slot, so it is mounted per session and reads that
session's workspace root from the sessions snapshot), and the drawer registers
into `shell.overlay` (a root-scoped list slot rendered in the frame's overlay
layer, additive beside the shipped entries). The conversation's own details
column is untouched.

## Access model

A file is served only when its **real** path (symlinks resolved) lies inside the
workspace root the caller named, the extension is on that route's allowlist
(`.md/.markdown/.mdown` for text, `.png/.jpg/.jpeg/.webp/.gif` for images), the
bytes agree with the extension, and the file is under the route's size cap
(2 MiB of Markdown, 32 MiB per image). The `Host` header must name loopback
(`127.0.0.1`/`localhost`/`[::1]`) — the guard against DNS rebinding — and
requests a browser marks as cross-site are refused. Non-browser callers send
neither header and are trusted as loopback callers, the same trust the rest of
the local GUI assumes. A deployment that binds the GUI to a non-loopback
interface must widen `loopbackHost` in `index.js`.

## Why prose mentions are *wrapped*, not replaced

The chat view asks the `chatFileMentions` service for one closing Turn's prose
vocabulary, and the shipped provider — `ui-deliverables` — links the files that
Turn's mutation tools touched, opening them in the Host editor. That is the
wrong verb for a plan document you want to read.

The honest seam would be to provide a second implementation, but Cordis refuses
it: `ctx.provide` throws when a service name is already registered. So this
plugin **wraps the existing provider's `forClosing`**: a Markdown path this
workspace has becomes a mention that opens the panel, and every other token is
handed to the original resolver unchanged (its answer is never overridden). The
wrapper is removed with the plugin, and it does nothing when the service is
absent or has a different shape.

If you would rather keep the editor as the click target everywhere, delete the
`installMentionInterception(ctx)` call at the end of `apply` in `client.js`; the
chips row keeps working.

## Enable / disable

Two ways in. `../install.sh --link` does the first one for you.

**1. Copy (or symlink) the directory into the harness home and add one row** —
takes effect live, no `dsh web` restart:

```sh
cp -r markdown-preview ~/.dsh/plugins/dsh-markdown-preview
```

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: markdown-preview
      name: 'file:///home/<you>/.dsh/plugins/dsh-markdown-preview/index.js'
```

**2. Install it as a profile bundle** — the row then comes from this package's
own `cordis.patch.yml`, but the bundle list is read at boot, so this one needs a
`dsh web` restart:

```sh
dsh plugin --profile web add /path/to/dsh-plugins/markdown-preview
```

Do not do both: two active Loader sources for one package name is an error.

The `web` profile applies user patch edits live, so adding or removing the row
takes effect without restarting `dsh web`; a **page reload** is what loads or
drops the browser half. Removing the row is the whole off switch — the toggle,
the drawer and all three routes disappear together.

Verify from a shell, without the GUI token:

```sh
curl -sN --max-time 3 http://127.0.0.1:3080/plugins/events | grep -o '"id":"[^"]*"'   # roster, expect dsh-markdown-preview
curl -s "http://127.0.0.1:3080/plugin/markdown-preview/file?path=README.md&cwd=$PWD" | head -3
curl -s "http://127.0.0.1:3080/plugin/markdown-preview/find?cwd=$PWD" | head -c 200
```

## Changing the code

| Half | How a change takes effect |
|---|---|
| `client.js` | Just save it. The host stat-polls every served bundle (~500 ms) and pushes a reload frame, so an open page hot-swaps the plugin — no reload, no watcher process. |
| `index.js` | Bump a `?v=` query on the row's URL (the patch watcher applies it within a second), because Node caches ES modules per URL — re-inserting the same URL re-uses the already-loaded module. A `dsh web` restart also works. |

## Test

```sh
node test.mjs
```

Drives both halves without the harness: the browser bundle through its real
`__ModuleLoader__.load` handshake with a React stub and a stubbed `fetch`
(mention extraction, document-relative resolution, image rewriting, plugin
state, `apply` registrations, the toggle, the drawer), and the host half against
real files (traversal and symlink refusal, the surface-op gate, ETag
revalidation, the bounded listing walk, cross-site and rebound-host refusal).
