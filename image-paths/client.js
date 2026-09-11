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
var KIND = "image-path-gallery"
/** Host route serving one image file; see the host half. */
var ROUTE = "/plugin/image-paths/raw"
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
    var isPath = token.indexOf("/") !== -1 || token.charAt(0) === "/"
    if (!isPath && explicit.get(token) !== true) continue
    if (seen.has(token)) continue
    seen.add(token)
    items.push({ path: token, label: basenameOf(token) })
    if (items.length >= MAX_IMAGES) break
  }
  return items
}

/** Join the text blocks of one content list. */
function textOf(content) {
  if (!Array.isArray(content)) return ""
  var parts = []
  for (var index = 0; index < content.length; index += 1) {
    var block = content[index]
    if (block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text)
    }
  }
  return parts.join("\n")
}

/**
 * Read one message event as `{ turn, step, text }`, or null when the event is
 * not a message this plugin reads. Only append-origin surface events count: a
 * compaction replacement is a model-facing copy, not something the reader saw.
 * @param event - one session event.
 * @returns the message facts, or null.
 */
function messageOf(event) {
  if (event === null || typeof event !== "object" || event.surfaceOp !== "append") return null
  var data = event.data
  if (data === null || typeof data !== "object") return null
  if (event.type === "assistant/message") {
    var message = data.message
    if (message === null || typeof message !== "object") return null
    return { turn: data.turn, step: data.step, text: textOf(message.content) }
  }
  if (event.type === "user/message") {
    return { turn: data.turn, step: data.step, text: textOf(data.content) }
  }
  return null
}

/** The route URL for one authored path inside one workspace root. */
function imageUrl(path, cwd) {
  return ROUTE + "?path=" + encodeURIComponent(path) + "&cwd=" + encodeURIComponent(cwd)
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
  var url = imageUrl(item.path, cwd)
  var failure = useState(false)
  var failed = failure[0]
  var setFailed = failure[1]
  var preview = useState(false)
  var open = preview[0]
  var setOpen = preview[1]

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
  var thumb = createElement("img", {
    key: "thumb",
    src: url,
    alt: item.label,
    title: item.path,
    loading: "lazy",
    decoding: "async",
    referrerPolicy: "no-referrer",
    style: THUMB_STYLE,
    onError: function () { setFailed(true) },
    onClick: function () { setOpen(true) },
  })
  if (!open) return thumb
  return createElement(
    React.Fragment,
    null,
    thumb,
    createElement(
      "div",
      {
        key: "preview",
        style: OVERLAY_STYLE,
        role: "dialog",
        "aria-label": item.path,
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

/** The Conversation Definition: one gallery node per message that names images. */
var imagePathDefinition = {
  kind: KIND,
  target: "chat",
  match: function (event) {
    var message = messageOf(event)
    if (message === null || message.text.length === 0) return null
    // Cheap prefilter: the overwhelming majority of messages name no image, and
    // a Definition's match runs for every event in the loaded window.
    if (!HAS_IMAGE_EXTENSION.test(stripFencedCode(message.text).replace(URL_TOKEN, " "))) return null
    return { id: String(event.seq), role: "start" }
  },
  start: function (context, match) {
    var message = messageOf(match.event)
    return {
      turn: message === null ? undefined : message.turn,
      step: message === null ? undefined : message.step,
      items: message === null ? [] : collectImagePaths(message.text),
    }
  },
  update: function (context) {
    return context.state
  },
  buildViewNode: function (context) {
    var state = context.state
    if (state === undefined || state.items.length === 0) return null
    var start = context.start
    return {
      key: context.key,
      kind: KIND,
      id: context.id,
      target: "chat",
      anchorSeq: start !== undefined && start !== null
        ? start.event.seq
        : (context.matches[0] !== undefined ? context.matches[0].event.seq : 0),
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
exports.internals = { collectImagePaths: collectImagePaths, messageOf: messageOf, KIND: KIND }

return module.exports; } });
