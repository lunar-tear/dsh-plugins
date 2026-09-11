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
/** Routes served by the host half. */
var FILE_ROUTE = "/plugin/markdown-preview/file"
var IMAGE_ROUTE = "/plugin/markdown-preview/image"
var FIND_ROUTE = "/plugin/markdown-preview/find"
/** Mentioned files remembered for the picker. */
var MAX_MENTIONS = 12
/** How often an open preview revalidates the file it shows. */
var POLL_MS = 2500
/** Drawer width bounds, in px. */
var MIN_WIDTH = 320
var MAX_WIDTH = 900
var DEFAULT_WIDTH = 460
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
  'open': '打开 Markdown 预览',
  'close': '关闭',
  'refresh': '刷新',
  'picker': '选择文件',
  'follow': '跟随对话',
  'manual': '工作区相对路径，例如 docs/design.md',
  'mentioned': '对话里提到过',
  'workspace': '工作区里的 Markdown',
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
  'open': 'Open the Markdown preview',
  'close': 'Close',
  'refresh': 'Refresh',
  'picker': 'Choose a file',
  'follow': 'Follow the conversation',
  'manual': 'Workspace-relative path, e.g. docs/design.md',
  'mentioned': 'Mentioned in the conversation',
  'workspace': 'Markdown in the workspace',
  'loading': 'Loading…',
  'empty': 'Nothing to preview yet: mention a .md path in the conversation, or type one above.',
  'notFound': 'No such file, or it is outside the session workspace.',
  'failed': 'Unable to read the file.',
  'truncated': 'Only the most recently changed files are listed.',
  'code.copy': 'Copy',
  'code.copied': 'Copied',
  'footnotes': 'Footnotes',
}

/** Inject the plugin's stylesheet once per document. */
function ensureStyles() {
  if (typeof document === "undefined") return
  if (document.querySelector('style[data-plugin-css="markdown-preview"]') !== null) return
  var tag = document.createElement("style")
  tag.dataset.plugin = "markdown-preview"
  tag.dataset.pluginCss = "markdown-preview"
  tag.textContent = [
    '.dsv-mp-btn{display:inline-flex;align-items:center;justify-content:center;height:28px;min-width:28px;padding:0 6px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#666);cursor:pointer;font:inherit}',
    '.dsv-mp-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#111)}',
    '.dsv-mp-btn[data-active="true"]{color:var(--dsw-alias-brand-primary,#2563eb);background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
    '.dsv-mp-drawer{position:fixed;top:0;right:0;bottom:0;z-index:40;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1,#fff);border-left:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));box-shadow:-8px 0 24px rgba(0,0,0,.08);font-family:var(--dsw-font-family,inherit)}',
    '.dsv-mp-head{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}',
    '.dsv-mp-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#111);white-space:nowrap}',
    '.dsv-mp-path{flex:1;min-width:0;font-size:11px;color:var(--dsw-alias-label-tertiary,#888);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.dsv-mp-body{flex:1;overflow:auto;padding:2px 16px 32px}',
    '.dsv-mp-picker{border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));padding:8px 10px;display:flex;flex-direction:column;gap:6px}',
    '.dsv-mp-input{width:100%;height:28px;padding:0 8px;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary,#111);background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.15));border-radius:6px;box-sizing:border-box}',
    '.dsv-mp-list{max-height:32vh;overflow:auto;display:flex;flex-direction:column}',
    '.dsv-mp-group{font-size:11px;color:var(--dsw-alias-label-caption,#999);padding:6px 2px 2px}',
    '.dsv-mp-item{display:block;width:100%;text-align:left;padding:4px 6px;border:0;background:transparent;border-radius:6px;font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary,#444);cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.dsv-mp-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#111)}',
    '.dsv-mp-note{padding:16px 4px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#888)}',
    '.dsv-mp-grip{position:absolute;left:-3px;top:0;bottom:0;width:6px;cursor:col-resize}',
  ].join("\n")
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
  mentioned: [],
  rejected: [],
  width: DEFAULT_WIDTH,
}

var state = INITIAL
var listeners = new Set()

/** Publish a partial state change to every mounted component. */
function update(patch) {
  var next = Object.assign({}, state, patch)
  state = next
  listeners.forEach(function (listener) { listener() })
}

/** Remember one mentioned Markdown path, newest first. */
function mention(path) {
  if (state.mentioned.indexOf(path) === 0) return
  var rest = state.mentioned.filter(function (entry) { return entry !== path })
  update({ mentioned: [path].concat(rest).slice(0, MAX_MENTIONS) })
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
  if (path !== null) mention(path)
}

/** The newest mentioned path that has not already failed to load. */
function followTarget(current) {
  for (var index = 0; index < current.mentioned.length; index += 1) {
    var candidate = current.mentioned[index]
    if (current.rejected.indexOf(candidate) === -1) return candidate
  }
  return null
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
    if (sessionId !== undefined) trackSession(sessionId, cwd === undefined ? null : cwd)
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
  var filesPair = useState({ status: "idle", files: [], truncated: false })
  var files = filesPair[0]
  var setFiles = filesPair[1]

  useEffect(function () {
    if (!props.open || plugin.cwd === null) return undefined
    var cancelled = false
    setFiles({ status: "loading", files: [], truncated: false })
    fetch(FIND_ROUTE + "?cwd=" + encodeURIComponent(plugin.cwd), { cache: "no-store" })
      .then(function (response) {
        if (!response.ok) throw new Error(String(response.status))
        return response.json()
      })
      .then(function (body) {
        if (cancelled) return
        setFiles({ status: "ready", files: body.files || [], truncated: body.truncated === true })
      })
      .catch(function () {
        if (!cancelled) setFiles({ status: "failed", files: [], truncated: false })
      })
    return function () { cancelled = true }
  }, [props.open, plugin.cwd])

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
    plugin.mentioned.length > 0
      ? h(
        "div",
        { className: "dsv-mp-list" },
        h("div", { className: "dsv-mp-group" }, t("mentioned")),
        plugin.mentioned.map(function (path) {
          return h(
            "button",
            { key: "mentioned:" + path, type: "button", className: "dsv-mp-item", title: path, onClick: function () { choose(path) } },
            path,
          )
        }),
      )
      : null,
    h("div", { className: "dsv-mp-group" }, t("workspace")),
    files.status === "loading" ? h("div", { className: "dsv-mp-note" }, t("loading")) : null,
    files.status === "failed" ? h("div", { className: "dsv-mp-note" }, t("failed")) : null,
    files.status === "ready" && files.files.length === 0 ? h("div", { className: "dsv-mp-note" }, t("empty")) : null,
    files.status === "ready" && files.files.length > 0
      ? h(
        "div",
        { className: "dsv-mp-list" },
        files.files.map(function (entry) {
          return h(
            "button",
            { key: "file:" + entry.path, type: "button", className: "dsv-mp-item", title: entry.path, onClick: function () { choose(entry.path) } },
            entry.path,
          )
        }),
      )
      : null,
    files.truncated ? h("div", { className: "dsv-mp-note" }, t("truncated")) : null,
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

  // Follow the conversation: whenever the newest mention changes, or a
  // followed file turned out not to resolve, re-target.
  useEffect(function () {
    if (!plugin.open || !plugin.follow || plugin.manual) return
    var target = followTarget(plugin)
    if (target !== plugin.path) update({ path: target })
  }, [plugin.open, plugin.follow, plugin.manual, plugin.mentioned, plugin.rejected, plugin.path])

  var current = useMarkdownFile(plugin.cwd, plugin.path, noncePair[0])
  var docPath = plugin.path

  // A file that does not resolve while following is dropped from the run.
  useEffect(function () {
    if (current.status !== "missing" && current.status !== "failed") return
    if (docPath === null) return
    if (!plugin.follow || plugin.manual) return
    reject(docPath)
  }, [current.status, docPath, plugin.follow, plugin.manual])

  if (!plugin.open) return null

  var labels = useMemo(function () {
    return {
      code: { copyLabel: t("code.copy"), copiedLabel: t("code.copied") },
      footnotes: t("footnotes"),
    }
  }, [t])

  var body = null
  if (plugin.path === null) {
    body = h("div", { className: "dsv-mp-note" }, t("empty"))
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
      update({ width: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(next))) })
    },
    onPointerUp: function (event) {
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
  match: function (event) {
    var text = messageText(event)
    if (text === null || text.length === 0) return null
    if (!/\.(?:md|markdown|mdown)\b/i.test(stripFencedCode(text))) return null
    return { id: String(event.seq), role: "start" }
  },
  start: function (_context, match) {
    var text = messageText(match.event)
    var paths = text === null ? [] : collectMarkdownPaths(text)
    // The one deliberate side effect in this plugin: the mention list is a
    // projection of the conversation every preview surface reads.
    for (var index = paths.length - 1; index >= 0; index -= 1) mention(paths[index])
    return { paths: paths }
  },
  update: function (context) { return context.state },
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

  ctx.slots.inject("conversation.session.header.utilities", function () {
    return ctx.slots.register(
      { name: "conversation.session.header.utilities", id: "markdown-preview", order: 40 },
      function (props) { return h(PreviewToggle, Object.assign({}, props, { t: t })) },
    )
  })
  ctx.slots.inject("shell.overlay", function () {
    return ctx.slots.register(
      { name: "shell.overlay", id: "markdown-preview" },
      function () { return h(PreviewDrawer, { t: t }) },
    )
  })
}

/** Test seam: the bundle has no build step, so a spec drives the pure parts directly. */
exports.internals = {
  collectMarkdownPaths: collectMarkdownPaths,
  resolveFromDocument: resolveFromDocument,
  rewriteLocalImages: rewriteLocalImages,
  messageText: messageText,
  state: function () { return state },
  reset: function () { state = INITIAL; listeners.clear() },
  update: update,
  mention: mention,
  followTarget: followTarget,
  selectPath: selectPath,
  trackSession: trackSession,
}

return module.exports; } });
