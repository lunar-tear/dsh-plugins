/**
 * Smoke test for the dsh-image-paths halves, run with plain `node`.
 *
 * The browser half has no build step, so this drives it through the same
 * ModuleLoader handshake the shell performs and through the plugin's own
 * `apply`, then renders with a minimal React stub. The host half is exercised
 * against real files on disk.
 */
import { mkdir, mkdtemp, symlink, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

// ── browser half ────────────────────────────────────────────────────────────

let loaded
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      loaded = entry
    },
  },
}

// A React stub that also enforces the rules of hooks: it counts the hooks each
// component calls and refuses a render whose count differs from that
// component's previous render — React error #310.
const hookCounts = new Map()
let counting = null
let counted = 0

function useHook() {
  if (counting !== null) counted += 1
}

const React = {
  // React drops null/undefined children; this stub does too, so a conditional
  // child does not shift the counts the assertions below make.
  createElement: (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.flat().filter((child) => child !== null && child !== undefined),
  }),
  Fragment: 'Fragment',
  useState: (initial) => {
    useHook()
    return [initial, () => {}]
  },
  // Effects run once and are cleaned up immediately: enough to exercise what a
  // mount does (including the resolve lookup), without leaving a listener or an
  // interval behind.
  useEffect: (effect) => {
    useHook()
    const cleanup = effect()
    if (typeof cleanup === 'function') cleanup()
  },
}

/** Minimal React reconciliation: invoke function components until elements are host nodes. */
function render(node) {
  if (node === null || typeof node !== 'object' || typeof node.type !== 'function') return node
  const outerComponent = counting
  const outerCount = counted
  counting = node.type
  counted = 0
  let rendered
  try {
    rendered = node.type(node.props)
  } finally {
    const seen = hookCounts.get(counting)
    if (seen !== undefined && seen !== counted) {
      throw new Error(`rendered ${counted} hooks where the previous render called ${seen} (${counting.name})`)
    }
    hookCounts.set(counting, counted)
    counting = outerComponent
    counted = outerCount
  }
  return render(rendered)
}

// A document stub: the lightbox effect and the caption need nothing else.
globalThis.document = {
  addEventListener: () => {},
  removeEventListener: () => {},
  visibilityState: 'visible',
}

const fetchCalls = []
globalThis.fetch = (url, options) => {
  fetchCalls.push({ url, options })
  const target = String(url)
  const verdict = target.includes('/resolve')
    ? (target.includes('name=nope.png')
      ? { found: false, reason: 'no such file' }
      : { found: true, path: 'outputs/run7/retarget.png', matches: 3, truncated: false })
    : { found: false }
  return Promise.resolve({
    ok: true,
    status: 200,
    headers: { get: () => '"1-2"' },
    json: () => Promise.resolve(verdict),
  })
}

await import('./client.js')
assert.equal(loaded.id, 'dsh-image-paths', 'bundle registers under its package id')

const client = loaded.factory((specifier) => {
  assert.equal(specifier, 'react', 'the bundle only ever requires the platform React entry')
  return React
})

let registeredDefinition
let registeredView
const ctx = {
  uiConversation: { events: { register: (definition) => { registeredDefinition = definition } } },
  slots: {
    inject: (_name, register) => register(),
    register: (_declaration, component) => { registeredView = component },
  },
}
client.apply(ctx)
assert.equal(client.name, 'image-paths')
assert.deepEqual(client.inject, ['uiConversation', 'slots'])
assert.equal(registeredDefinition.kind, client.internals.KIND, 'the registered kind is the placement-carrying one')
assert.equal(typeof registeredView, 'function')

const { collectImagePaths, messageOf } = client.internals

// A bare filename is kept as an item to resolve, not dropped.
{
  const items = collectImagePaths('训练图 retarget.png 和 docs/a.png')
  assert.deepEqual(items.map((item) => [item.path, item.bare]), [
    ['retarget.png', true],
    ['docs/a.png', false],
  ], 'mention order, bare names flagged')
}

// Extraction: paths are taken, prose is not, remote URLs and fences are skipped.
{
  const items = collectImagePaths([
    '架构图见 docs/1产品介绍/images/mobile软件.png，另外看图 `src/a/b.png`。',
    '远程图 https://example.com/remote.png 不算。',
    '例子：`![x](./docs/example.png)` 在代码块里',
    '```sh',
    'cat plots/inside-fence.png',
    '```',
    '裸文件名 mobile软件.png 保留，交给 host 按文件名解析。',
  ].join('\n'))
  assert.deepEqual(items.map(item => item.path), [
    'docs/1产品介绍/images/mobile软件.png',
    'src/a/b.png',
    './docs/example.png',
    'mobile软件.png',
  ])
  assert.equal(items[0].label, 'mobile软件.png', 'label is the basename')
  assert.equal(items[0].bare, false, 'a path resolves on its own')
  assert.equal(items[3].bare, true, 'a bare filename is resolved by the host')
}

// Markdown image syntax is an explicit mention, so a bare filename is accepted there.
{
  const items = collectImagePaths('![ecmaster](ecmaster-zero.png)')
  assert.deepEqual(items.map(item => item.path), ['ecmaster-zero.png'])
}

// Dedupe and cap.
{
  const once = collectImagePaths('a/b.png and a/b.png again')
  assert.equal(once.length, 1, 'the same path is not repeated')
  const many = collectImagePaths(Array.from({ length: 20 }, (_, index) => `p/x${index}.png`).join(' '))
  assert.equal(many.length, 8, 'at most MAX_IMAGES per message')
}

// The kind is the placement lever: keys sort as "<kind length>:<kind><id>", so
// the gallery only lands below the message it belongs to while this name stays
// 50 characters long.
{
  assert.equal(client.internals.KIND.length, 50, 'the kind length is what puts the gallery below its message')
  const key = `${client.internals.KIND.length}:${client.internals.KIND}7`
  assert.ok(key > '4:user7', 'sorts below a user message')
  assert.ok(key > '14:assistant-step3:4', 'sorts below the assistant step node')
  // No assertion against a tool row: it anchors at its call's sequence and this
  // gallery at the result's, so the two never share an anchor to break the tie.
}

// Text extraction: prose and reasoning both count, and tool results are text too.
{
  const { contentText } = client.internals
  const content = [
    { type: 'reasoning', text: 'thinking about plots/a.png' },
    { type: 'text', text: 'the answer' },
    { type: 'tool-call', name: 'bash', arguments: '{}' },
  ]
  assert.equal(contentText(content), 'thinking about plots/a.png\nthe answer')
  assert.equal(contentText(content, 'reasoning'), 'thinking about plots/a.png')
  assert.equal(contentText(content, 'text'), 'the answer')
  assert.equal(contentText(null), '')
}

// The Definition: one gallery per step, covering prose, reasoning and tool output.
{
  const definition = registeredDefinition
  const message = (overrides) => ({
    type: 'assistant/message',
    seq: 42,
    surfaceOp: 'append',
    data: { turn: 3, step: 4, message: { content: [{ type: 'text', text: '见 docs/a.png' }] } },
    ...overrides,
  })
  assert.deepEqual(definition.match(message()), { id: 'a:3:4', role: 'start' })
  assert.equal(definition.match({ ...message(), surfaceOp: 'replace' }), null, 'a replacement copy is not the reader transcript')
  assert.equal(definition.match({ type: 'tool/call', seq: 1, surfaceOp: 'append', data: { turn: 3, step: 4 } }), null)
  assert.deepEqual(
    definition.match({ type: 'tool/result', seq: 43, surfaceOp: 'append', data: { turn: 3, step: 4, message: { content: [] } } }),
    { id: 'a:3:4', role: 'update' },
    'a tool result joins the step that asked for it',
  )
  assert.deepEqual(
    definition.match({ type: 'user/message', seq: 9, surfaceOp: 'append', data: { content: [{ type: 'text', text: 'x' }] } }),
    { id: 'm:9', role: 'start' },
    'a user message owns its own gallery',
  )

  const context = { key: `50:${client.internals.KIND}a:3:4`, id: 'a:3:4', matches: [], start: { event: message(), location: { kind: 'step' } } }

  // A message with no image path still yields a Context; it just materializes no node.
  const plain = definition.start(context, { event: message({ data: { turn: 3, step: 4, message: { content: [{ type: 'text', text: '没有图片' }] } } }) })
  assert.equal(definition.buildViewNode({ ...context, state: plain }), null, 'no path, no node')

  // Reasoning counts, and it is scanned from the same message.
  const thinking = definition.start(context, {
    event: message({ data: { turn: 3, step: 4, message: { content: [
      { type: 'reasoning', text: 'plot 落在 outputs/run7/curve.png' },
      { type: 'text', text: 'done' },
    ] } } }),
  })
  assert.deepEqual(thinking.items.map((item) => item.path), ['outputs/run7/curve.png'], 'a path in the thinking is an image too')

  // A tool result adds to the same step, and the node follows the latest evidence.
  const withTool = definition.update(
    { ...context, state: definition.start(context, { event: message() }) },
    { event: { type: 'tool/result', seq: 51, surfaceOp: 'append', data: { turn: 3, step: 4, message: { content: [{ type: 'text', text: 'saved logs/figures/sweep.png' }] } } } },
  )
  assert.deepEqual(withTool.items.map((item) => item.path), ['docs/a.png', 'logs/figures/sweep.png'])
  const node = definition.buildViewNode({ ...context, state: withTool })
  assert.equal(node.kind, client.internals.KIND)
  assert.equal(node.anchorSeq, 51, 'the node anchors at the last contributing event')
  assert.equal(node.visibility, 'visible')
  assert.equal(node.data.items.length, 2)

  // A huge tool result is scanned within a budget rather than in full.
  const huge = definition.update(
    { ...context, state: definition.start(context, { event: message() }) },
    { event: { type: 'tool/result', seq: 52, surfaceOp: 'append', data: { turn: 3, step: 4, message: { content: [
      { type: 'text', text: `${'x'.repeat(25000)} tail/too-late.png` },
    ] } } } },
  )
  assert.deepEqual(huge.items.map((item) => item.path), ['docs/a.png'], 'a path past the scan budget is not picked up')
}

// Rendering a bare filename: the host resolves it, and the caption says which
// file the token actually meant.
{
  const bare = { data: { items: [{ path: 'retarget.png', label: 'retarget.png', bare: true }] } }
  const pending = render(registeredView({ node: bare, cwd: '/w', t: (key) => key }))
  assert.equal(render(pending.children[0]), null, 'no picture renders while the name is unresolved')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.ok(fetchCalls.some((call) => String(call.url).startsWith('/plugin/image-paths/resolve')), 'the lookup went to the host route')
  const tree = render(registeredView({ node: bare, cwd: '/w', t: (key) => key }))
  const column = render(tree.children[0])
  assert.equal(column.children[0].type, 'img')
  assert.equal(
    column.children[0].props.src,
    '/plugin/image-paths/raw?path=outputs%2Frun7%2Fretarget.png&cwd=%2Fw',
    'the picture serves the path the host resolved',
  )
  assert.equal(column.children[1].children[0], 'retarget.png → outputs/run7/retarget.png', 'an ambiguous name says which file it picked')

  const missing = { data: { items: [{ path: 'nope.png', label: 'nope.png', bare: true }] } }
  await new Promise((resolve) => setTimeout(resolve, 0))
  render(registeredView({ node: missing, cwd: '/w', t: (key) => key }))
  await new Promise((resolve) => setTimeout(resolve, 0))
  const gone = render(registeredView({ node: missing, cwd: '/w', t: (key) => key }))
  assert.equal(render(gone.children[0]), null, 'an unresolvable name renders no picture')
}

// Rendering: one <img> per item, pointing at the host route.
{
  const node = { data: { items: [{ path: 'docs/1产品介绍/images/mobile软件.png', label: 'mobile软件.png' }] } }
  const tree = render(registeredView({ node, cwd: '/w', loadImage: async () => '', t: (key) => key }))
  assert.equal(tree.children.length, 1)
  const column = render(tree.children[0])
  assert.equal(column.type, 'div', 'each image sits in its own column so a caption can follow it')
  const img = column.children[0]
  assert.equal(img.type, 'img')
  assert.equal(column.children.length, 1, 'a path with a directory needs no caption')
  assert.equal(
    img.props.src,
    '/plugin/image-paths/raw?path=docs%2F1%E4%BA%A7%E5%93%81%E4%BB%8B%E7%BB%8D%2Fimages%2Fmobile%E8%BD%AF%E4%BB%B6.png&cwd=%2Fw',
  )
  assert.equal(img.props.alt, 'mobile软件.png')
  assert.equal(img.props.loading, 'lazy', 'thumbnails load lazily')

  // No workspace root means no authorized resolution: render nothing at all.
  assert.equal(registeredView({ node, cwd: undefined, t: (key) => key }), null)
  assert.equal(registeredView({ node: { data: { items: [] } }, cwd: '/w' }), null)
}

// ── host half ───────────────────────────────────────────────────────────────

const host = await import('./index.js')
assert.equal(host.name, 'image-paths')
assert.deepEqual(host.inject, ['webServer'])

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
])
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(64, 3)])
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(64, 1)])

assert.equal(host.sniffMediaType(PNG.subarray(0, 12)), 'image/png')
assert.equal(host.sniffMediaType(JPEG.subarray(0, 12)), 'image/jpeg')
assert.equal(host.sniffMediaType(GIF.subarray(0, 12)), 'image/gif')
assert.equal(host.sniffMediaType(Buffer.from('not an image')), undefined)

assert.equal(host.containedIn('/w/a.png', '/w'), true)
assert.equal(host.containedIn('/w/sub/a.png', '/w'), true)
assert.equal(host.containedIn('/w-other/a.png', '/w'), false, 'a name-prefix sibling is not inside')
assert.equal(host.containedIn('/etc/passwd', '/w'), false)

{
  const parent = await mkdtemp(join(tmpdir(), 'image-paths-'))
  const root = join(parent, 'workspace')
  try {
    await mkdir(root)
    await writeFile(join(parent, 'outside.png'), PNG)
    await writeFile(join(root, 'ok.png'), PNG)
    await writeFile(join(root, 'mismatch.png'), JPEG)
    await writeFile(join(root, 'notes.txt'), PNG)
    await writeFile(join(root, 'empty.png'), Buffer.alloc(0))
    await symlink(join(parent, 'outside.png'), join(root, 'link.png'))

    const ok = await host.resolveImageTarget('ok.png', root)
    assert.equal(ok.status, 200)
    assert.equal(ok.mediaType, 'image/png')
    assert.equal(ok.size, PNG.length)

    assert.equal((await host.resolveImageTarget('missing.png', root)).status, 404)
    assert.equal((await host.resolveImageTarget('notes.txt', root)).status, 415, 'extension must claim an image')
    assert.equal((await host.resolveImageTarget('mismatch.png', root)).status, 415, 'magic bytes must match the extension')
    assert.equal((await host.resolveImageTarget('empty.png', root)).status, 404)
    assert.equal((await host.resolveImageTarget('../outside.png', root)).status, 403, 'parent traversal is refused')
    assert.equal((await host.resolveImageTarget('link.png', root)).status, 403, 'a symlink out of the workspace is refused')
    assert.equal((await host.resolveImageTarget('/etc/hosts.png', root)).status, 404)
    assert.equal((await host.resolveImageTarget('', root)).status, 400)
    assert.equal((await host.resolveImageTarget('ok.png', 'relative/path')).status, 400)
    assert.equal((await host.resolveImageTarget('ok.png', join(root, 'nope'))).status, 400)
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
}

{
  const hostHeader = { host: '127.0.0.1:3080' }
  assert.equal(host.sameOrigin({ headers: { ...hostHeader, 'sec-fetch-site': 'same-origin' } }), true)
  assert.equal(host.sameOrigin({ headers: { ...hostHeader, 'sec-fetch-site': 'none' } }), true)
  assert.equal(host.sameOrigin({ headers: { ...hostHeader, 'sec-fetch-site': 'cross-site' } }), false, 'a visited page cannot probe local files')
  assert.equal(host.sameOrigin({ headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' } }), true)
  assert.equal(host.sameOrigin({ headers: { host: '127.0.0.1:3080', origin: 'http://evil.test' } }), false)
  assert.equal(host.sameOrigin({ headers: hostHeader }), true, 'a non-browser caller (curl) is loopback-trusted')
  assert.equal(host.sameOrigin({ headers: { host: 'evil.test', 'sec-fetch-site': 'same-origin' } }), false, 'a rebound hostname is refused')
  assert.equal(host.sameOrigin({ headers: { host: '192.168.1.10:3080' } }), false, 'only loopback hosts are answered')
  assert.equal(host.loopbackHost({ headers: { host: 'localhost:3080' } }), true)
  assert.equal(host.loopbackHost({ headers: { host: '[::1]:3080' } }), true)
  assert.equal(host.loopbackHost({ headers: {} }), false)
}

console.log('image-paths smoke test: all assertions passed')
