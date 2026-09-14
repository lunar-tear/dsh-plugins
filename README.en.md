English | [中文](README.md)

# dsh-plugins

Two out-of-tree plugins for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(`dsh`) web GUI, plus the install tooling and the notes that make third-party
plugins possible at all.

They are plain JavaScript: **no build step, no `node_modules`, no fork of the
harness.** Each plugin is one package with a host half and a browser half, and
both halves are loaded from where they sit on disk.

| Plugin | What it does |
|---|---|
| [`image-paths`](image-paths/README.md) | An image path written in a chat message renders as the image itself, right under that message — no attachment commits, no session-log writes. |
| [`markdown-preview`](markdown-preview/README.md) | A Markdown preview drawer beside the conversation: the shell's own renderer (TeX/KaTeX, code highlighting, tables, task lists, footnotes) plus a document's local images, following whichever `.md` the conversation is talking about. |

Both were built and verified against a live `dsh web` (profile `web`), including
hot-activation without restarting the server.

## What it looks like

A message that names a `.md` gets a row of clickable chips under it (directory
muted, file name bold), and an image path this workspace really has renders as
the image:

![File chips and inline images](docs/chips-and-inline-images.png)

Clicking a chip (or opening a `?preview=` link) renders the document in the panel
on the right, with the shell's own Markdown renderer — maths, code highlighting,
tables and footnotes exactly as in the chat, plus the document's own local
images:

![The Markdown preview panel](docs/preview-panel.png)

Both are captures of the real GUI: the document is `logs/dsh-preview-demo.md` in
the workspace, the image is the repository's own `images/ecmaster-zero.png`.

## Install

```sh
git clone https://github.com/<you>/dsh-plugins
cd dsh-plugins
./install.sh              # copy into ~/.dsh/plugins and register the profile rows
# or ./install.sh --link  # symlink instead, so edits in this repo are live
```

Then **reload the GUI page** once: the host halves are mounted the moment the
profile patch changes, but the browser halves are part of the page's module
graph, so a reload is what loads (or drops) them.

`./install.sh --uninstall` removes the plugin directories and the rows it
wrote, restoring `[]` (or your own entries) in the patch layer.

The script is idempotent and replaces the patch file **atomically** — the
running server watches that file and rejects a partially written patch, so a
naive in-place edit can leave a plugin half-registered.

### The other install route

Each plugin also declares `dsh.bundle`, so it can be installed as a profile
layer the supported way:

```sh
dsh plugin --profile web add /path/to/dsh-plugins/image-paths
```

That path is cleaner for distribution but writes to `dsh.profile.bundles`,
which is read at boot — so it needs a `dsh web` restart, where `install.sh`
takes effect live. Do not use both for the same plugin: two active Loader
sources for one package name is an error.

## Is there a plugin marketplace?

**No.** There is no registry, store or plugin index in `dsh` — no
`dsh plugin search`, no catalog page, and nothing in the repo's docs beyond the
"package and install a plugin" tutorial. The distribution model is:

| Unit | Declares | Installed by |
|---|---|---|
| a plain package | nothing special — a library other plugins import | `dsh plugin --profile <p> add <spec>` (a pnpm forwarder) |
| a **bundle** | `dsh.bundle.patch` → its own `cordis.patch.yml` layer | `dsh plugin … add <spec>`, which also appends it to `dsh.profile.bundles` |
| a **client plugin row** | `dsh.client` + an `exports["./client"]` bundle | any enabled Loader row, wherever the row's specifier resolves from |

`<spec>` is anything pnpm accepts — a registry name, a git URL, a tarball, a
local path. So "publishing" a plugin today means putting the package somewhere
pnpm can fetch it (npm, or a git repo like this one) and telling people the row
to add. This repository is therefore a marketplace only in the sense of "a git
repo you can install from".

## What makes an out-of-tree plugin work

The pieces below are what this repo needed to discover; they are the reason the
plugins here look the way they do.

**Packaging.** One package per plugin, `type: module`, with `exports` giving
`"."` (host half) and `"./client"` (browser half) and a `dsh.client` manifest
naming `platform: "web"`. The harness resolves the row's specifier, walks up to
the nearest `package.json`, and serves that package's `./client` file to the
browser. A row specifier may be a `file://` URL, which is what lets a plugin be
loaded from a directory that no `node_modules` knows about.

**The browser bundle format.** The shell does not run your TypeScript; it loads
a CJS factory wrapped in the module loader's handshake:

```js
window.__ModuleLoader__.load({ id: '<package name>', factory: (require) => {
  var module = { exports: {} }; var exports = module.exports
  // ... bundle body; require() resolves against the shell's frozen module table
  return module.exports
} })
```

The module table seeds only `react`, `react/jsx-runtime`, `react-dom`,
`react-dom/client`, `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-store`,
`@deepseek-ai/dsh-client-ui-slots` and
`@deepseek-ai/dsh-client-ui-primitives` — so a hand-written bundle can use
React, the store, the slot registry and the UI primitives (including the
Markdown renderer) without any build pipeline. Anything else must be inlined or
reached through a Cordis service.

**Where plugin UI can appear.** The usable seats for a third-party row are the
shipped slots: `conversation.chat.node` (keyed renderers for your own
Conversation node kind), `conversation.session.header.utilities` and
`…header.actions` (session-scoped list seats), `shell.overlay` (a root-scoped
list seat inside the frame's overlay layer — the one a side panel or drawer
should use), plus the tool/attachment/settings seats. The conversation's
`details` column and the sidebar take a single occupant each, so a plugin
cannot add a tab there.

**Live activation.** A profile with `patchReload: live` (the shipped `web`
profile) watches its user patch layer and re-composes without a restart, so a
row added to `~/.dsh/profiles/web/cordis.patch.yml` mounts within a second. The
browser half still needs a page reload — the HMR receiver deliberately ignores
graph changes, because the boot graph is the initial-load record. Editing an
*already loaded* `lib/client.js` is different: the host stat-polls served
bundles and pushes a rebuild frame, so that hot-swaps with no reload at all.

**The host half is not hot.** Node caches ES modules per URL, so re-applying a
row with the same specifier re-uses the module it already imported — a changed
`index.js` needs a fresh URL (a `?v=` query on the row, applied by the same
patch watcher) or a server restart. Both plugins' READMEs say so.

**Reading files without inventing new seams.** Two tempting approaches do not
work for a third-party plugin and are worth knowing before you try them:

- *Attachments.* The browser can only read image bytes through an attachment
  that a **session event references**, and the endpoint that serves it checks
  the session log for that reference.
- *Your own session event.* Appending a custom event type makes the session log
  unreadable: the persistence read path refuses any type outside the harness's
  known vocabulary unless the writer marked it `ignorable: true`, and
  `Session.append` cannot set that marker. It would poison the log on the next
  load.

So both plugins serve bytes over a small read-only HTTP route registered on the
host (`ctx.webServer.register`) and do their rendering client-side from the
messages that are already in the log. That keeps the session format untouched
and works retroactively for history. The routes enforce the same guard set:
loopback `Host` only, same-origin for browser callers, real-path containment
inside the caller's workspace, an extension allowlist, magic-byte agreement, and
a size cap.

## Requirements

- A `dsh` install whose web profile you can patch (`~/.dsh/profiles/web`).
- The web GUI over loopback (both plugins refuse non-loopback `Host` headers and
  cross-site requests; a LAN-bound deployment must widen `loopbackHost` in each
  `index.js`).
- Node 22+ to run the tests.

## Tests

Each plugin ships a `test.mjs` that needs no harness, no browser and no network:

```sh
node image-paths/test.mjs
node markdown-preview/test.mjs
```

They drive the browser halves through the real `__ModuleLoader__.load`
handshake with a React stub and a stubbed `fetch`, and the host halves against
real temporary files — including the refusals (parent traversal, symlink escape,
cross-site, DNS-rebinding, non-image bytes, oversized files, …).

## License

No license file yet — the code is yours to license as you like. The harness it
targets is MIT.
