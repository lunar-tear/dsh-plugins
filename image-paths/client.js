/**
 * dsh-image-paths — browser half.
 *
 * Registers one Conversation Definition and one Chat node view: every message
 * whose prose names a local image by path gets a gallery of those images right
 * below it. Nothing is extracted from a fenced code block, nothing is fetched
 * until the image is in view, and a path that does not resolve simply renders
 * nothing.
 *
 * Hand-written bundle in the layout the client module system expects:
 * `window.__ModuleLoader__.load({ id, factory })` registering a lazy CJS
 * factory whose `require` resolves against the shell's frozen module table
 * (React is the only entry this bundle uses).
 */
window.__ModuleLoader__.load({ id: "dsh-image-paths", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;

var React = require("react")
var createElement = React.createElement
var useEffect = React.useEffect
var useState = React.useState

/** Chat node kind this plugin owns. Its length ordering also fixes placement: keys sort as "<len>:<kind><id>", so an 18-character kind lands after `14:assistant-step`. */
var KIND = "image-paths-inline-gallery-under-the-message-block"
/**
 * Those two facts are one decision. The Chat view orders nodes that share an
 * anchor sequence by comparing keys, and a Context key is
 * `<kind.length>:<kind><id>` — so the kind's own length decides whether this
 * gallery lands below the message or tool row it belongs to. Every shipped kind
 * keys with a digit below 5 ("4:user", "14:assistant-step", "9:turn-tail"), and
 * a 50-character kind keys with "50:", which sorts after all of them. Renaming
 * this constant without keeping it 50 characters long silently reorders the
 * gallery; the test asserts the length.
 */
/** Host route serving one image file; see the host half. */
var ROUTE = "/plugin/image-paths/raw"
/** Characters scanned per fragment, so a huge tool result cannot slow the chat down. */
var MAX_SCAN_CHARS = 20000
/** Images shown per message. */
var MAX_IMAGES = 8
/** Paths longer than this are never worth resolving. */
var MAX_PATH_CHARS = 4096
/**
 * A path token: an ASCII path start, any run of characters that cannot end a
 * path, then an image extension. The first character must be ASCII so a path
 * glued to Chinese prose (`见docs/x.png`) starts at the path, while everything
 * after it may be any script — directory names here are routinely CJK.
 */
var IMAGE_TOKEN = /[A-Za-z0-9_.@~+-][^\s`"'()[\]{}<>|,;:，。；：、！？]*\.(?:png|jpe?g|webp|gif)/gi
/** Stateless form of the same claim, for prefiltering and markdown destinations. */
var HAS_IMAGE_EXTENSION = /\.(?:png|jpe?g|webp|gif)\b/i
/** Markdown image syntax, whose destination is an explicit, deliberate mention. */
var MARKDOWN_IMAGE = /!\[[^\]]*\]\(\s*<?([^)\s<>]+)>?/g
/** Any absolute URL, removed before scanning so a remote image is never read as a local path. */
var URL_TOKEN = /[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+/g

/**
 * Drop fenced code blocks: they carry examples and transcripts, not the
 * disclosure the reader is meant to look at.
 * @param text - the message text.
 * @returns the text with every fenced block removed.
 */
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

/** The basename of an authored path, for alt text. */
function basenameOf(path) {
  var cut = path.lastIndexOf("/")
  return cut === -1 ? path : path.slice(cut + 1)
}

/**
 * Collect the local image paths one message names.
 *
 * A bare filename is accepted only from markdown image syntax — an explicit
 * mention — because a path-less token would otherwise be resolved against the
 * workspace root by guess. Home-relative tokens are dropped: the route only
 * serves files inside the session workspace.
 * @param text - the message's text content, already joined.
 * @returns deduplicated `{ path, label }` entries in mention order, capped.
 */
function collectImagePaths(text) {
  if (typeof text !== "string" || text.length === 0) return []
  var body = stripFencedCode(text).replace(URL_TOKEN, " ")
  var explicit = new Map()
  var match
  MARKDOWN_IMAGE.lastIndex = 0
  while ((match = MARKDOWN_IMAGE.exec(body)) !== null) {
    var destination = match[1]
    if (HAS_IMAGE_EXTENSION.test(destination)) explicit.set(destination, true)
  }
  var seen = new Set()
  var items = []
  IMAGE_TOKEN.lastIndex = 0
  while ((match = IMAGE_TOKEN.exec(body)) !== null) {
    var token = match[0]
    if (token.length > MAX_PATH_CHARS) continue
    if (token.indexOf("://") !== -1) continue
    if (token.charAt(0) === "~") continue
    // A token with no directory is kept, flagged: the host resolves it by
    // basename (unique match, or the newest of several) and the thumbnail names
    // the file it actually resolved to. A bare token that names nothing costs
    // one 200-answered lookup and renders nothing.
    var isPath = token.indexOf("/") !== -1 || token.charAt(0) === "/"
    if (seen.has(token)) continue
    seen.add(token)
    items.push({ path: token, label: basenameOf(token), bare: !isPath })
    if (items.length >= MAX_IMAGES) break
  }
  return items
}

/**
 * Join the text a content list carries. Prose and reasoning both count: a path
 * written while the model is thinking is exactly as worth showing as one it
 * wrote in its answer, and the shell renders thinking content in the transcript
 * too.
 * @param content - content blocks from a message or a tool result.
 * @param only - restrict to one block type, or undefined for text and reasoning.
 * @returns the joined text, in block order.
 */
function contentText(content, only) {
  if (!Array.isArray(content)) return ""
  var parts = []
  for (var index = 0; index < content.length; index += 1) {
    var block = content[index]
    if (block === null || typeof block !== "object") continue
    if (only !== undefined && block.type !== only) continue
    if ((block.type === "text" || block.type === "reasoning") && typeof block.text === "string") {
      parts.push(block.text)
    }
  }
  return parts.join("\n")
}

/** The content list of one message-shaped payload, or an empty list. */
function contentOf(payload) {
  return payload !== null && typeof payload === "object" && Array.isArray(payload.content) ? payload.content : []
}

/**
 * Bound one scanned fragment. A tool result can be megabytes of log; the point
 * of this plugin is the handful of paths in it, and the regex work should not
 * grow with the log.
 * @param text - the candidate fragment.
 * @returns the fragment, truncated to the scan budget.
 */
function bounded(text) {
  if (typeof text !== "string") return ""
  return text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text
}

/** The image paths one Context currently knows about, in mention order. */
function itemsOf(state) {
  return collectImagePaths([state.text, state.reasoning, state.tools].join("\n"))
}

/** Basename lookup route: how a token with no directory is turned into a file. */
var RESOLVE_ROUTE = "/plugin/image-paths/resolve"

/** Resolution results, keyed per workspace and authored token. */
var resolveCache = new Map()
/**
 * How long one resolution is trusted. A run directory that appears later holds a
 * newer file under the same name, and a negative answer must not outlive the
 * directory it was true for.
 */
var RESOLVE_TTL_MS = 30000

/**
 * Resolve one bare filename inside one workspace through the host.
 * @param cwd - the workspace root.
 * @param name - the authored token, without a directory.
 * @returns a promise of `{ status, path?, matches? }`.
 */
function resolveName(cwd, name) {
  var key = cwd + "\u0000" + name
  var cached = resolveCache.get(key)
  if (cached !== undefined && Date.now() - cached.at < RESOLVE_TTL_MS) return cached.promise
  var entry = { at: Date.now(), verdict: null, promise: null }
  entry.promise = fetch(RESOLVE_ROUTE + "?cwd=" + encodeURIComponent(cwd) + "&name=" + encodeURIComponent(name), { cache: "no-store" })
    .then(function (response) {
      return response.ok ? response.json() : { found: false }
    })
    .then(function (body) {
      if (body !== null && typeof body === "object" && body.found === true) {
        entry.verdict = { status: "found", path: String(body.path), matches: typeof body.matches === "number" ? body.matches : 0 }
      } else {
        entry.verdict = { status: "missing" }
      }
      return entry.verdict
    })
    .catch(function () {
      entry.verdict = { status: "failed" }
      return entry.verdict
    })
  resolveCache.set(key, entry)
  return entry.promise
}

/**
 * A resolution already known for this token, so a re-render shows the picture
 * without waiting for the effect to run again.
 * @param cwd - the workspace root.
 * @param name - the authored token.
 * @returns the cached verdict, or null while it is still in flight.
 */
function cachedResolution(cwd, name) {
  var entry = resolveCache.get(cwd + "\u0000" + name)
  if (entry === undefined || entry.verdict === null) return null
  if (Date.now() - entry.at >= RESOLVE_TTL_MS) return null
  return entry.verdict
}

/** The route URL for one authored path inside one workspace root. */
function imageUrl(path, cwd) {
  return ROUTE + "?path=" + encodeURIComponent(path) + "&cwd=" + encodeURIComponent(cwd)
}

/** Caption under a resolved bare name: which file the token actually meant. */
var CAPTION_STYLE = {
  display: "block",
  maxWidth: "180px",
  fontFamily: "inherit",
  fontSize: "11px",
  lineHeight: "1.4",
  color: "rgba(127,127,127,0.95)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
}

/** Per-image column: the thumbnail plus, for a resolved bare name, where it came from. */
var ITEM_STYLE = {
  display: "flex",
  flexDirection: "column",
  gap: "2px",
  maxWidth: "100%",
}

var WRAP_STYLE = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "flex-start",
  gap: "8px",
  margin: "8px 0 4px",
}

var THUMB_STYLE = {
  display: "block",
  maxHeight: "180px",
  maxWidth: "100%",
  borderRadius: "8px",
  border: "1px solid rgba(127,127,127,0.28)",
  background: "rgba(127,127,127,0.06)",
  cursor: "zoom-in",
}

var OVERLAY_STYLE = {
  position: "fixed",
  top: "0",
  right: "0",
  bottom: "0",
  left: "0",
  zIndex: "1000",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(0,0,0,0.72)",
  cursor: "zoom-out",
}

var FULL_STYLE = {
  maxWidth: "92vw",
  maxHeight: "92vh",
  borderRadius: "6px",
  boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
}

/**
 * One thumbnail. A path that does not resolve (missing file, outside the
 * workspace, not really an image) removes itself instead of leaving a broken
 * image in the transcript.
 * @param props - the item and the workspace root it resolves against.
 * @returns the thumbnail, or null once loading failed.
 */
function ImagePathCandidate(props) {
  var item = props.item
  var cwd = props.cwd
  var bare = item.bare === true
  var lookup = useState(bare ? (cachedResolution(cwd, item.path) ?? { status: "pending" }) : { status: "direct" })
  var resolution = lookup[0]
  var setResolution = lookup[1]
  var failure = useState(false)
  var failed = failure[0]
  var setFailed = failure[1]
  var preview = useState(false)
  var open = preview[0]
  var setOpen = preview[1]

  useEffect(function () {
    if (!bare) return undefined
    var cancelled = false
    resolveName(cwd, item.path).then(function (verdict) {
      if (!cancelled) setResolution(verdict)
    })
    return function () { cancelled = true }
  }, [cwd, item.path, bare])

  useEffect(function () {
    if (!open) return undefined
    var onKey = function (event) {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("keydown", onKey)
    return function () {
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  if (failed) return null
  // A bare token renders nothing until the host says which file it means.
  var path = bare ? (resolution.path === undefined ? null : resolution.path) : item.path
  if (path === null) return null
  var url = imageUrl(path, cwd)
  var ambiguous = bare && typeof resolution.matches === "number" && resolution.matches > 1
  var thumb = createElement("img", {
    key: "thumb",
    src: url,
    alt: item.label,
    title: path,
    loading: "lazy",
    decoding: "async",
    referrerPolicy: "no-referrer",
    style: THUMB_STYLE,
    onError: function () { setFailed(true) },
    onClick: function () { setOpen(true) },
  })
  var caption = bare
    ? createElement("span", {
      key: "caption",
      className: "dsv-ip-caption",
      title: path,
      style: CAPTION_STYLE,
    }, ambiguous ? `${item.path} → ${path}` : path)
    : null
  var framed = createElement("div", { key: "frame", className: "dsv-ip-item", style: ITEM_STYLE }, thumb, caption)
  if (!open) return framed
  return createElement(
    React.Fragment,
    null,
    framed,
    createElement(
      "div",
      {
        key: "preview",
        style: OVERLAY_STYLE,
        role: "dialog",
        "aria-label": path,
        onClick: function () { setOpen(false) },
      },
      createElement("img", {
        src: url,
        alt: item.label,
        decoding: "async",
        referrerPolicy: "no-referrer",
        style: FULL_STYLE,
      }),
    ),
  )
}

/**
 * The Chat node view: one wrap of thumbnails under the message that named them.
 * @param props - the routed node plus the owner's session facts.
 * @returns the gallery, or null when there is nothing to resolve against.
 */
function ImagePathGallery(props) {
  var node = props.node
  var cwd = props.cwd
  var items = node !== undefined && node.data !== undefined && Array.isArray(node.data.items)
    ? node.data.items
    : []
  if (items.length === 0) return null
  // Without a workspace root there is no authorized resolution; show nothing.
  if (typeof cwd !== "string" || cwd.length === 0) return null
  return createElement(
    "div",
    { className: "dsh-image-paths-gallery", style: WRAP_STYLE },
    items.map(function (item) {
      return createElement(ImagePathCandidate, { key: item.path, item: item, cwd: cwd })
    }),
  )
}

/**
 * The Conversation Definition: one gallery per conversation step.
 *
 * A step is the unit the chat already groups work by — the assistant message
 * that answered it and the tool results that message asked for — so one Context
 * per step collects every image path the step produced, whether it was written
 * in prose, in the model's reasoning, or printed by a tool. The node anchors at
 * the last event that contributed, so the gallery sits at the end of the step's
 * own content rather than drifting while the step is still running.
 *
 * A user message gets its own Context keyed by its sequence: the reader's own
 * message must keep its gallery attached even as the reply streams in below it.
 * Only append-origin surface events are read: a compaction replacement is a
 * model-facing copy, not something the reader saw.
 */
var imagePathDefinition = {
  kind: KIND,
  target: "chat",
  match: function (event) {
    if (event === null || typeof event !== "object" || event.surfaceOp !== "append") return null
    var data = event.data
    if (data === null || typeof data !== "object") return null
    if (event.type === "assistant/message") {
      return { id: "a:" + String(data.turn) + ":" + String(data.step), role: "start" }
    }
    if (event.type === "tool/result") {
      return { id: "a:" + String(data.turn) + ":" + String(data.step), role: "update" }
    }
    if (event.type === "user/message") return { id: "m:" + String(event.seq), role: "start" }
    return null
  },
  start: function (_context, match) {
    var event = match.event
    var data = event.data
    if (event.type === "user/message") {
      var user = { text: bounded(contentText(contentOf(data))), reasoning: "", tools: "", anchorSeq: event.seq }
      user.items = itemsOf(user)
      return user
    }
    var message = contentOf(data.message)
    var state = {
      text: bounded(contentText(message, "text")),
      reasoning: bounded(contentText(message, "reasoning")),
      tools: "",
      anchorSeq: event.seq,
    }
    state.items = itemsOf(state)
    return state
  },
  update: function (context, match) {
    var event = match.event
    var data = event.data
    var next = Object.assign({}, context.state)
    next.anchorSeq = event.seq
    if (event.type === "tool/result") {
      var message = data.message
      next.tools = bounded(next.tools + "\n" + contentText(contentOf(message)))
    }
    next.items = itemsOf(next)
    return next
  },
  buildViewNode: function (context) {
    var state = context.state
    if (state === undefined || state.items === undefined || state.items.length === 0) return null
    var start = context.start
    return {
      key: context.key,
      kind: KIND,
      id: context.id,
      target: "chat",
      anchorSeq: state.anchorSeq,
      location: start !== undefined && start !== null ? start.location : { kind: "unresolved" },
      visibility: "visible",
      data: { items: state.items },
    }
  },
}

/** Required services: the Definition registry and the Chat node seat. */
exports.inject = ["uiConversation", "slots"]

/** Plugin name, for diagnostics. */
exports.name = "image-paths"

/**
 * Register the Definition and its node view.
 * @param ctx - the client root context.
 */
exports.apply = function apply(ctx) {
  ctx.uiConversation.events.register(imagePathDefinition)
  ctx.slots.inject("conversation.chat.node", function () {
    return ctx.slots.register({ name: "conversation.chat.node", key: KIND }, ImagePathGallery)
  })
}

/** Test seam: the browser bundle has no build step, so a spec drives these directly. */
exports.internals = { collectImagePaths: collectImagePaths, contentText: contentText, KIND: KIND }

return module.exports; } });
