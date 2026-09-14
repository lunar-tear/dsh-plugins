/**
 * dsh-markdown-preview — host half.
 *
 * Three read-only routes that let the chat UI preview a workspace Markdown
 * file beside the conversation:
 *
 * - `/file` returns the Markdown text, with an ETag so an open preview polls
 *   cheaply (304 while the file is unchanged).
 * - `/image` returns one image file, because the shipped Markdown renderer
 *   only accepts absolute http(s) image URLs and a document's local figures
 *   would otherwise not render at all.
 * - `/find` lists the workspace's Markdown files, newest first, for the
 *   preview's file picker.
 *
 * Access model: a file is served only when its **real** path (symlinks
 * resolved) lies inside the workspace root the caller named, the extension is
 * on that route's allowlist, and the bytes agree with the extension. The Host
 * header must be loopback and cross-site browser requests are refused, so a
 * page the user visits cannot use these routes to probe local files.
 *
 * The guard code here is deliberately a copy of the same guard in the
 * dsh-image-paths plugin: keeping each plugin self-contained is worth more
 * than sharing a module between two independently removable rows.
 */

import { promises as fs, createReadStream, readFile, readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'

/** Cordis plugin name. */
export const name = 'markdown-preview'

/** Required service: the route registry and request dispatch. */
export const inject = ['webServer']

/** Route prefix owned by this plugin. */
export const PREFIX = '/plugin/markdown-preview'
/** Markdown text route. */
export const FILE_ROUTE = `${PREFIX}/file`
/** Image bytes route, used for a document's local figures. */
export const IMAGE_ROUTE = `${PREFIX}/image`
/** Workspace Markdown listing route. */
export const FIND_ROUTE = `${PREFIX}/find`
/**
 * Canvas route: one workspace HTML document, served for a sandboxed iframe.
 *
 * The response carries a `sandbox` policy of its own, so the artifact can run
 * its own scripts in an opaque origin — never with this app's cookies, storage
 * or RPC — even if a caller forgets the iframe's `sandbox` attribute.
 */
export const CANVAS_ROUTE = `${PREFIX}/canvas`
/** Diagram engine route: the vendored mermaid browser build, served on demand. */
export const MERMAID_ROUTE = `${PREFIX}/mermaid.js`

/** Extensions the preview reads as Markdown. */
export const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdown'])
/** Extensions the canvas route renders as an HTML artifact. */
export const CANVAS_EXTENSIONS = new Set(['.html', '.htm'])
/** Every extension the panel will open: a document, or a canvas. */
export const PREVIEW_EXTENSIONS = new Set([...MARKDOWN_EXTENSIONS, ...CANVAS_EXTENSIONS])
/** Refuse a canvas larger than this. */
const MAX_CANVAS_BYTES = 8 * 1024 * 1024
/** Refuse a diagram engine larger than this. */
const MAX_MERMAID_BYTES = 16 * 1024 * 1024

/** Extensions the image route serves, mapped to the media type they must prove. */
export const IMAGE_MEDIA_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
])

/** Refuse a Markdown file larger than this: a preview is not a bulk reader. */
const MAX_TEXT_BYTES = 2 * 1024 * 1024
/** Refuse an image larger than this. */
const MAX_IMAGE_BYTES = 32 * 1024 * 1024
/** Refuse pathologically long inputs before touching the filesystem. */
const MAX_PATH_CHARS = 4096
/** Markdown files returned by `find`. */
const MAX_FILES = 40
/** Directory entries visited by one `find` walk. */
const MAX_WALK_ENTRIES = 4000
/** Directory depth visited by one `find` walk. */
const MAX_WALK_DEPTH = 6
/** Directories a `find` walk never enters. */
const SKIP_DIRECTORIES = new Set([
  'node_modules', 'dist', 'build', 'out', 'target', 'venv', 'vendor',
  '__pycache__', 'site-packages', 'third_party', 'thirdparty',
  'third_party_libs', 'thirdparty_libs', 'external', 'extern', 'deps', '_deps',
  'subprojects', 'installed',
])

/**
 * Whether the request's `Host` names the loopback interface. This is the
 * DNS-rebinding guard: a page on a name that resolves to 127.0.0.1 would look
 * same-origin after rebinding. A deployment that binds the GUI elsewhere must
 * widen this.
 * @param req - the incoming request.
 * @returns true when the Host header is a loopback host.
 */
export function loopbackHost(req) {
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return false
  if (host.startsWith('[')) return host.startsWith('[::1]')
  const name = host.split(':')[0]
  return name === '127.0.0.1' || name === 'localhost'
}

/**
 * Whether one request came from a page this plugin served.
 *
 * A sandboxed canvas runs in an opaque origin, so its own requests carry no
 * usable origin — but they do carry the URL of the page they started from, and
 * no remote page can forge that. The canvas response asks for `unsafe-url` so
 * the full path survives, which is what makes this check possible at all.
 * @param req - the incoming request.
 * @returns true when the referring page is one of this plugin's routes.
 */
export function pluginPageReferer(req) {
  const referer = req.headers.referer
  if (typeof referer !== 'string' || referer === '') return false
  try {
    const url = new URL(referer)
    if (url.host !== req.headers.host) return false
    return url.pathname === PREFIX || url.pathname.startsWith(`${PREFIX}/`)
  } catch {
    return false
  }
}

/**
 * Whether the request may be answered at all.
 * @param req - the incoming request.
 * @returns true when the request is same-origin or not a browser request.
 */
export function sameOrigin(req) {
  if (!loopbackHost(req)) return false
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string') return site === 'same-origin' || site === 'none'
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

/** Write one short plain-text refusal. */
function refuse(res, status, reason) {
  const body = `${reason}\n`
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

/** Write one short JSON refusal so the client can branch on a status code. */
function refuseJson(res, status, reason) {
  const body = JSON.stringify({ error: reason })
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Resolve one caller-named path inside one caller-named workspace root.
 * @param requested - the path as authored (workspace-relative or absolute).
 * @param cwd - the workspace root the client reported.
 * @returns a refusal, or the resolved regular file with its stat.
 */
export async function resolveInside(requested, cwd) {
  if (typeof requested !== 'string' || requested.length === 0 || requested.length > MAX_PATH_CHARS) {
    return { status: 400, reason: 'missing or overlong path' }
  }
  if (requested.includes('\0')) return { status: 400, reason: 'invalid path' }
  if (typeof cwd !== 'string' || cwd.length === 0 || cwd.length > MAX_PATH_CHARS || !isAbsolute(cwd)) {
    return { status: 400, reason: 'missing or non-absolute workspace root' }
  }
  let realRoot
  try {
    realRoot = await fs.realpath(cwd)
  } catch {
    return { status: 400, reason: 'workspace root is not readable' }
  }
  const candidate = isAbsolute(requested) ? resolve(requested) : resolve(realRoot, requested)
  let realPath
  try {
    realPath = await fs.realpath(candidate)
  } catch {
    return { status: 404, reason: 'no such file' }
  }
  const prefix = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`
  if (realPath !== realRoot && !realPath.startsWith(prefix)) {
    return { status: 403, reason: 'outside the session workspace' }
  }
  let stat
  try {
    stat = await fs.stat(realPath)
  } catch {
    return { status: 404, reason: 'no such file' }
  }
  if (!stat.isFile()) return { status: 404, reason: 'not a regular file' }
  return { status: 200, realPath, realRoot, stat }
}

/**
 * Identify one supported image format from its leading bytes.
 * @param head - at least the first 12 bytes of the file.
 * @returns the detected media type, or undefined for other content.
 */
export function sniffMediaType(head) {
  const ascii = (offset, text) => {
    if (head.length < offset + text.length) return false
    for (let index = 0; index < text.length; index += 1) {
      if (head[offset + index] !== text.charCodeAt(index)) return false
    }
    return true
  }
  const bytes = (...expected) => {
    if (head.length < expected.length) return false
    return expected.every((byte, index) => head[index] === byte)
  }
  if (bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (bytes(0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif'
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp'
  return undefined
}

/** Reject a method this plugin never answers. */
function methodAllowed(req, res) {
  if (req.method === 'GET' || req.method === 'HEAD') return true
  refuse(res, 405, 'method not allowed')
  return false
}

/** Guard the two conditions every route shares. */
function accessAllowed(req, res) {
  if (!sameOrigin(req) && !pluginPageReferer(req)) {
    refuse(res, 403, 'cross-site request refused')
    return false
  }
  return true
}

/**
 * Serve one Markdown file as text, with ETag revalidation.
 * @param req - the incoming request (method, URL, cross-site and validator headers).
 * @param res - the response this handler owns end to end.
 */
export async function serveMarkdown(req, res) {
  if (!methodAllowed(req, res)) return
  if (!accessAllowed(req, res)) return
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const decision = await resolveInside(url.searchParams.get('path') ?? '', url.searchParams.get('cwd') ?? '')
  if (decision.status !== 200) return refuse(res, decision.status, decision.reason)
  if (!MARKDOWN_EXTENSIONS.has(extname(decision.realPath).toLowerCase())) {
    return refuse(res, 415, 'not a markdown file')
  }
  if (decision.stat.size > MAX_TEXT_BYTES) return refuse(res, 413, 'markdown file is too large to preview')

  const etag = `"${Math.round(decision.stat.mtimeMs)}-${decision.stat.size}"`
  const submitted = req.headers['if-none-match']
  if (typeof submitted === 'string' && submitted.split(/\s*,\s*/).includes(etag)) {
    res.writeHead(304, { etag, 'cache-control': 'no-cache' })
    res.end()
    return
  }
  let text
  try {
    text = await fs.readFile(decision.realPath, 'utf8')
  } catch {
    return refuse(res, 500, 'unable to read the file')
  }
  const body = Buffer.from(text, 'utf8')
  res.writeHead(200, {
    'content-type': 'text/markdown; charset=utf-8',
    'content-length': String(body.byteLength),
    // Revalidate on every poll; the ETag keeps the common case a 304.
    'cache-control': 'no-cache',
    etag,
    'x-content-type-options': 'nosniff',
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  res.end(body)
}

/**
 * Serve one local image file, so a document's figures render.
 * @param req - the incoming request.
 * @param res - the response this handler owns end to end.
 */
export async function serveImage(req, res) {
  if (!methodAllowed(req, res)) return
  if (!accessAllowed(req, res)) return
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const requested = url.searchParams.get('path') ?? ''
  const declared = IMAGE_MEDIA_TYPES.get(extname(requested).toLowerCase())
  if (declared === undefined) return refuse(res, 415, 'not a supported image extension')
  const decision = await resolveInside(requested, url.searchParams.get('cwd') ?? '')
  if (decision.status !== 200) return refuse(res, decision.status, decision.reason)
  if (decision.stat.size === 0) return refuse(res, 404, 'empty file')
  if (decision.stat.size > MAX_IMAGE_BYTES) return refuse(res, 413, 'image is too large to display')

  const handle = await fs.open(decision.realPath, 'r')
  let head
  try {
    const buffer = Buffer.alloc(12)
    const { bytesRead } = await handle.read(buffer, 0, 12, 0)
    head = buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
  const sniffed = sniffMediaType(head)
  if (sniffed === undefined) return refuse(res, 415, 'content is not a supported image')
  if (sniffed !== declared) return refuse(res, 415, 'content does not match the file extension')

  res.writeHead(200, {
    'content-type': sniffed,
    'content-length': String(decision.stat.size),
    'cache-control': 'private, max-age=300',
    'x-content-type-options': 'nosniff',
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  try {
    await pipeline(createReadStream(decision.realPath), res)
  } catch {
    res.destroy()
  }
}

/**
 * List a workspace's Markdown files, newest first, with a bounded walk.
 *
 * Bounded on purpose: the walk visits at most {@link MAX_WALK_ENTRIES}
 * entries, descends at most {@link MAX_WALK_DEPTH} levels, never enters a
 * build/dependency directory or a dot-directory, and never follows a symlink
 * (a `Dirent` for one is neither a file nor a directory here).
 * @param root - the workspace root to walk.
 * @returns the newest entries plus whether the walk hit its bound.
 */
export async function listMarkdownFiles(root) {
  const found = []
  const queue = [{ dir: root, depth: 0 }]
  let visited = 0
  let truncated = false
  while (queue.length > 0) {
    const current = queue.shift()
    let entries
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      visited += 1
      if (visited > MAX_WALK_ENTRIES) {
        truncated = true
        break
      }
      const full = join(current.dir, entry.name)
      if (entry.isDirectory()) {
        if (current.depth >= MAX_WALK_DEPTH) continue
        if (entry.name.startsWith('.') || SKIP_DIRECTORIES.has(entry.name)) continue
        queue.push({ dir: full, depth: current.depth + 1 })
        continue
      }
      if (!entry.isFile()) continue
      if (!PREVIEW_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue
      try {
        const stat = await fs.stat(full)
        found.push({
          path: relative(root, full).split(sep).join('/'),
          size: stat.size,
          mtime: Math.round(stat.mtimeMs),
        })
      } catch {
        // A file that vanished mid-walk is simply not listed.
      }
    }
    if (truncated) break
  }
  found.sort((left, right) => right.mtime - left.mtime || left.path.localeCompare(right.path))
  return { files: found.slice(0, MAX_FILES), total: found.length, truncated }
}

/**
 * Serve the workspace Markdown listing.
 * @param req - the incoming request.
 * @param res - the response this handler owns end to end.
 */
export async function serveFind(req, res) {
  if (!methodAllowed(req, res)) return
  if (!accessAllowed(req, res)) return
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const cwd = url.searchParams.get('cwd') ?? ''
  if (typeof cwd !== 'string' || cwd.length === 0 || !isAbsolute(cwd) || cwd.length > MAX_PATH_CHARS) {
    return refuseJson(res, 400, 'missing or non-absolute workspace root')
  }
  let root
  try {
    root = await fs.realpath(cwd)
  } catch {
    return refuseJson(res, 400, 'workspace root is not readable')
  }
  const listing = await listMarkdownFiles(root)
  const body = Buffer.from(JSON.stringify(listing), 'utf8')
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  res.end(body)
}

/**
 * Where the vendored mermaid browser build lives, if this machine has one.
 *
 * mermaid is a documentation dependency, not a harness dependency, so it is
 * looked up rather than assumed: the profile's healed module tree first, then
 * the install the running server came from. A miss is not fatal — a document's
 * diagram then renders as the code block it is.
 */
const mermaidCandidates = []
let mermaidPath

/**
 * Resolve the mermaid bundle once, from the places a dsh install keeps it.
 * @returns the absolute path, or undefined when this machine has none.
 */
export function mermaidBundlePath() {
  if (mermaidPath !== undefined) return mermaidPath
  if (mermaidCandidates.length === 0) {
    // 1. Beside this plugin: `install.sh` copies the engine here when the host
    //    has one, which is the only location that cannot go stale or move.
    mermaidCandidates.push(fileURLToPath(new URL('./vendor/mermaid.min.js', import.meta.url)))
    const home = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
    // 2. The profile's healed module tree.
    mermaidCandidates.push(join(home, 'profiles', 'node_modules', 'mermaid', 'dist', 'mermaid.min.js'))
    // 3. Walk up from the running entry point (following symlinks, because the
    //    launcher may be invoked through one) to the install's node_modules,
    //    where pnpm keeps the package under .pnpm/mermaid@<version>/node_modules.
    let entry = process.argv[1]
    try {
      if (entry !== undefined) entry = realpathSync(entry)
    } catch {
      // An unresolvable entry point just means the walk starts from what we have.
    }
    let dir = entry === undefined ? '' : dirname(entry)
    while (dir !== '' && dir !== '/') {
      mermaidCandidates.push(join(dir, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js'))
      let entries = []
      try {
        entries = readdirSync(join(dir, 'node_modules', '.pnpm'))
      } catch {
        entries = []
      }
      for (const entry of entries) {
        if (entry.startsWith('mermaid@')) {
          mermaidCandidates.push(join(dir, 'node_modules', '.pnpm', entry, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js'))
        }
      }
      dir = dirname(dir)
    }
  }
  for (const candidate of mermaidCandidates) {
    try {
      if (statSync(candidate).isFile()) {
        mermaidPath = candidate
        return mermaidPath
      }
    } catch {
      // Try the next location.
    }
  }
  mermaidPath = undefined
  return undefined
}

/**
 * Serve the diagram engine.
 * @param req - the incoming request.
 * @param res - the response this handler owns end to end.
 */
export function serveMermaid(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    refuse(res, 405, 'method not allowed')
    return
  }
  // No origin check: this route serves a public JavaScript asset and nothing
  // else. A sandboxed canvas legitimately fetches it from an opaque origin, and
  // a page that could fetch it learns nothing it could not download elsewhere.
  const path = mermaidBundlePath()
  if (path === undefined) {
    refuse(res, 404, 'mermaid is not installed on this host; diagrams render as code blocks')
    return
  }
  let stat
  try {
    stat = statSync(path)
  } catch {
    refuse(res, 404, 'mermaid is not readable')
    return
  }
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_MERMAID_BYTES) {
    refuse(res, 413, 'mermaid bundle is unusable')
    return
  }
  res.writeHead(200, {
    'content-type': 'text/javascript; charset=utf-8',
    'content-length': String(stat.size),
    // Content-addressed by version on disk; a day of caching is safe and makes
    // the 3.5MB fetch a one-time cost per browser.
    'cache-control': 'private, max-age=86400',
    'x-content-type-options': 'nosniff',
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  readFile(path, (error, body) => {
    if (error) {
      res.destroy()
      return
    }
    res.end(body)
  })
}

/**
 * Serve one workspace HTML artifact for a sandboxed iframe.
 * @param req - the incoming request.
 * @param res - the response this handler owns end to end.
 */
export async function serveCanvas(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    refuse(res, 405, 'method not allowed')
    return
  }
  if (!sameOrigin(req)) {
    refuse(res, 403, 'cross-site request refused')
    return
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const decision = await resolveInside(url.searchParams.get('path') ?? '', url.searchParams.get('cwd') ?? '')
  if (decision.status !== 200) return refuse(res, decision.status, decision.reason)
  if (!CANVAS_EXTENSIONS.has(extname(decision.realPath).toLowerCase())) {
    return refuse(res, 415, 'not an html artifact')
  }
  if (decision.stat.size > MAX_CANVAS_BYTES) return refuse(res, 413, 'canvas is too large to render')
  let body
  try {
    body = await fs.readFile(decision.realPath)
  } catch {
    return refuse(res, 500, 'unable to read the artifact')
  }
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
    // The artifact runs its own scripts, but never with this origin's authority.
    'content-security-policy': "sandbox allow-scripts allow-forms allow-modals allow-popups",
    // Keep the full URL in the referrer so the host can recognise requests that
    // started from this page, which is how an artifact still loads a diagram
    // engine or one of the workspace's own images.
    'referrer-policy': 'unsafe-url',
    'x-content-type-options': 'nosniff',
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  res.end(body)
}

/**
 * Register the three routes for this plugin's lifetime.
 * @param ctx - the host plugin context carrying `webServer`.
 */
export function apply(ctx) {
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: FILE_ROUTE, handler: serveMarkdown }),
    'markdown-preview: markdown route',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: IMAGE_ROUTE, handler: serveImage }),
    'markdown-preview: image route',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: FIND_ROUTE, handler: serveFind }),
    'markdown-preview: find route',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: CANVAS_ROUTE, handler: serveCanvas }),
    'markdown-preview: canvas route',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: MERMAID_ROUTE, handler: serveMermaid }),
    'markdown-preview: diagram engine route',
  )
}
