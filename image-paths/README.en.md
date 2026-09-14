English | [中文](README.md)

# dsh-image-paths

Renders a local image path written anywhere in the conversation as the picture
itself, right below the content that named it. Both halves are plain JavaScript —
no build step, no `node_modules`, nothing added to the DSH checkout.

## What it does

Write a workspace-relative image path — in your reply, in your thinking, or as
the output of a tool — and the image appears:

```markdown
改完了，对比图见 docs/1产品介绍/images/mobile软件.png
```

Everywhere an image path can show up in the transcript is scanned:

| Source | Example |
|---|---|
| The assistant's reply | `对比图见 outputs/run7/curve.png` |
| **The model's reasoning / thinking** | a path written while working the problem out |
| **Tool output** | a script that printed `saved logs/figures/sweep.png`, `ls`, `grep` results |
| Your own message | pasting a path instead of the file |
| Markdown image syntax and inline code | `![x](figure.png)`, `` `docs/x.png` `` |
| **A bare filename** | `retarget.png` with no directory — see below |

One gallery per **conversation step** — the assistant message and the tool
results it asked for — anchored at the last event that contributed, so the
gallery sits at the end of that step's content instead of drifting while the
step runs. A message *you* send gets its own gallery attached to that message,
so it stays put while the reply streams in below.

Click a thumbnail for the original (Escape, or a click anywhere, closes it). It
works retroactively: everything already in the loaded history gets its gallery,
not just new events. At most 8 images per gallery, and at most 20,000 characters
scanned per fragment, so a megabyte-sized tool log cannot slow the chat down.

## What it deliberately ignores

| Input | Why |
|---|---|
| `` ```fenced``` `` code blocks | transcripts and examples, not disclosures |
| `http(s)://…/x.png` | a remote image is not a local file |
| `~/…` paths | the route only serves files inside the session workspace |
| a path that does not resolve | the thumbnail removes itself instead of showing a broken image |

### Bare filenames

A name with no directory (`retarget.png`, the way a model usually refers to a
figure it just produced) is resolved by the host against the workspace:

- **exactly one file matches** → that file is shown;
- **several match** (the common case once a project keeps one directory per run)
  → the **newest** is shown, and the caption under the thumbnail names the file
  it actually resolved to (`retarget.png → outputs/run7/retarget.png`), so a
  wrong run's figure is visible as such rather than silently passed off;
- **nothing matches** → nothing is shown.

The lookup answers `200` with a verdict either way, so a name that resolves to
nothing leaves no failed request in the browser console. Results are cached per
workspace for 30 seconds, so a file that appears later is picked up.

Paths glued to Chinese prose work (`见docs/x.png`); inline code (`` `docs/x.png` ``)
and markdown image syntax (`![x](docs/x.png)`) are both mentions.

## What it looks like

![File chips and inline images](../docs/chips-and-inline-images.png)

The lower half of that capture is this plugin's work: an image path written in a
message renders as the image itself. (The file chip above it belongs to
`dsh-markdown-preview`.)

## How it is built

| Half | File | Role |
|---|---|---|
| Host | `index.js` | two read-only routes: `GET …/raw?path=…&cwd=…` serves one image file, and `GET …/resolve?name=…&cwd=…` turns a bare filename into the file it means (bounded, cached workspace walk) |
| Browser | `client.js` | a Conversation Definition, keyed per step (and per user message), plus the Chat node view that renders the thumbnails |

The node kind's own **length** is a load-bearing detail: the Chat view breaks
ties between nodes sharing an anchor sequence by comparing keys, a key is
`<kind.length>:<kind><id>`, and every shipped kind's key starts with a digit
below 5 — so the 50-character kind here is what makes the gallery land *below*
the message it belongs to rather than above it. Renaming it without keeping it
50 characters long silently reorders the gallery, which the test asserts.

Why a route instead of a durable session event: the shipped client can only read
image bytes through an **attachment referenced by a session event**, and an
out-of-tree event type is refused by the persistence read path unless the writer
marks it `ignorable: true` — which `Session.append` cannot set. Writing one
would leave the session log unreadable on the next load. This route carries the
bytes with no durable footprint, so nothing in the session format changes.

Placement is deliberate: the Definition anchors its node at the message's own
`seq`, and node keys sort as `"<kind length>:<kind><id>"`, so the 18-character
kind sorts after `14:assistant-step` and the gallery lands below the message.

## Access model

The route returns a file only when all of these hold: the path carries a
supported image extension (`.png/.jpg/.jpeg/.webp/.gif`), the extension's magic
bytes match the content, the file is a regular file of at most 32 MiB, and its
**real** path (symlinks resolved) lies inside the session workspace root the
client supplied. The `Host` header must name loopback
(`127.0.0.1`/`localhost`/`[::1]`) — the guard against DNS rebinding, since a
rebound name would otherwise look same-origin. Requests a browser marks as
cross-site are refused, so a page the user happens to visit cannot use the route
to probe local files. Non-browser callers (curl, tests) send none of those
headers and are trusted as loopback callers, the same trust the rest of the
local GUI assumes. A deployment that binds the GUI to a non-loopback interface
must widen `loopbackHost` in `index.js`.

The route also serves **SVG** (`image/svg+xml`), which is how architecture
diagrams usually leave their tool. An `<img>` never runs a script inside one, so
the element itself is what keeps SVG safe; the route checks the document really
starts with `<svg`/`<?xml`, and caps it at 8 MiB.

## Enable / disable

Two ways in. `../install.sh --link` does the first one for you.

**1. Copy (or symlink) the directory into the harness home and add one row** —
takes effect live, no `dsh web` restart:

```sh
cp -r image-paths ~/.dsh/plugins/dsh-image-paths
```

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: image-paths
      name: 'file:///home/<you>/.dsh/plugins/dsh-image-paths/index.js'
```

**2. Install it as a profile bundle** — the row then comes from this package's
own `cordis.patch.yml`, but the bundle list is read at boot, so this one needs a
`dsh web` restart:

```sh
dsh plugin --profile web add /path/to/dsh-plugins/image-paths
```

Do not do both: two active Loader sources for one package name is an error.

The `web` profile applies user patch edits live, so adding or removing the row
takes effect without restarting `dsh web`; a **page reload** is what loads or
drops the browser half. Removing the row is the whole off switch — the route and
the view both disappear together.

Verify from a shell, without the GUI token:

```sh
curl -sN --max-time 3 http://127.0.0.1:3080/plugins/events | grep -o '"id":"[^"]*"'   # roster, expect dsh-image-paths
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' \
  "http://127.0.0.1:3080/plugin/image-paths/raw?path=images/ecmaster-zero.png&cwd=$PWD"   # 200 image/png
```

## Changing the code

| Half | How a change takes effect |
|---|---|
| `client.js` | Just save it. The host stat-polls every served bundle (~500 ms) and pushes a reload frame, so an open page hot-swaps the plugin — no reload, no watcher process. |
| `index.js` | Bump the `?v=` in the row (the patch watcher applies it within a second), because Node caches ES modules per URL — re-inserting the same URL re-uses the already-loaded module. A `dsh web` restart also works. |

## Test

```sh
node test.mjs
```

Drives both halves without the harness: the browser bundle through its real
`__ModuleLoader__.load` handshake with a React stub (extraction, Definition
matching, node materialization, rendered `src`), and the host half against real
files (sniffing, containment, traversal and symlink refusal, cross-site and
rebound-host refusal).
