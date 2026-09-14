/**
 * dsh-image-paths — host half.
 *
 * One read-only HTTP route that serves a single local image file to the chat
 * UI, so an image path written in assistant prose can render as the picture
 * itself instead of a string the reader has to go find.
 *
 * Why a route rather than a durable session event: the only way the browser can
 * read image bytes through the shipped client is an attachment referenced by a
 * session event, and an out-of-tree event type makes the session log
 * unreadable — the persistence read path refuses any type outside
 * `KNOWN_SESSION_EVENT_TYPES` unless the writer marks it `ignorable: true`,
 * which `Session.append` cannot set. This route carries the bytes with no
 * durable footprint at all, and it works for messages already in the log.
 *
 * Threat model: the webserver is loopback-bound, and the route only ever
 * returns a file that (a) carries a supported image extension, (b) resolves by
 * real path inside the caller-supplied session workspace root, and (c) begins
 * with that format's magic bytes. Cross-site browser requests are refused, so
 * a page the user happens to visit cannot use it to probe local files.
 */

import { createReadStream, promises as fs } from 'node:fs'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'

/** Cordis plugin name. */
export const name = 'image-paths'

/** Required service: the route registry and request dispatch. */
export const inject = ['webServer']

/** Route prefix owned by this plugin; the client appends `/raw` semantics itself. */
export const ROUTE = '/plugin/image-paths/raw'
/**
 * Basename lookup route: the fallback for a path a message only named, e.g.
 * `retarget.png` with no directory. Always answers 200 with a JSON verdict, so
 * a name that cannot be resolved costs no failed request in the browser console.
 */
export const RESOLVE_ROUTE = '/plugin/image-paths/resolve'

/** Refuse anything larger than this: the browser only ever shows a preview. */
const MAX_BYTES = 32 * 1024 * 1024
/** Vector images are markup; this bound keeps one from becoming a payload. */
const MAX_SVG_BYTES = 8 * 1024 * 1024

/** Refuse pathologically long inputs before touching the filesystem. */
const MAX_PATH_CHARS = 4096

/** Directory entries visited by one basename index walk. */
const MAX_WALK_ENTRIES = 6000
/** Directory depth visited by one basename index walk. */
const MAX_WALK_DEPTH = 6
/** How long a workspace basename index is reused. */
const INDEX_TTL_MS = 15000
/** Image extensions a basename lookup may resolve to. */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
/** Directories a basename walk never enters: dependencies, builds, VCS. */
const SKIP_DIRECTORIES = new Set([
  'node_modules', 'dist', 'build', 'out', 'target', 'venv', 'vendor',
  '__pycache__', 'site-packages', 'third_party', 'thirdparty',
  'third_party_libs', 'thirdparty_libs', 'external', 'extern', 'deps', '_deps',
  'subprojects', 'installed',
])

/** Extension → the media type that extension must then prove with its magic bytes. */
export const DECLARED_MEDIA_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  // Vector images are how architecture diagrams usually leave their tool, and
  // an <img> never runs a script inside one — the element, not the route, is
  // what keeps SVG safe here.
  ['.svg', 'image/svg+xml'],
])

/**
 * Identify one supported image format from its leading bytes. The extension
 * only declares a format; these bytes are what the response actually claims.
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

/**
 * Whether one real path sits inside a real root, separators included so a
 * sibling directory sharing a name prefix cannot pass.
 * @param realPath - resolved real path of the candidate file.
 * @param realRoot - resolved real path of the workspace root.
 * @returns true when the file is the root itself or lies beneath it.
 */
export function containedIn(realPath, realRoot) {
  if (realPath === realRoot) return true
  const prefix = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`
  return realPath.startsWith(prefix)
}

/**
 * Validate one request against the filesystem and decide the response.
 *
 * Every refusal is a status plus a short reason; no path is echoed back beyond
 * what the caller already sent, and no directory listing is ever performed.
 * @param requested - the path exactly as the assistant wrote it.
 * @param cwd - the session workspace root the client supplied.
 * @returns the decision: `{ status, reason }` for a refusal or `{ status: 200, realPath, mediaType, size }`.
 */
export async function resolveImageTarget(requested, cwd) {
  if (typeof requested !== 'string' || requested.length === 0 || requested.length > MAX_PATH_CHARS) {
    return { status: 400, reason: 'missing or overlong path' }
  }
  if (requested.includes('\0')) return { status: 400, reason: 'invalid path' }
  if (typeof cwd !== 'string' || cwd.length === 0 || cwd.length > MAX_PATH_CHARS || !isAbsolute(cwd)) {
    return { status: 400, reason: 'missing or non-absolute workspace root' }
  }
  const declared = DECLARED_MEDIA_TYPES.get(extname(requested).toLowerCase())
  if (declared === undefined) return { status: 415, reason: 'not a supported image extension' }

  let realRoot
  try {
    realRoot = await fs.realpath(cwd)
  } catch {
    return { status: 400, reason: 'workspace root is not readable' }
  }

  // The authored path may be relative (workspace-relative) or absolute; both
  // resolve against the root, and the containment test then decides.
  const candidate = isAbsolute(requested) ? resolve(requested) : resolve(realRoot, requested)
  let realPath
  try {
    realPath = await fs.realpath(candidate)
  } catch {
    return { status: 404, reason: 'no such file' }
  }
  if (!containedIn(realPath, realRoot)) return { status: 403, reason: 'outside the session workspace' }

  let stat
  try {
    stat = await fs.stat(realPath)
  } catch {
    return { status: 404, reason: 'no such file' }
  }
  if (!stat.isFile()) return { status: 404, reason: 'not a regular file' }
  if (stat.size === 0) return { status: 404, reason: 'empty file' }
  if (stat.size > MAX_BYTES) return { status: 413, reason: 'image is too large to display' }

  let head
  if (declared !== 'image/svg+xml') {
    const handle = await fs.open(realPath, 'r')
    try {
      const buffer = Buffer.alloc(12)
      const { bytesRead } = await handle.read(buffer, 0, 12, 0)
      head = buffer.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
  }
  // SVG has no magic bytes to sniff: its bytes are text, so the check is that
  // the document really is one.
  if (declared === 'image/svg+xml') {
    if (stat.size > MAX_SVG_BYTES) return { status: 413, reason: 'svg is too large to display' }
    const handle = await fs.open(realPath, 'r')
    let start
    try {
      const buffer = Buffer.alloc(1024)
      const { bytesRead } = await handle.read(buffer, 0, 1024, 0)
      start = buffer.subarray(0, bytesRead).toString('utf8')
    } finally {
      await handle.close()
    }
    if (!/<svg[\s>]|<\?xml/i.test(start)) return { status: 415, reason: 'content is not an svg document' }
    return { status: 200, realPath, mediaType: declared, size: stat.size }
  }

  const sniffed = sniffMediaType(head)
  if (sniffed === undefined) return { status: 415, reason: 'content is not a supported image' }
  if (sniffed !== declared) return { status: 415, reason: 'content does not match the file extension' }

  return { status: 200, realPath, mediaType: sniffed, size: stat.size }
}

/**
 * Whether the request's `Host` names the loopback interface.
 *
 * This is the DNS-rebinding guard: a page on `evil.test` that resolves that
 * name to 127.0.0.1 would be same-origin *after* rebinding, so only a Host that
 * is literally loopback is answered. A deployment that binds the GUI to a
 * non-loopback interface must widen this.
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
 * Whether the request may be answered at all. A browser always sends
 * `Sec-Fetch-Site`; anything cross-site is refused. Without that header the
 * caller is not a browser page (curl, a test), and loopback reachability is
 * the whole access model — the same trust the rest of the local GUI assumes.
 * @param req - the incoming request.
 * @returns true when the request is same-origin or not a browser request.
 */
export function sameOrigin(req) {
  if (!loopbackHost(req)) return false
  if (pluginPageReferer(req)) return true
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

/**
 * Whether one request came from a page a plugin of this collection served.
 *
 * A sandboxed canvas runs in an opaque origin, so its own requests carry no
 * usable origin — but they do carry the URL of the page they started from. That
 * is how an HTML artifact can still show a workspace image.
 * @param req - the incoming request.
 * @returns true when the referring page is served by the plugins themselves.
 */
export function pluginPageReferer(req) {
  const referer = req.headers.referer
  if (typeof referer !== 'string' || referer === '') return false
  try {
    const url = new URL(referer)
    if (url.host !== req.headers.host) return false
    return url.pathname.startsWith('/plugin/')
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

/** Cached basename index per workspace root: one bounded walk serves many lookups. */
const indexCache = new Map()

/**
 * Index a workspace's image files by basename, newest first, with a bounded
 * walk: at most {@link MAX_WALK_ENTRIES} entries, {@link MAX_WALK_DEPTH}
 * levels, no build or dependency directory, no dot-directory, and no symlink
 * (a `Dirent` for one is neither a file nor a directory here).
 * @param root - the resolved workspace root.
 * @returns basename → rows, newest first, plus whether the walk hit its bound.
 */
export async function indexImages(root) {
  const cached = indexCache.get(root)
  if (cached !== undefined && Date.now() - cached.at < INDEX_TTL_MS) return cached.index
  const byName = new Map()
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
      if (!IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue
      let stat
      try {
        stat = await fs.stat(full)
      } catch {
        continue
      }
      const rows = byName.get(entry.name) ?? []
      rows.push({ path: full, mtime: Math.round(stat.mtimeMs), size: stat.size })
      byName.set(entry.name, rows)
    }
    if (truncated) break
  }
  for (const rows of byName.values()) rows.sort((left, right) => right.mtime - left.mtime)
  const index = { byName, truncated }
  indexCache.set(root, { at: Date.now(), index })
  return index
}

/**
 * Resolve a bare image filename inside one workspace.
 *
 * A name that matches exactly one file resolves to it. A name that matches
 * several resolves to the **newest** match and reports how many there were, so
 * the reader is shown a picture plus the path it actually came from rather than
 * a silently wrong run's figure; the caller decides how loudly to say so.
 * @param root - the resolved workspace root.
 * @param name - the bare filename, without a directory.
 * @returns the verdict the route serializes.
 */
export async function resolveByName(root, name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_PATH_CHARS) {
    return { found: false, reason: 'missing or overlong name' }
  }
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) {
    return { found: false, reason: 'not a bare filename' }
  }
  if (!IMAGE_EXTENSIONS.has(extname(name).toLowerCase())) {
    return { found: false, reason: 'not a supported image extension' }
  }
  const index = await indexImages(root)
  const rows = index.byName.get(name)
  if (rows === undefined || rows.length === 0) return { found: false, reason: 'no such file' }
  const newest = rows[0]
  return {
    found: true,
    path: relative(root, newest.path).split(sep).join('/'),
    absolute: newest.path,
    matches: rows.length,
    truncated: index.truncated,
  }
}

/**
 * Answer one basename lookup. Always 200 with a verdict, so a name that does
 * not resolve leaves no failed request in the browser console.
 * @param req - the incoming request.
 * @param res - the response this handler owns end to end.
 */
export async function serveResolve(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    refuse(res, 405, 'method not allowed')
    return
  }
  if (!sameOrigin(req)) {
    refuse(res, 403, 'cross-site request refused')
    return
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const cwd = url.searchParams.get('cwd') ?? ''
  if (typeof cwd !== 'string' || cwd.length === 0 || cwd.length > MAX_PATH_CHARS || !isAbsolute(cwd)) {
    refuse(res, 400, 'missing or non-absolute workspace root')
    return
  }
  let root
  try {
    root = await fs.realpath(cwd)
  } catch {
    refuse(res, 400, 'workspace root is not readable')
    return
  }
  const verdict = await resolveByName(root, url.searchParams.get('name') ?? '')
  const body = Buffer.from(JSON.stringify(verdict), 'utf8')
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
 * Serve one image request.
 * @param req - the incoming request (method, URL, and cross-site headers).
 * @param res - the response this handler owns end to end.
 */
export async function serveImage(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    refuse(res, 405, 'method not allowed')
    return
  }
  if (!sameOrigin(req)) {
    refuse(res, 403, 'cross-site request refused')
    return
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const decision = await resolveImageTarget(
    url.searchParams.get('path') ?? '',
    url.searchParams.get('cwd') ?? '',
  )
  if (decision.status !== 200) {
    refuse(res, decision.status, decision.reason)
    return
  }
  res.writeHead(200, {
    'content-type': decision.mediaType,
    'content-length': String(decision.size),
    // Session-scoped bytes behind a loopback route: cacheable briefly, never shared.
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
    // The response is already committed; a truncated body is the honest outcome.
    res.destroy()
  }
}

/**
 * Register the image route for this plugin's lifetime.
 * @param ctx - the host plugin context carrying `webServer`.
 */
export function apply(ctx) {
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler: serveImage }),
    'image-paths: image route',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: RESOLVE_ROUTE, handler: serveResolve }),
    'image-paths: basename route',
  )
}
