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

const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
  Fragment: 'Fragment',
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
}

/** Minimal React reconciliation: invoke function components until elements are host nodes. */
function render(node) {
  if (node === null || typeof node !== 'object' || typeof node.type !== 'function') return node
  return render(node.type(node.props))
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
assert.equal(registeredDefinition.kind, 'image-path-gallery')
assert.equal(typeof registeredView, 'function')

const { collectImagePaths, messageOf } = client.internals

// Extraction: paths are taken, prose is not, remote URLs and fences are skipped.
{
  const items = collectImagePaths([
    '架构图见 docs/1产品介绍/images/mobile软件.png，另外看图 `src/a/b.png`。',
    '远程图 https://example.com/remote.png 不算。',
    '例子：`![x](./docs/example.png)` 在代码块里',
    '```sh',
    'cat plots/inside-fence.png',
    '```',
    '裸文件名 mobile软件.png 不算，因为它没有路径。',
  ].join('\n'))
  assert.deepEqual(items.map(item => item.path), [
    'docs/1产品介绍/images/mobile软件.png',
    'src/a/b.png',
    './docs/example.png',
  ])
  assert.equal(items[0].label, 'mobile软件.png', 'label is the basename')
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

// Message reading: only append-origin surface messages count.
{
  const assistant = {
    type: 'assistant/message',
    seq: 42,
    surfaceOp: 'append',
    data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'see a/b.png' }, { type: 'reasoning', text: 'c/d.png' }] } },
  }
  const read = messageOf(assistant)
  assert.deepEqual(read, { turn: 1, step: 2, text: 'see a/b.png' })
  assert.equal(messageOf({ ...assistant, surfaceOp: 'replace' }), null, 'a replacement copy is not the reader transcript')
  assert.equal(messageOf({ type: 'assistant/attempt', seq: 1, surfaceOp: 'append', data: {} }), null)
}

// Definition: match, start, and node materialization.
{
  const event = {
    type: 'assistant/message',
    seq: 42,
    surfaceOp: 'append',
    data: { turn: 3, step: 4, message: { content: [{ type: 'text', text: '见 docs/1产品介绍/images/mobile软件.png' }] } },
  }
  assert.deepEqual(registeredDefinition.match(event), { id: '42', role: 'start' })
  assert.equal(
    registeredDefinition.match({ ...event, data: { turn: 3, step: 4, message: { content: [{ type: 'text', text: '没有图片' }] } } }),
    null,
    'a message without an image path produces no node',
  )
  const context = {
    key: '18:image-path-gallery42',
    id: '42',
    matches: [{ event, location: { kind: 'unresolved' } }],
    start: { event, location: { kind: 'step' } },
  }
  const state = registeredDefinition.start(context, { event, location: { kind: 'step' } })
  assert.equal(state.items.length, 1)
  state.items = [] // start() derives items; the node is only materialized when some survive
  assert.equal(registeredDefinition.buildViewNode({ ...context, state }), null)

  const live = registeredDefinition.start(context, { event, location: { kind: 'step' } })
  const node = registeredDefinition.buildViewNode({ ...context, state: live })
  assert.equal(node.kind, 'image-path-gallery')
  assert.equal(node.anchorSeq, 42, 'the node anchors at its message')
  assert.equal(node.visibility, 'visible')
  assert.equal(node.data.items.length, 1)
}

// Rendering: one <img> per item, pointing at the host route.
{
  const node = { data: { items: [{ path: 'docs/1产品介绍/images/mobile软件.png', label: 'mobile软件.png' }] } }
  const tree = render(registeredView({ node, cwd: '/w', loadImage: async () => '', t: (key) => key }))
  assert.equal(tree.children.length, 1)
  const img = render(tree.children[0])
  assert.equal(img.type, 'img')
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
