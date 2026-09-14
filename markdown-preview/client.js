/**
 * dsh-markdown-preview — browser half.
 *
 * A Markdown preview that lives beside the conversation: a toggle in the
 * session header opens a right-hand drawer (registered into the frame's
 * `shell.overlay` seat) that renders one workspace Markdown file.
 *
 * Rendering is the shell's own renderer — `MarkdownText` from
 * `@deepseek-ai/dsh-client-ui-primitives` — so TeX/KaTeX math, fenced code
 * with highlighting, tables, task lists and footnotes all behave exactly like
 * they do in the chat. The one thing it cannot do is display a local image
 * (its image rule accepts absolute http(s) only), so this plugin rewrites a
 * document's local image destinations to the host route that serves them.
 *
 * The file to preview follows the conversation by default: a state-only
 * Conversation Definition collects every `.md` path the messages mention, and
 * the newest one that actually resolves is what the drawer shows.
 *
 * Hand-written bundle in the layout the client module system expects:
 * `window.__ModuleLoader__.load({ id, factory })` registering a lazy CJS
 * factory whose `require` resolves against the shell's frozen module table.
 */
window.__ModuleLoader__.load({ id: "dsh-markdown-preview", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;

var React = require("react")
var primitives = require("@deepseek-ai/dsh-client-ui-primitives")
var MarkdownText = primitives.MarkdownText
var IconBrowseOutline16 = primitives.IconBrowseOutline16
var IconCloseOutline16 = primitives.IconCloseOutline16
var IconRefreshOutline16 = primitives.IconRefreshOutline16
var IconChevronDownOutline14 = primitives.IconChevronDownOutline14

var h = React.createElement
var useState = React.useState
var useEffect = React.useEffect
var useMemo = React.useMemo

/** Locale namespace owned by this plugin. */
var NS = "markdown-preview"
/**
 * Chat node kind for the file chips. Like the image gallery's kind, its length
 * is load-bearing: the Chat view breaks ties between nodes sharing an anchor
 * sequence by comparing keys, a key is `<kind.length>:<kind><id>`, and every
 * shipped kind keys with a digit below 5 — so this 50-character name is what
 * puts the chips *below* the message that named the files: the kind must stay
 * 50-59 characters long (so its key starts with "5"), and the test asserts it.
 */
var KIND = "markdown-preview-file-chips-under-the-message-block"
/** Routes served by the host half. */
var FILE_ROUTE = "/plugin/markdown-preview/file"
var IMAGE_ROUTE = "/plugin/markdown-preview/image"
var FIND_ROUTE = "/plugin/markdown-preview/find"
/** Mentioned files remembered for the picker. */
var MAX_MENTIONS = 12
/** Chips offered under one message. */
var MAX_CHIPS = 4
/** How often an open preview revalidates the file it shows. */
var POLL_MS = 2500
/** Prefix of the per-workspace key remembering the file last shown. */
var STORAGE_PREFIX = "dsh-markdown-preview:"
/** How long a workspace Markdown listing is reused before it is fetched again. */
var LISTING_TTL_MS = 15000
/** Narrowest the drawer may be dragged, in px. */
var MIN_WIDTH = 320
/** Widest absolute drawer width, in px. */
var MAX_WIDTH = 1600
/** Frame width kept visible beside the drawer, however wide it is dragged. */
var MIN_VISIBLE_FRAME = 240
/**
 * Share of the viewport the drawer takes. It is a sidebar: wide enough for prose
 * with tables and figures, while the conversation it was opened from stays
 * readable beside it. The 80% the reader asked for is the *document's* share of
 * the panel (see the stylesheet below), not the panel's share of the screen —
 * and a width dragged to something else is remembered.
 */
var DEFAULT_WIDTH_RATIO = 0.45
/** Where the dragged width is remembered. */
var WIDTH_KEY = "dsh-markdown-preview:width"

/**
 * The drawer's opening width: what the reader last dragged it to, else a share
 * of the viewport — a fixed 460px is cramped for prose with tables and figures.
 * @returns the width in px, clamped to the drag range.
 */
/** The current viewport width, with a sane fallback for tests and odd hosts. */
function viewportWidth() {
  return typeof window !== "undefined" && typeof window.innerWidth === "number" ? window.innerWidth : 1200
}

/**
 * The widest the drawer may be right now: the frame keeps
 * {@link MIN_VISIBLE_FRAME} px of itself visible.
 * @returns the clamp ceiling in px.
 */
function maxWidth() {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, viewportWidth() - MIN_VISIBLE_FRAME))
}

function initialWidth() {
  if (typeof localStorage !== "undefined") {
    try {
      var stored = Number(localStorage.getItem(WIDTH_KEY))
      if (Number.isFinite(stored) && stored >= MIN_WIDTH && stored <= MAX_WIDTH) {
        return Math.min(maxWidth(), Math.max(MIN_WIDTH, Math.round(stored)))
      }
    } catch {
      // Private mode: fall through to the viewport share.
    }
  }
  return Math.min(maxWidth(), Math.max(MIN_WIDTH, Math.round(viewportWidth() * DEFAULT_WIDTH_RATIO)))
}

/** Remember the width the reader dragged the drawer to. */
function rememberWidth(width) {
  if (typeof localStorage === "undefined") return
  try {
    localStorage.setItem(WIDTH_KEY, String(width))
  } catch {
    // Private mode or a full quota: the width is a convenience, never a failure.
  }
}
/** Markdown path token: an ASCII path start, then anything that cannot end a path. */
var MD_TOKEN = /[A-Za-z0-9_.@~+-][^\s`"'()[\]{}<>|,;:，。；：、！？]*\.(?:md|markdown|mdown)\b/gi
/** A URL scheme, so a remote link is never treated as a workspace path. */
var HAS_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/
/** One absolute URL, removed before scanning. */
var URL_TOKEN = /[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+/g
/** Markdown image syntax with a local destination. */
var MD_IMAGE = /!\[([^\]]*)\]\(\s*<?([^)\s<>]+)>?([^)]*)\)/g

/** Plugin copy, both shipped locales. */
var ZH = {
  'title': 'Markdown 预览',
  'openFile': '在预览面板里打开 {path}',
  'open': '打开 Markdown 预览',
  'close': '关闭',
  'refresh': '刷新',
  'picker': '选择文件',
  'follow': '跟随对话',
  'manual': '工作区相对路径，例如 docs/design.md',
  'mentioned': '对话里提到过（点一条在这里打开）',
  'noMentions': '这段对话里还没提到 .md 文件。可以在上面输入一个工作区相对路径。',
  'loading': '加载中…',
  'empty': '还没有可预览的文件：先让对话里出现一个 .md 路径，或在上面的输入框里填一个。',
  'notFound': '找不到这个文件（或它不在会话工作区内）。',
  'failed': '读取失败。',
  'truncated': '文件较多，这里只列出最近修改的。',
  'code.copy': '复制',
  'code.copied': '已复制',
  'footnotes': '脚注',
}

var EN = {
  'title': 'Markdown preview',
  'openFile': 'Open {path} in the preview panel',
  'open': 'Open the Markdown preview',
  'close': 'Close',
  'refresh': 'Refresh',
  'picker': 'Choose a file',
  'follow': 'Follow the conversation',
  'manual': 'Workspace-relative path, e.g. docs/design.md',
  'mentioned': 'Mentioned in the conversation (click one to open it here)',
  'noMentions': 'This conversation has not named a Markdown file yet. Type a workspace-relative path above.',
  'loading': 'Loading…',
  'empty': 'Nothing to preview yet: mention a .md path in the conversation, or type one above.',
  'notFound': 'No such file, or it is outside the session workspace.',
  'failed': 'Unable to read the file.',
  'truncated': 'Only the most recently changed files are listed.',
  'code.copy': 'Copy',
  'code.copied': 'Copied',
  'footnotes': 'Footnotes',
}

/** A cheap content hash, so a rebuilt bundle injects its own stylesheet revision. */
function hashOf(text) {
  var hash = 5381
  for (var index = 0; index < text.length; index += 1) {
    hash = ((hash * 33) ^ text.charCodeAt(index)) >>> 0
  }
  return hash.toString(36)
}

/**
 * Inject this revision of the plugin's stylesheet.
 *
 * The tag is keyed by a hash of its own text: a hot-reloaded bundle would
 * otherwise find the tag its previous revision left behind and inject nothing,
 * leaving the page styled by code that no longer exists. Older revisions of
 * this plugin's sheet are removed on the way in.
 */
function ensureStyles() {
  if (typeof document === "undefined") return
  var css = [
    '.dsv-mp-btn{display:inline-flex;align-items:center;justify-content:center;height:28px;min-width:28px;padding:0 6px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#666);cursor:pointer;font:inherit}',
    '.dsv-mp-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#111)}',
    '.dsv-mp-btn[data-active="true"]{color:var(--dsw-alias-brand-primary,#2563eb);background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
    '.dsv-mp-drawer{position:fixed;top:0;right:0;bottom:0;z-index:40;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1,#fff);border-left:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));box-shadow:-8px 0 24px rgba(0,0,0,.08);font-family:var(--dsw-font-family,inherit)}',
    '.dsv-mp-head{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}',
    '.dsv-mp-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#111);white-space:nowrap}',
    '.dsv-mp-path{flex:1;min-width:0;font-size:11px;color:var(--dsw-alias-label-tertiary,#888);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.dsv-mp-body{flex:1;min-height:0;overflow:auto;padding:2px 16px 32px}',
    /* The document owns the panel: the file lists are an aside that may take at
       most a fifth of it and scroll within that, so opening them never squeezes
       the Markdown into a strip at the bottom. */
    '.dsv-mp-picker{flex:0 0 auto;max-height:20vh;overflow:auto;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));padding:8px 10px;display:flex;flex-direction:column;gap:6px}',
    '.dsv-mp-input{width:100%;height:28px;padding:0 8px;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary,#111);background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.15));border-radius:6px;box-sizing:border-box}',
    '.dsv-mp-list{display:flex;flex-direction:column}',
    /* Without this the capped column squeezes every row into a sliver, which
       renders the whole list as a smear of clipped glyphs. */
    '.dsv-mp-list>.dsv-mp-item{flex:0 0 auto;min-height:22px}',
    '.dsv-mp-group{font-size:11px;color:var(--dsw-alias-label-caption,#999);padding:6px 2px 2px}',
    '.dsv-mp-item{display:block;width:100%;text-align:left;padding:4px 6px;border:0;background:transparent;border-radius:6px;font:inherit;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,#444);cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.dsv-mp-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#111)}',
    '.dsv-mp-note{padding:16px 4px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#888)}',
    '.dsv-mp-grip{position:absolute;left:-3px;top:0;bottom:0;width:6px;cursor:col-resize}',
    '.dsv-mp-chips{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 2px}',
    '.dsv-mp-chip{display:inline-flex;align-items:center;gap:2px;max-width:100%;padding:3px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:999px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111);cursor:pointer;font:inherit;font-size:12px;line-height:1.5}',
    '.dsv-mp-chip:hover{border-color:var(--dsw-alias-brand-primary,#2563eb);color:var(--dsw-alias-brand-primary,#2563eb)}',
    '.dsv-mp-chip-dir{color:var(--dsw-alias-label-tertiary,#999);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.dsv-mp-chip-name{font-weight:600;white-space:nowrap}',
  ].join("\n")
  var tagId = "markdown-preview:" + hashOf(css)
  if (document.querySelector('style[data-plugin-css="' + tagId + '"]') !== null) return
  var stale = document.querySelectorAll('style[data-plugin="markdown-preview"]')
  for (var index = 0; index < stale.length; index += 1) {
    if (stale[index].dataset.pluginCss !== tagId) stale[index].remove()
  }
  var tag = document.createElement("style")
  tag.dataset.plugin = "markdown-preview"
  tag.dataset.pluginCss = tagId
  tag.textContent = css
  document.head.appendChild(tag)
}

/** Whether an event is an append-origin surface message this plugin reads. */
function messageText(event) {
  if (event === null || typeof event !== "object" || event.surfaceOp !== "append") return null
  var data = event.data
  if (data === null || typeof data !== "object") return null
  var content = null
  if (event.type === "assistant/message") {
    content = data.message !== null && typeof data.message === "object" ? data.message.content : null
  } else if (event.type === "user/message") {
    content = data.content
  } else {
    return null
  }
  if (!Array.isArray(content)) return null
  var parts = []
  for (var index = 0; index < content.length; index += 1) {
    var block = content[index]
    if (block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text)
    }
  }
  return parts.join("\n")
}

/** Drop fenced code blocks: they show examples, not the files in play. */
function stripFencedCode(text) {
  var lines = text.split("\n")
  var kept = []
  var fence = null
  for (var index = 0; index < lines.length; index += 1) {
    var line = lines[index]
    var marker = /^\s*(`{3,}|~{3,})/.exec(line)
    if (fence === null) {
      if (marker !== null) {
        fence = marker[1].charAt(0)
        continue
      }
      kept.push(line)
    } else if (marker !== null && marker[1].charAt(0) === fence) {
      fence = null
    }
  }
  return kept.join("\n")
}

/**
 * Collect the Markdown paths one message names, in mention order.
 * @param text - the message's joined text content.
 * @returns deduplicated workspace-relative or absolute paths.
 */
function collectMarkdownPaths(text) {
  if (typeof text !== "string" || text.length === 0) return []
  var body = stripFencedCode(text).replace(URL_TOKEN, " ")
  var seen = new Set()
  var paths = []
  var match
  MD_TOKEN.lastIndex = 0
  while ((match = MD_TOKEN.exec(body)) !== null) {
    var token = match[0]
    if (token.length > 1024) continue
    if (HAS_SCHEME.test(token)) continue
    if (token.charAt(0) === "~") continue
    if (seen.has(token)) continue
    seen.add(token)
    paths.push(token)
    if (paths.length >= MAX_MENTIONS) break
  }
  return paths
}

/** How deep a workspace-relative path sits in the tree. */
function segmentsOf(path) {
  return path.split("/").length
}

/**
 * Directory names that hold somebody else's documentation: dependency trees,
 * vendored copies and build output. They belong in the picker (the reader may
 * want them) but never in the automatic fallback, which is where a build having
 * just unpacked a vendored README would otherwise land.
 */
var DEPENDENCY_SEGMENTS = [
  "node_modules", "vendor", "third_party", "thirdparty", "third_party_libs", "thirdparty_libs",
  "external", "extern", "deps", "_deps", "subprojects", "installed", "site-packages",
  "dist", "build", "out", "target", "venv",
]

/** Whether one row sits inside a dependency or build directory. */
function isDependencyPath(path) {
  var parts = path.split("/")
  for (var index = 0; index < parts.length - 1; index += 1) {
    if (DEPENDENCY_SEGMENTS.indexOf(parts[index]) !== -1) return true
  }
  return false
}

/** The basename of a workspace-relative path. */
function basenameOf(path) {
  var cut = path.lastIndexOf("/")
  return cut === -1 ? path : path.slice(cut + 1)
}

/** The directory part of a workspace-relative path. */
function dirnameOf(path) {
  var cut = path.lastIndexOf("/")
  return cut <= 0 ? "" : path.slice(0, cut)
}

/**
 * Resolve one destination from a document, relative to that document's own
 * directory, without escaping the workspace root.
 * @param docPath - the Markdown file the destination appears in.
 * @param destination - the authored destination.
 * @returns the workspace-relative path, or null when it escapes the root.
 */
function resolveFromDocument(docPath, destination) {
  if (destination.charAt(0) === "/") return destination
  var base = dirnameOf(docPath)
  var combined = base === "" ? destination : base + "/" + destination
  var parts = combined.split("/")
  var out = []
  for (var index = 0; index < parts.length; index += 1) {
    var part = parts[index]
    if (part === "" || part === ".") continue
    if (part === "..") {
      if (out.length === 0) return null
      out.pop()
      continue
    }
    out.push(part)
  }
  return out.length === 0 ? null : out.join("/")
}

/** The host URL of one file, given the workspace root it resolves against. */
function fileUrl(path, cwd) {
  return FILE_ROUTE + "?path=" + encodeURIComponent(path) + "&cwd=" + encodeURIComponent(cwd)
}

/** The host URL of one image, given the workspace root it resolves against. */
function imageUrl(path, cwd) {
  return IMAGE_ROUTE + "?path=" + encodeURIComponent(path) + "&cwd=" + encodeURIComponent(cwd)
}

/**
 * Point a document's local image destinations at the host image route.
 *
 * Anything the renderer already handles (an absolute http(s)/data URL) and
 * anything that cannot be served (a `~` path, a destination escaping the
 * workspace, an absolute path outside it) is left exactly as authored, so the
 * reader sees the original text or the alt label instead of a broken image.
 * @param text - the document source.
 * @param docPath - the document's workspace-relative path.
 * @param cwd - the workspace root.
 * @returns the rewritten source.
 */
function rewriteLocalImages(text, docPath, cwd) {
  return text.replace(MD_IMAGE, function (whole, alt, destination, rest) {
    if (HAS_SCHEME.test(destination)) return whole
    if (destination.charAt(0) === "~") return whole
    var resolved = resolveFromDocument(docPath, destination)
    if (resolved === null) return whole
    if (resolved.charAt(0) === "/" && cwd !== null && resolved.indexOf(cwd + "/") !== 0) return whole
    return "![" + alt + "](" + imageUrl(resolved, cwd) + (rest || "") + ")"
  })
}

// ── plugin state ────────────────────────────────────────────────────────────

var INITIAL = {
  open: false,
  sessionId: null,
  cwd: null,
  path: null,
  follow: true,
  manual: false,
  /** Mentioned Markdown, per session: the panel follows the conversation. */
  mentionsBySession: {},
  rejected: [],
  width: initialWidth(),
  /** Workspace Markdown listing: `{ path, size, mtime }` rows plus their paths. */
  files: [],
  filePaths: [],
  filesStatus: "idle",
  filesTruncated: false,
  filesCwd: null,
  filesAt: 0,
  filesPending: null,
}

var state = INITIAL
var listeners = new Set()

/** Publish a partial state change to every mounted component. */
function update(patch) {
  var next = Object.assign({}, state, patch)
  state = next
  listeners.forEach(function (listener) { listener() })
}

/**
 * Record the Markdown files one session's messages named, newest first.
 *
 * Reported by the chat-node renderer, which is handed the session it belongs to
 * — the Definition that reads the messages has no session identity, so it cannot
 * file them itself. Keying by session is what makes switching conversations
 * switch the panel: the new session's own mentions are already the right list.
 * @param sessionId - the session the messages belong to.
 * @param paths - the paths those messages named, in mention order.
 */
function reportMentions(sessionId, paths) {
  if (sessionId === null || sessionId === undefined || !Array.isArray(paths) || paths.length === 0) return
  var key = String(sessionId)
  var current = state.mentionsBySession[key] === undefined ? [] : state.mentionsBySession[key]
  var next = current.slice()
  var changed = false
  for (var index = paths.length - 1; index >= 0; index -= 1) {
    var path = paths[index]
    if (next.indexOf(path) === 0) continue
    var rest = []
    for (var scan = 0; scan < next.length; scan += 1) {
      if (next[scan] !== path) rest.push(next[scan])
    }
    next = [path].concat(rest).slice(0, MAX_MENTIONS)
    changed = true
  }
  if (!changed) return
  var map = Object.assign({}, state.mentionsBySession)
  map[key] = next
  update({ mentionsBySession: map })
}

/** The Markdown files the current session's conversation named, newest first. */
function mentionsOf(current) {
  if (current.sessionId === null || current.sessionId === undefined) return []
  var paths = current.mentionsBySession[String(current.sessionId)]
  return paths === undefined ? [] : paths
}

/** Forget a path that did not resolve, so following can move on. */
function reject(path) {
  if (state.rejected.indexOf(path) !== -1) return
  update({ rejected: state.rejected.concat([path]) })
}

/** Follow the current session: a switch re-targets every remembered path. */
function trackSession(sessionId, cwd) {
  if (state.sessionId === sessionId && state.cwd === cwd) return
  update({ sessionId: sessionId, cwd: cwd, rejected: [] })
}

/** Select one file explicitly, which stops the automatic follow. */
function selectPath(path) {
  update({ path: path, manual: true })
  if (path !== null) rememberPath(state.cwd, path)
}

/**
 * The listing path one prose token names: the exact row, or the basename when
 * exactly one row carries it (two rows sharing a basename stay inert rather
 * than opening the wrong document).
 * @param token - the inline-code token, exactly as authored.
 * @returns the listed path, or null.
 */
function resolveListedPath(token) {
  var listed = state.filePaths
  if (listed.length === 0) return null
  if (listed.indexOf(token) !== -1) return token
  if (token.indexOf("/") !== -1) return null
  var matches = listed.filter(function (path) { return basenameOf(path) === token })
  return matches.length === 1 ? matches[0] : null
}

/**
 * The preview opener for one prose token, when it names a Markdown file this
 * workspace has.
 * @param value - the token the chat view hands to a mention resolver.
 * @returns the mention, or undefined so the caller's own resolver decides.
 */
function previewMention(value) {
  if (typeof value !== "string") return undefined
  var token = value.trim()
  if (token === "" || token.length > 1024) return undefined
  if (!/\.(?:md|markdown|mdown)$/i.test(token)) return undefined
  var path = resolveListedPath(token)
  if (path === null) return undefined
  return {
    label: token,
    title: path,
    open: function () {
      selectPath(path)
      update({ open: true })
    },
  }
}

/**
 * Make a Markdown path written in prose open the preview panel.
 *
 * The chat view asks `chatFileMentions` for the prose vocabulary of one closing
 * Turn, and the shipped provider (`ui-deliverables`) links the files that Turn's
 * mutation tools touched — clicking one opens the Host editor. Cordis refuses a
 * second provider of the same service name, so this wraps the existing one
 * instead: a Markdown file this workspace has opens the panel, and everything
 * else still resolves through the original provider untouched. The wrapper goes
 * away with the plugin and never replaces the original resolver's answer.
 * @param ctx - the client root context.
 */
function installMentionInterception(ctx) {
  var service = ctx.get("chatFileMentions")
  if (service === null || service === undefined || typeof service.forClosing !== "function") return
  if (service.forClosing.__dshMarkdownPreview === true) return
  var previous = service.forClosing
  var wrapped = function (owner) {
    var theirs
    try {
      theirs = previous.call(service, owner)
    } catch {
      theirs = undefined
    }
    return {
      resolve: function (value) {
        var mine = previewMention(value)
        if (mine !== undefined) return mine
        return theirs === undefined ? undefined : theirs.resolve(value)
      },
    }
  }
  wrapped.__dshMarkdownPreview = true
  service.forClosing = wrapped
  ctx.effect(function () {
    return function () {
      if (service.forClosing === wrapped) service.forClosing = previous
    }
  }, "markdown-preview: prose mention interception")
}

/** The store key remembering the file this workspace was last shown. */
function storageKey(cwd) {
  return STORAGE_PREFIX + cwd
}

/**
 * The file this workspace last showed, so a reopened (or reloaded) page returns
 * to it instead of asking again.
 * @param cwd - the workspace root, or null while unknown.
 * @returns the remembered path, or null.
 */
function rememberedPath(cwd) {
  if (cwd === null || typeof localStorage === "undefined") return null
  try {
    return localStorage.getItem(storageKey(cwd))
  } catch {
    return null
  }
}

/**
 * Remember the file this workspace is showing.
 * @param cwd - the workspace root.
 * @param path - the path to remember.
 */
function rememberPath(cwd, path) {
  if (cwd === null || path === null || typeof localStorage === "undefined") return
  try {
    localStorage.setItem(storageKey(cwd), path)
  } catch {
    // Private mode or a full quota: remembering is a convenience, never a failure.
  }
}

/**
 * The file the drawer should show. Opening it must always land on a document —
 * "click and read" — so this picks, in order:
 *
 * 1. a mentioned path the workspace listing confirms exists,
 * 2. the file this workspace last showed (an explicit choice, and the reason a
 *    reopened page returns to the same document),
 * 3. any other listing row that has not already failed,
 *
 * and, when the listing itself is unavailable, the remembered file and then any
 * mention. Unlisted mentions are deliberately not chased while a listing is in
 * hand: prose often names a file that lives in another checkout, and following
 * it would spend a request (and a console 404) to learn what the listing already
 * says. Those paths stay in the picker for an explicit choice.
 * @param current - the plugin state.
 * @returns the path to show, or null when this workspace has no Markdown at all.
 */
function followTarget(current) {
  var listed = current.filePaths === undefined ? [] : current.filePaths
  var mentioned = mentionsOf(current)
  var cache = rememberedPath(current.cwd)
  function usable(path) {
    return path !== null && current.rejected.indexOf(path) === -1
  }
  function firstListedMention() {
    var fallback = null
    for (var index = 0; index < mentioned.length; index += 1) {
      var candidate = mentioned[index]
      if (!usable(candidate) || listed.indexOf(candidate) === -1) continue
      // A conversation may name both a vendored README and the document it is
      // working on; the document is what the reader wants to see.
      if (isDependencyPath(candidate)) {
        if (fallback === null) fallback = candidate
        continue
      }
      return candidate
    }
    return fallback
  }
  function firstMention() {
    for (var index = 0; index < mentioned.length; index += 1) {
      if (usable(mentioned[index])) return mentioned[index]
    }
    return null
  }
  if (current.filesStatus === "ready") {
    var chosen = firstListedMention()
    if (chosen !== null) return chosen
    // Nothing this conversation named is in the workspace: fall back to the file
    // the reader last chose here, and otherwise show nothing rather than a
    // document the conversation never mentioned.
    return usable(cache) ? cache : null
  }
  if (current.filesStatus === "failed") {
    if (usable(cache)) return cache
    return firstMention()
  }
  // The listing is still on its way: wait rather than guess, because guessing is
  // what produces the failed request this ordering exists to avoid.
  return null
}

/**
 * Refresh the workspace Markdown listing once per workspace, for the picker and
 * for telling a real mention apart from a path that only looks like one.
 * @param cwd - the workspace root, or null while unknown.
 */
function loadListing(cwd) {
  if (cwd === null || cwd === undefined) return
  var now = Date.now()
  if (state.filesCwd === cwd && now - state.filesAt < LISTING_TTL_MS) return
  if (state.filesPending) return
  if (state.filesCwd !== cwd) update({ filesCwd: cwd, files: [], filePaths: [], filesStatus: "loading", filesTruncated: false })
  else update({ filesStatus: "loading" })
  var request = fetch(FIND_ROUTE + "?cwd=" + encodeURIComponent(cwd), { cache: "no-store" })
    .then(function (response) {
      if (!response.ok) throw new Error(String(response.status))
      return response.json()
    })
    .then(function (body) {
      var files = body.files || []
      update({
        files: files,
        filePaths: files.map(function (entry) { return entry.path }),
        filesStatus: "ready",
        filesTruncated: body.truncated === true,
        filesAt: Date.now(),
      })
    })
    .catch(function () {
      update({ filesStatus: "failed", files: [], filePaths: [], filesAt: Date.now() })
    })
    .then(function () {
      if (state.filesPending === request) update({ filesPending: null })
    })
  update({ filesPending: request })
}

/** Subscribe one component to the plugin state. */
function usePluginState() {
  var versionPair = useState(0)
  var bump = versionPair[1]
  useEffect(function () {
    var listener = function () { bump(function (value) { return value + 1 }) }
    listeners.add(listener)
    return function () { listeners.delete(listener) }
  }, [])
  return state
}

// ── file loading ────────────────────────────────────────────────────────────

/**
 * Load and keep one Markdown file current. The first read returns the text;
 * every later poll revalidates with the ETag the host issued, so an unchanged
 * file costs a 304 and no re-render.
 * @param cwd - the workspace root, or null while unknown.
 * @param path - the workspace-relative or absolute file path, or null.
 * @param nonce - bumped by the refresh control to force an immediate re-read.
 * @returns `{ status, text }` for the current file.
 */
function useMarkdownFile(cwd, path, nonce) {
  var statePair = useState({ status: "idle", text: "" })
  var setResult = statePair[1]
  useEffect(function () {
    if (cwd === null || path === null) {
      setResult({ status: "idle", text: "" })
      return undefined
    }
    var cancelled = false
    var etag = null
    var settled = false
    setResult({ status: "loading", text: "" })
    function load() {
      var headers = etag === null ? {} : { 'if-none-match': etag }
      fetch(fileUrl(path, cwd), { headers: headers, cache: "no-store" })
        .then(function (response) {
          if (response.status === 304) return null
          etag = response.headers.get("etag")
          if (!response.ok) {
            var failure = new Error(String(response.status))
            failure.status = response.status
            throw failure
          }
          settled = true
          return response.text()
        })
        .then(function (text) {
          if (cancelled || text === null) return
          setResult({ status: "ready", text: text })
        })
        .catch(function (error) {
          if (cancelled || settled) return
          setResult({ status: error.status === 404 ? "missing" : "failed", text: "" })
        })
    }
    load()
    var timer = setInterval(function () {
      if (typeof document === "undefined" || document.visibilityState === "visible") load()
    }, POLL_MS)
    return function () {
      cancelled = true
      clearInterval(timer)
    }
  }, [cwd, path, nonce])
  return statePair[0]
}

// ── controls ────────────────────────────────────────────────────────────────

/**
 * The session-header toggle. It also keeps the drawer pointed at the session
 * the user is actually looking at.
 * @param props - the slot's session share plus this plugin's translate seat.
 * @returns the toggle button.
 */
function PreviewToggle(props) {
  var plugin = usePluginState()
  var sessionId = props.sessionId
  var cwd = props.useSessions(function (snapshot) {
    return snapshot.byId[sessionId] === undefined ? null : (snapshot.byId[sessionId].cwd || null)
  })
  useEffect(function () {
    if (sessionId === undefined) return
    trackSession(sessionId, cwd === undefined ? null : cwd)
    // The chips row consults this listing, so it is loaded with the session
    // rather than only when the drawer opens.
    loadListing(cwd === undefined ? null : cwd)
  }, [sessionId, cwd])
  var open = plugin.open
  return h(
    "button",
    {
      type: "button",
      className: "dsv-mp-btn",
      "data-active": open ? "true" : "false",
      title: props.t("open"),
      "aria-label": props.t("open"),
      "aria-pressed": open,
      onClick: function () {
        update({ open: !open })
      },
    },
    h(IconBrowseOutline16, { size: 16 }),
  )
}

/** One button in the drawer's header. */
function DrawerButton(props) {
  return h(
    "button",
    {
      type: "button",
      className: "dsv-mp-btn",
      title: props.title,
      "aria-label": props.title,
      "data-active": props.active === true ? "true" : "false",
      onClick: props.onClick,
    },
    props.children,
  )
}

/**
 * The file picker: a manual path box plus the two lists worth offering.
 * @param props - the translate seat and the current selection callback.
 * @returns the picker body.
 */
function FilePicker(props) {
  var plugin = usePluginState()
  var t = props.t
  var draftPair = useState("")
  var draft = draftPair[0]
  var setDraft = draftPair[1]
  // The panel lists what this conversation named. The workspace listing is still
  // fetched, but only to confirm those paths exist.
  var mentions = mentionsOf(plugin)

  function choose(path) {
    selectPath(path)
    props.onChosen()
  }

  return h(
    "div",
    { className: "dsv-mp-picker" },
    h("input", {
      className: "dsv-mp-input",
      type: "text",
      value: draft,
      placeholder: t("manual"),
      spellCheck: false,
      onChange: function (event) { setDraft(event.target.value) },
      onKeyDown: function (event) {
        if (event.key !== "Enter") return
        var value = draft.trim()
        if (value === "") return
        setDraft("")
        choose(value)
      },
    }),
    mentions.length > 0
      ? h(
        "div",
        { className: "dsv-mp-list" },
        h("div", { className: "dsv-mp-group" }, t("mentioned")),
        mentions.map(function (path) {
          return h(
            "button",
            { key: "mentioned:" + path, type: "button", className: "dsv-mp-item", title: path, onClick: function () { choose(path) } },
            path,
          )
        }),
      )
      : null,
    mentions.length === 0
      ? h("div", { className: "dsv-mp-note" }, t("noMentions"))
      : null,
  )
}

/**
 * The preview drawer itself: header, optional picker, and the rendered body.
 * @param props - this plugin's translate seat.
 * @returns the drawer, or null while closed.
 */
function PreviewDrawer(props) {
  var plugin = usePluginState()
  var t = props.t
  var pickerPair = useState(false)
  var pickerOpen = pickerPair[0]
  var setPickerOpen = pickerPair[1]
  var noncePair = useState(0)
  var setNonce = noncePair[1]

  useEffect(function () { ensureStyles() }, [])

  // Opening the preview collapses the frame's own right column: two panels
  // fighting for the same edge leave neither of them readable.
  var wasOpen = React.useRef(false)
  useEffect(function () {
    if (plugin.open && wasOpen.current === false && typeof props.onOpen === "function") props.onOpen()
    wasOpen.current = plugin.open
  }, [plugin.open])

  // Follow the conversation: whenever the newest mention changes, or a
  // followed file turned out not to resolve, re-target.
  useEffect(function () {
    if (!plugin.open || !plugin.follow || plugin.manual) return
    var target = followTarget(plugin)
    if (target !== plugin.path) update({ path: target })
  }, [plugin.open, plugin.follow, plugin.manual, plugin.mentionsBySession, plugin.sessionId, plugin.rejected, plugin.path, plugin.filePaths, plugin.filesStatus])

  // The workspace listing is what tells a mention apart from a path that only
  // looks like one, so following loads it as soon as the drawer opens.
  useEffect(function () {
    if (!plugin.open) return
    loadListing(plugin.cwd)
  }, [plugin.open, plugin.cwd])

  var current = useMarkdownFile(plugin.cwd, plugin.path, noncePair[0])
  var docPath = plugin.path

  // A file that does not resolve while following is dropped from the run.
  useEffect(function () {
    if (current.status !== "missing" && current.status !== "failed") return
    if (docPath === null) return
    if (!plugin.follow || plugin.manual) return
    reject(docPath)
  }, [current.status, docPath, plugin.follow, plugin.manual])

  // Every hook must run before the closed-state return below: a hook placed
  // after it would make the first open render call one hook more than the
  // closed render did, which React rejects as "rendered more hooks than
  // during the previous render" (#310).
  var labels = useMemo(function () {
    return {
      code: { copyLabel: t("code.copy"), copiedLabel: t("code.copied") },
      footnotes: t("footnotes"),
    }
  }, [t])

  if (!plugin.open) return null

  var body = null
  if (plugin.path === null) {
    // No file yet: the listing that supplies the fallback may still be in
    // flight, so say so instead of telling the reader to go find a file. With
    // no workspace root there is nothing to wait for, so that case reads as the
    // empty state it is.
    var waiting = plugin.cwd !== null
      && (plugin.filesStatus === "loading" || plugin.filesStatus === "idle")
    body = h("div", { className: "dsv-mp-note" }, waiting ? t("loading") : t("empty"))
  } else if (current.status === "loading") {
    body = h("div", { className: "dsv-mp-note" }, t("loading"))
  } else if (current.status === "missing") {
    body = h("div", { className: "dsv-mp-note" }, t("notFound"))
  } else if (current.status === "failed") {
    body = h("div", { className: "dsv-mp-note" }, t("failed"))
  } else if (current.status === "ready") {
    body = h(MarkdownText, {
      text: rewriteLocalImages(current.text, plugin.path, plugin.cwd),
      streaming: false,
      labels: labels,
    })
  }

  return h(
    "aside",
    { className: "dsv-mp-drawer", style: { width: plugin.width + "px" }, "aria-label": t("title") },
    h(DragHandle, null),
    h(
      "div",
      { className: "dsv-mp-head" },
      h("span", { className: "dsv-mp-title" }, t("title")),
      h("span", { className: "dsv-mp-path", title: plugin.path === null ? "" : plugin.path }, plugin.path === null ? "" : plugin.path),
      h(DrawerButton, {
        title: t("picker"),
        active: pickerOpen,
        onClick: function () { setPickerOpen(!pickerOpen) },
      }, h(IconChevronDownOutline14, { size: 14 })),
      h(DrawerButton, {
        title: t("refresh"),
        onClick: function () { setNonce(function (value) { return value + 1 }) },
      }, h(IconRefreshOutline16, { size: 14 })),
      h(DrawerButton, {
        title: t("close"),
        onClick: function () { update({ open: false }) },
      }, h(IconCloseOutline16, { size: 14 })),
    ),
    h(FilePicker, { t: t, open: pickerOpen, onChosen: function () { setPickerOpen(false) } }),
    h("div", { className: "dsv-mp-body" }, body),
  )
}

/** The drawer's left-edge resize grip. */
function DragHandle() {
  var dragging = React.useRef(null)
  return h("div", {
    className: "dsv-mp-grip",
    role: "separator",
    "aria-orientation": "vertical",
    onPointerDown: function (event) {
      if (event.button !== 0) return
      dragging.current = { startX: event.clientX, startWidth: state.width }
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    onPointerMove: function (event) {
      if (dragging.current === null) return
      var next = dragging.current.startWidth - (event.clientX - dragging.current.startX)
      update({ width: Math.min(maxWidth(), Math.max(MIN_WIDTH, Math.round(next))) })
    },
    onPointerUp: function (event) {
      if (dragging.current !== null) rememberWidth(state.width)
      dragging.current = null
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    },
  })
}

/** The state-only Definition that remembers which Markdown files the messages name. */
var mentionDefinition = {
  kind: "markdown-preview-mention",
  target: "chat",
  match: function (event) {
    var text = messageText(event)
    if (text === null || text.length === 0) return null
    if (!/\.(?:md|markdown|mdown)\b/i.test(stripFencedCode(text))) return null
    return { id: String(event.seq), role: "start" }
  },
  start: function (_context, match) {
    var text = messageText(match.event)
    // Publication only: the renderer below files these under the session that
    // owns the message, which a Definition cannot see.
    return { paths: text === null ? [] : collectMarkdownPaths(text) }
  },
  update: function (context) { return context.state },
  buildViewNode: function (context) {
    var state = context.state
    if (state === undefined || state.paths.length === 0) return null
    var start = context.start
    return {
      key: context.key,
      kind: KIND,
      id: context.id,
      target: "chat",
      anchorSeq: start !== null && start !== undefined ? start.event.seq : 0,
      location: start !== null && start !== undefined ? start.location : { kind: "unresolved" },
      visibility: "visible",
      data: { paths: state.paths },
    }
  },
}

/**
 * The chips row: one clickable chip per Markdown file the message named.
 *
 * Only files the workspace listing confirms are offered, so a chip always opens
 * something — a path the model wrote from another checkout stays out of the row
 * rather than becoming a dead click. While the listing is still loading the row
 * renders nothing rather than guessing.
 * @param props - the routed node plus this plugin's translate seat.
 * @returns the chips, or null when nothing in the message is openable here.
 */
function MarkdownFileChips(props) {
  var plugin = usePluginState()
  var t = props.t
  var node = props.node
  var paths = node !== undefined && node.data !== undefined && Array.isArray(node.data.paths) ? node.data.paths : []

  // Reported before any rendering decision: the file list must know what this
  // conversation named even while the workspace listing is still loading.
  useEffect(function () {
    reportMentions(props.sessionId, paths)
  }, [props.sessionId, node])

  if (paths.length === 0) return null
  if (plugin.filesStatus !== "ready" || plugin.filePaths.length === 0) return null
  var openable = []
  for (var index = 0; index < paths.length; index += 1) {
    if (plugin.filePaths.indexOf(paths[index]) !== -1 && openable.indexOf(paths[index]) === -1) openable.push(paths[index])
    if (openable.length >= MAX_CHIPS) break
  }
  if (openable.length === 0) return null
  return h(
    "div",
    { className: "dsv-mp-chips" },
    openable.map(function (path) {
      var cut = path.lastIndexOf("/")
      var dir = cut === -1 ? "" : path.slice(0, cut + 1)
      var name = cut === -1 ? path : path.slice(cut + 1)
      return h(
        "button",
        {
          key: "chip:" + path,
          type: "button",
          className: "dsv-mp-chip",
          title: t("openFile", { path: path }),
          onClick: function () {
            selectPath(path)
            update({ open: true })
          },
        },
        dir === "" ? null : h("span", { className: "dsv-mp-chip-dir" }, dir),
        h("span", { className: "dsv-mp-chip-name" }, name),
      )
    }),
  )
}

/** Required services: the Definition registry, the slots, and the dictionaries. */
exports.inject = ["uiConversation", "slots", "locale"]

/** Plugin name, for diagnostics. */
exports.name = "markdown-preview"

/**
 * Register the dictionaries, the mention Definition, the header toggle, and
 * the overlay drawer.
 * @param ctx - the client root context.
 */
exports.apply = function apply(ctx) {
  ctx.effect(function () {
    return ctx.locale.register(NS, { zh: ZH, en: EN })
  }, "markdown-preview: dictionaries")
  var t = ctx.locale.bind(NS)
  ensureStyles()

  ctx.uiConversation.events.register(mentionDefinition)
  ctx.slots.inject("conversation.chat.node", function () {
    return ctx.slots.register({ name: "conversation.chat.node", key: KIND }, function (props) {
      installMentionInterception(ctx)
      return h(MarkdownFileChips, Object.assign({}, props, { t: t }))
    })
  })

  ctx.slots.inject("conversation.session.header.utilities", function () {
    return ctx.slots.register(
      { name: "conversation.session.header.utilities", id: "markdown-preview", order: 40 },
      function (props) { return h(PreviewToggle, Object.assign({}, props, { t: t })) },
    )
  })
  ctx.slots.inject("shell.overlay", function () {
    return ctx.slots.register(
      { name: "shell.overlay", id: "markdown-preview" },
      function () {
        return h(PreviewDrawer, {
          t: t,
          onOpen: function () {
            var layout = ctx.get("layout")
            if (layout !== null && layout !== undefined && typeof layout.closeDetails === "function") {
              layout.closeDetails()
            }
            // Retried here as well: activation order decides whether the prose
            // provider already existed when the plugin mounted, and this runs
            // long after every row is up. It is idempotent.
            installMentionInterception(ctx)
          },
        })
      },
    )
  })
  installMentionInterception(ctx)
}

/** Test seam: the bundle has no build step, so a spec drives the pure parts directly. */
exports.internals = {
  KIND: KIND,
  previewMention: previewMention,
  reportMentions: reportMentions,
  mentionsOf: mentionsOf,
  segmentsOf: segmentsOf,
  isDependencyPath: isDependencyPath,
  resolveListedPath: resolveListedPath,
  initialWidth: initialWidth,
  maxWidth: maxWidth,
  collectMarkdownPaths: collectMarkdownPaths,
  resolveFromDocument: resolveFromDocument,
  rewriteLocalImages: rewriteLocalImages,
  messageText: messageText,
  state: function () { return state },
  reset: function () { state = INITIAL; listeners.clear() },
  update: update,
  followTarget: followTarget,
  selectPath: selectPath,
  trackSession: trackSession,
}

return module.exports; } });
