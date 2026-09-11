/**
 * Smoke test for the dsh-markdown-preview halves, run with plain `node`.
 *
 * The browser half has no build step, so this drives it through the real
 * `__ModuleLoader__.load` handshake and the plugin's own `apply`, with a
 * minimal React stub and a stubbed fetch. The host half is exercised against
 * real files on disk.
 */
import { mkdir, mkdtemp, symlink, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

// ── browser half ────────────────────────────────────────────────────────────

let loaded
globalThis.window = { __ModuleLoader__: { load(entry) { loaded = entry } } }

const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
  Fragment: 'Fragment',
  useState: (initial) => [initial, () => {}],
  // Effects run once and are cleaned up immediately: enough to exercise what a
  // mount does, while leaving no interval behind.
  useEffect: (effect) => {
    const cleanup = effect()
    if (typeof cleanup === 'function') cleanup()
  },
  useMemo: (factory) => factory(),
  useRef: (initial) => ({ current: initial }),
}

/** Minimal React reconciliation: invoke function components until elements are host nodes. */
function render(node) {
  if (node === null || typeof node !== 'object' || typeof node.type !== 'function') return node
  return render(node.type(node.props))
}

const MarkdownText = function MarkdownText() { return null }
const icon = (name) => function Icon() { return name }
const primitives = {
  MarkdownText,
  IconBrowseOutline16: icon('browse'),
  IconCloseOutline16: icon('close'),
  IconRefreshOutline16: icon('refresh'),
  IconChevronDownOutline14: icon('chevron'),
}

// A document stub rich enough for ensureStyles().
const styles = []
globalThis.document = {
  head: { appendChild: (tag) => styles.push(tag) },
  createElement: () => ({ dataset: {}, textContent: '' }),
  querySelector: () => null,
  visibilityState: 'visible',
  addEventListener: () => {},
  removeEventListener: () => {},
}

const fetchCalls = []
globalThis.fetch = (url, options) => {
  fetchCalls.push({ url, options })
  return Promise.resolve({
    ok: true,
    status: 200,
    headers: { get: () => '"1-2"' },
    json: () => Promise.resolve({ files: [], truncated: false }),
    text: () => Promise.resolve('# hello'),
  })
}

await import('./client.js')
assert.equal(loaded.id, 'dsh-markdown-preview', 'bundle registers under its package id')

const client = loaded.factory((specifier) => {
  if (specifier === 'react') return React
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error(`unexpected require: ${specifier}`)
})

const { collectMarkdownPaths, resolveFromDocument, rewriteLocalImages, messageText } = client.internals

// Mentions: paths are collected, prose and remote links are not.
{
  const paths = collectMarkdownPaths([
    '设计说明见 docs/design/overview.md，另外 `src/kuavo/README.md` 也更新了。',
    '远程文档 https://example.com/guide.md 不算。',
    '```sh',
    'cat notes/inside-fence.md',
    '```',
    'README.md 这种裸文件名也算（会在工作区根目录找）。',
  ].join('\n'))
  assert.deepEqual(paths, ['docs/design/overview.md', 'src/kuavo/README.md', 'README.md'])
}

// Dedupe and cap.
{
  assert.equal(collectMarkdownPaths('a/b.md and a/b.md').length, 1)
  assert.equal(collectMarkdownPaths(Array.from({ length: 20 }, (_, i) => `p/x${i}.md`).join(' ')).length, 12)
}

// Document-relative resolution, including the escape refusal.
{
  assert.equal(resolveFromDocument('docs/design/overview.md', 'figure.png'), 'docs/design/figure.png')
  assert.equal(resolveFromDocument('docs/design/overview.md', './figure.png'), 'docs/design/figure.png')
  assert.equal(resolveFromDocument('docs/design/overview.md', '../img/a.png'), 'docs/img/a.png')
  assert.equal(resolveFromDocument('README.md', 'docs/x.png'), 'docs/x.png')
  assert.equal(resolveFromDocument('docs/design/overview.md', '../../../../etc/x.png'), null, 'an escaping path resolves to nothing')
  assert.equal(resolveFromDocument('docs/a.md', '/abs/x.png'), '/abs/x.png')
}

// Image rewriting: only what the host can actually serve is rewritten.
{
  const doc = 'docs/design/overview.md'
  const cwd = '/w'
  const rewritten = rewriteLocalImages([
    '![本地](figure.png)',
    '![上级](../img/a.png)',
    '![远程](https://example.com/x.png)',
    '![家目录](~/x.png)',
    '![越界](../../../outside.png)',
    '![工作区内绝对](/w/docs/abs.png)',
    '![工作区外绝对](/elsewhere/x.png)',
  ].join('\n'), doc, cwd)
  const lines = rewritten.split('\n')
  assert.ok(lines[0].includes('/plugin/markdown-preview/image?path=docs%2Fdesign%2Ffigure.png&cwd=%2Fw'), lines[0])
  assert.ok(lines[1].includes('path=docs%2Fimg%2Fa.png'), lines[1])
  assert.equal(lines[2], '![远程](https://example.com/x.png)')
  assert.equal(lines[3], '![家目录](~/x.png)')
  assert.equal(lines[4], '![越界](../../../outside.png)', 'a destination escaping the workspace is left alone')
  assert.ok(lines[5].includes('path=%2Fw%2Fdocs%2Fabs.png'), lines[5])
  assert.equal(lines[6], '![工作区外绝对](/elsewhere/x.png)', 'an absolute path outside the workspace is left alone')
  // A title survives the rewrite.
  assert.ok(rewriteLocalImages('![a](figure.png "标题")', doc, cwd).includes('"标题"'))
}

// Message reading honours the surface-op gate.
{
  const event = {
    type: 'assistant/message',
    seq: 7,
    surfaceOp: 'append',
    data: { message: { content: [{ type: 'text', text: 'see docs/a.md' }] } },
  }
  assert.equal(messageText(event), 'see docs/a.md')
  assert.equal(messageText({ ...event, surfaceOp: 'replace' }), null)
  assert.equal(messageText({ type: 'assistant/attempt', seq: 1, surfaceOp: 'append', data: {} }), null)
}

// Plugin state: mentions, follow targeting, session tracking.
{
  const s = client.internals
  s.reset()
  s.mention('docs/a.md')
  s.mention('docs/b.md')
  s.mention('docs/a.md')
  assert.deepEqual(s.state().mentioned, ['docs/a.md', 'docs/b.md'], 'newest first, deduplicated')
  assert.equal(s.followTarget(s.state()), 'docs/a.md')
  s.update({ rejected: ['docs/a.md'] })
  assert.equal(s.followTarget(s.state()), 'docs/b.md', 'a rejected file is skipped')
  s.selectPath('docs/c.md')
  assert.equal(s.state().manual, true, 'an explicit choice stops the automatic follow')
  assert.equal(s.state().path, 'docs/c.md')
  s.trackSession('s2', '/w2')
  assert.deepEqual(s.state().rejected, [], 'a session switch clears the rejections')
  assert.equal(s.state().cwd, '/w2')
}

// apply(): registrations, the toggle button, and the drawer.
let definition
let toggleRegistration
let overlayRegistration
const dictionaries = []
const ctx = {
  effect: (factory) => { factory(); return () => {} },
  locale: {
    register: (ns, dicts) => { dictionaries.push({ ns, dicts }); return () => {} },
    bind: () => (key) => `t:${key}`,
  },
  uiConversation: { events: { register: (value) => { definition = value } } },
  slots: {
    inject: (_name, register) => register(),
    register: (declaration, component) => {
      if (declaration.name === 'conversation.session.header.utilities') toggleRegistration = { declaration, component }
      if (declaration.name === 'shell.overlay') overlayRegistration = { declaration, component }
      return () => {}
    },
  },
}
client.apply(ctx)
assert.equal(client.name, 'markdown-preview')
assert.deepEqual(client.inject, ['uiConversation', 'slots', 'locale'])
assert.equal(dictionaries.length, 1, 'one namespace registered')
assert.equal(dictionaries[0].ns, 'markdown-preview')
assert.ok(dictionaries[0].dicts.zh.title.length > 0, 'Chinese copy ships')
assert.ok(dictionaries[0].dicts.en.title.length > 0, 'English copy ships')
assert.equal(toggleRegistration.declaration.id, 'markdown-preview')
assert.equal(overlayRegistration.declaration.id, 'markdown-preview')
assert.ok(styles.length >= 1, 'the stylesheet is injected')

// The Definition collects mentions in message order.
{
  client.internals.reset()
  assert.equal(definition.kind, 'markdown-preview-mention')
  assert.equal(definition.target, undefined, 'a state-only Definition publishes no node')
  const event = {
    type: 'assistant/message',
    seq: 11,
    surfaceOp: 'append',
    data: { message: { content: [{ type: 'text', text: '先看 docs/a.md 再看 docs/b.md' }] } },
  }
  assert.deepEqual(definition.match(event), { id: '11', role: 'start' })
  definition.start({}, { event })
  assert.deepEqual(client.internals.state().mentioned, ['docs/a.md', 'docs/b.md'])
  assert.equal(definition.match({ ...event, data: { message: { content: [{ type: 'text', text: 'no file here' }] } } }), null)
}

// The toggle button opens and closes the drawer.
{
  const useSessions = (selector) => selector({ byId: { s1: { cwd: '/w' } } })
  const toggle = render(toggleRegistration.component({ sessionId: 's1', useSessions, t: (key) => key }))
  assert.equal(toggle.type, 'button')
  assert.equal(toggle.props['data-active'], 'false')
  assert.equal(client.internals.state().cwd, '/w', 'the toggle tracks the current session workspace')
  toggle.props.onClick()
  assert.equal(client.internals.state().open, true)
  const active = render(toggleRegistration.component({ sessionId: 's1', useSessions, t: (key) => key }))
  assert.equal(active.props['data-active'], 'true')
  assert.equal(active.props['aria-pressed'], true)
}

// The drawer: closed renders nothing, open renders the panel with its copy.
{
  client.internals.reset()
  assert.equal(render(overlayRegistration.component({})), null, 'nothing is mounted while closed')
  client.internals.selectPath('docs/design/overview.md')
  client.internals.update({ open: true })
  const drawer = render(overlayRegistration.component({}))
  assert.equal(drawer.type, 'aside')
  assert.equal(drawer.props.style.width, '460px')
  assert.equal(drawer.props['aria-label'], 't:title')
  const parts = drawer.children.filter(Boolean).map((child) => child.type)
  assert.ok(parts.includes('div'), 'the header and body are rendered')
  const header = drawer.children.filter(Boolean)[1]
  const pathLabel = header.children.filter(Boolean).find((child) => child.props && child.props.className === 'dsv-mp-path')
  assert.equal(pathLabel.children[0], 'docs/design/overview.md', 'the path is shown in the header')
  client.internals.update({ open: false })
}

// ── host half ───────────────────────────────────────────────────────────────

const host = await import('./index.js')
assert.equal(host.name, 'markdown-preview')
assert.deepEqual(host.inject, ['webServer'])
assert.equal(host.FILE_ROUTE, '/plugin/markdown-preview/file')
assert.equal(host.IMAGE_ROUTE, '/plugin/markdown-preview/image')
assert.equal(host.FIND_ROUTE, '/plugin/markdown-preview/find')

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)])

{
  const parent = await mkdtemp(join(tmpdir(), 'md-preview-'))
  const root = join(parent, 'workspace')
  try {
    await mkdir(join(root, 'docs', 'design'), { recursive: true })
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(join(root, 'README.md'), '# Title\n\n![fig](docs/design/figure.png)\n')
    await writeFile(join(root, 'docs', 'design', 'overview.md'), '# Overview\n')
    await writeFile(join(root, 'docs', 'design', 'figure.png'), PNG)
    await writeFile(join(root, 'notes.txt'), 'not markdown')
    await writeFile(join(parent, 'outside.md'), '# outside')
    await writeFile(join(root, 'node_modules', 'pkg', 'ignored.md'), '# ignored')
    await symlink(join(parent, 'outside.md'), join(root, 'linked.md'))

    const ok = await host.resolveInside('docs/design/overview.md', root)
    assert.equal(ok.status, 200)
    assert.equal((await host.resolveInside('', root)).status, 400)
    assert.equal((await host.resolveInside('missing.md', root)).status, 404)
    assert.equal((await host.resolveInside('../outside.md', root)).status, 403, 'parent traversal is refused')
    assert.equal((await host.resolveInside('linked.md', root)).status, 403, 'a symlink out of the workspace is refused')
    assert.equal((await host.resolveInside('docs/design/overview.md', 'relative/root')).status, 400)

    const listing = await host.listMarkdownFiles(root)
    assert.deepEqual(listing.files.map((entry) => entry.path).sort(), ['README.md', 'docs/design/overview.md'])
    assert.equal(listing.truncated, false)
    assert.ok(!listing.files.some((entry) => entry.path.includes('node_modules')), 'dependency directories are skipped')

    // Route handlers answer end to end against a stub response.
    function stubResponse() {
      const captured = { status: 0, headers: null, body: null }
      return {
        captured,
        writeHead(status, headers) { captured.status = status; captured.headers = headers },
        end(body) { if (body !== undefined) captured.body = body },
        destroy() {},
      }
    }
    const request = (url, headers = {}) => ({ method: 'GET', url, headers: { host: '127.0.0.1:3080', ...headers } })

    const fileResponse = stubResponse()
    await host.serveMarkdown(request(`${host.FILE_ROUTE}?path=${encodeURIComponent('README.md')}&cwd=${encodeURIComponent(root)}`), fileResponse)
    assert.equal(fileResponse.captured.status, 200)
    assert.match(fileResponse.captured.headers['content-type'], /text\/markdown/)
    assert.ok(String(fileResponse.captured.body).includes('# Title'))
    const etag = fileResponse.captured.headers.etag

    const cached = stubResponse()
    await host.serveMarkdown(request(`${host.FILE_ROUTE}?path=README.md&cwd=${encodeURIComponent(root)}`, { 'if-none-match': etag }), cached)
    assert.equal(cached.captured.status, 304, 'an unchanged file revalidates to 304')

    const notMarkdown = stubResponse()
    await host.serveMarkdown(request(`${host.FILE_ROUTE}?path=notes.txt&cwd=${encodeURIComponent(root)}`), notMarkdown)
    assert.equal(notMarkdown.captured.status, 415)

    const crossSite = stubResponse()
    await host.serveMarkdown(request(`${host.FILE_ROUTE}?path=README.md&cwd=${encodeURIComponent(root)}`, { 'sec-fetch-site': 'cross-site' }), crossSite)
    assert.equal(crossSite.captured.status, 403)

    const rebound = stubResponse()
    await host.serveMarkdown(request(`${host.FILE_ROUTE}?path=README.md&cwd=${encodeURIComponent(root)}`, { host: 'evil.test' }), rebound)
    assert.equal(rebound.captured.status, 403, 'a rebound hostname is refused')

    const imageResponse = stubResponse()
    await host.serveImage(request(`${host.IMAGE_ROUTE}?path=${encodeURIComponent('docs/design/figure.png')}&cwd=${encodeURIComponent(root)}`), imageResponse)
    assert.equal(imageResponse.captured.status, 200)
    assert.equal(imageResponse.captured.headers['content-type'], 'image/png')

    const badImage = stubResponse()
    await host.serveImage(request(`${host.IMAGE_ROUTE}?path=notes.txt&cwd=${encodeURIComponent(root)}`), badImage)
    assert.equal(badImage.captured.status, 415)

    const findResponse = stubResponse()
    await host.serveFind(request(`${host.FIND_ROUTE}?cwd=${encodeURIComponent(root)}`), findResponse)
    assert.equal(findResponse.captured.status, 200)
    const parsed = JSON.parse(String(findResponse.captured.body))
    assert.deepEqual(parsed.files.map((entry) => entry.path).sort(), ['README.md', 'docs/design/overview.md'])
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
}

console.log('markdown-preview smoke test: all assertions passed')
