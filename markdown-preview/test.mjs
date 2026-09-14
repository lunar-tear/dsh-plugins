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

// A React stub that also enforces the rules of hooks: it counts the hooks each
// component calls and refuses a render whose count differs from that
// component's previous render — exactly React error #310, which is the class of
// bug this stub exists to catch (`useMemo` after an early return crashed the
// real drawer in the browser).
const hookCounts = new Map()
let counting = null
let counted = 0

function useHook() {
  if (counting !== null) counted += 1
}

const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
  Fragment: 'Fragment',
  useState: (initial) => {
    useHook()
    return [initial, () => {}]
  },
  // Effects run once and are cleaned up immediately: enough to exercise what a
  // mount does, while leaving no interval behind.
  useEffect: (effect) => {
    useHook()
    const cleanup = effect()
    if (typeof cleanup === 'function') cleanup()
  },
  useMemo: (factory) => {
    useHook()
    return factory()
  },
  useRef: (initial) => {
    useHook()
    return { current: initial }
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

const MarkdownText = function MarkdownText() { return null }
const icon = (name) => function Icon() { return name }
const primitives = {
  MarkdownText,
  IconBrowseOutline16: icon('browse'),
  IconCloseOutline16: icon('close'),
  IconRefreshOutline16: icon('refresh'),
  IconChevronDownOutline14: icon('chevron'),
}

// A localStorage stub: remembering the last shown file per workspace is what
// makes a reopened drawer land straight on a document.
const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)) },
  removeItem: (key) => { storage.delete(key) },
}

// A document stub rich enough for ensureStyles().
const styles = []
globalThis.document = {
  head: { appendChild: (tag) => styles.push(tag) },
  createElement: () => ({ dataset: {}, textContent: '', remove: () => {} }),
  querySelectorAll: () => [],
  querySelector: () => null,
  visibilityState: 'visible',
  addEventListener: () => {},
  removeEventListener: () => {},
}

const fetchCalls = []
/** What the host lists for this workspace; the blocks below keep it in step with their setup. */
let findPaths = ['docs/design/overview.md', 'readme.md']
globalThis.fetch = (url, options) => {
  fetchCalls.push({ url, options })
  return Promise.resolve({
    ok: true,
    status: 200,
    headers: { get: () => '"1-2"' },
    json: () => Promise.resolve({
      files: findPaths.map((path) => ({ path, size: 10, mtime: 1 })),
      truncated: false,
    }),
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

// Plugin state: per-session mentions, follow targeting, session tracking.
{
  const s = client.internals
  s.reset()
  s.trackSession('s1', '/w')
  s.reportMentions('s1', ['docs/a.md', 'docs/b.md'])
  s.reportMentions('s1', ['docs/b.md'])
  assert.deepEqual(s.state().mentionsBySession.s1, ['docs/b.md', 'docs/a.md'], 'newest first, per session')
  assert.deepEqual(s.mentionsOf(s.state()), ['docs/b.md', 'docs/a.md'], 'read through the current session')
  assert.equal(s.followTarget(s.state()), null, 'without a listing the drawer waits for it')
  s.update({ filesStatus: 'ready', files: [{ path: 'docs/a.md' }, { path: 'docs/b.md' }], filePaths: ['docs/a.md', 'docs/b.md'] })
  assert.equal(s.followTarget(s.state()), 'docs/b.md', 'the newest mentioned file that exists here')
  s.update({ rejected: ['docs/b.md'] })
  assert.equal(s.followTarget(s.state()), 'docs/a.md', 'a failed file is skipped for the next mention')
  s.selectPath('docs/c.md')
  assert.equal(s.state().manual, true, 'an explicit choice stops the automatic follow')
  assert.equal(s.state().path, 'docs/c.md')

  // Switching conversations switches the panel: the new session has its own list.
  s.trackSession('s2', '/w2')
  assert.deepEqual(s.mentionsOf(s.state()), [], 'a session that named nothing shows nothing')
  assert.equal(s.followTarget(s.state()), null)
  s.reportMentions('s2', ['docs/plan.md'])
  s.update({ filesStatus: 'ready', files: [{ path: 'docs/plan.md' }], filePaths: ['docs/plan.md'] })
  assert.equal(s.followTarget(s.state()), 'docs/plan.md', 'and follows the new conversation')
  assert.deepEqual(s.state().mentionsBySession.s1, ['docs/b.md', 'docs/a.md'], 'the other session keeps its own list')
}

// apply(): registrations, the toggle button, and the drawer.
let definition
let toggleRegistration
const chatNodeRegistrations = new Map()
let overlayRegistration
const dictionaries = []
const layoutCalls = []
const mentionService = {
  forClosing: () => ({
    resolve: (value) => (value === 'produced.txt' ? { label: value, title: value, open: () => {} } : undefined),
  }),
}
const ctx = {
  get: (name) => {
    if (name === 'layout') return { closeDetails: () => layoutCalls.push('closeDetails') }
    if (name === 'chatFileMentions') return mentionService
    return undefined
  },
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
      if (declaration.name === 'conversation.chat.node') chatNodeRegistrations.set(declaration.key, { declaration, component })
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
assert.ok(String(styles[0].dataset.pluginCss).startsWith('markdown-preview:'), 'the tag is keyed by the sheet content, so a hot-reloaded bundle replaces it')
// The panel's share contract: the document owns it, the file lists are an
// aside capped at a fifth of the height.
{
  const css = String(styles[0].textContent)
  assert.match(css, /\.dsv-mp-picker\{[^}]*max-height:20vh/, 'the file lists are capped at a fifth of the panel')
  assert.match(css, /\.dsv-mp-body\{[^}]*flex:1/, 'the document body takes everything else')
  assert.ok(!/\.dsv-mp-list\{[^}]*max-height/.test(css), 'the lists do not scroll separately from the aside that holds them')
}

// The Definition collects mentions in message order.
{
  client.internals.reset()
  assert.equal(definition.kind, 'markdown-preview-mention')
  assert.equal(definition.target, 'chat', 'the Definition publishes the chips node')
  const event = {
    type: 'assistant/message',
    seq: 11,
    surfaceOp: 'append',
    data: { message: { content: [{ type: 'text', text: '先看 docs/a.md 再看 docs/b.md' }] } },
  }
  assert.deepEqual(definition.match(event), { id: '11', role: 'start' })
  const state = definition.start({}, { event })
  assert.deepEqual(state.paths, ['docs/a.md', 'docs/b.md'], 'the Definition publishes the paths it found')
  assert.equal(definition.match({ ...event, data: { message: { content: [{ type: 'text', text: 'no file here' }] } } }), null)
}

// The toggle button opens and closes the drawer.
{
  const useSessions = (selector) => selector({ byId: { s1: { cwd: '/w' } } })
  const toggleProps = (running) => ({
    sessionId: 's1',
    useSessions,
    useSession: (selector) => selector({ running }),
    t: (key) => key,
  })
  const toggle = render(toggleRegistration.component(toggleProps(false)))
  assert.equal(toggle.type, 'button')
  assert.equal(toggle.props['data-active'], 'false')
  assert.equal(client.internals.state().cwd, '/w', 'the toggle tracks the current session workspace')
  toggle.props.onClick()
  assert.equal(client.internals.state().open, true)
  const active = render(toggleRegistration.component(toggleProps(false)))
  assert.equal(active.props['data-active'], 'true')
  assert.equal(active.props['aria-pressed'], true)
}

// The drawer: closing and opening must keep the same hook order. Rendering it
// closed first and then open is the exact sequence that failed in the browser
// with React #310 (a hook sat after the closed-state early return).
{
  client.internals.reset()
  client.internals.trackSession('s1', '/w')
  const overlay = overlayRegistration.component({})
  assert.equal(render(overlay), null, 'nothing is mounted while closed')
  assert.equal(render(overlay), null, 'rendering closed twice is stable')
  client.internals.selectPath('docs/design/overview.md')
  client.internals.update({ open: true })
  const drawer = render(overlay)
  assert.equal(drawer.type, 'aside')
  assert.equal(drawer.props.style.width, `${client.internals.initialWidth()}px`, 'the opening width follows the viewport, not a fixed 460px')
  // A sidebar that leaves the conversation readable; the drag may go wider.
  assert.equal(client.internals.initialWidth(), 540, '45% of the 1200px test viewport')
  assert.ok(client.internals.maxWidth() <= 1200 - 240, 'the frame keeps a strip visible however wide the drawer is dragged')
  assert.equal(drawer.props['aria-label'], 't:title')
  const parts = drawer.children.filter(Boolean).map((child) => child.type)
  assert.ok(parts.includes('div'), 'the header and body are rendered')
  const header = drawer.children.filter(Boolean)[1]
  const pathLabel = header.children.filter(Boolean).find((child) => child.props && child.props.className === 'dsv-mp-path')
  assert.equal(pathLabel.children[0], 'docs/design/overview.md', 'the path is shown in the header')

  // Opening loaded the workspace listing, and the picker renders its rows.
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
  const state = client.internals.state()
  assert.equal(state.filesStatus, 'ready', 'the drawer loads the workspace listing when it opens')
  assert.deepEqual(state.filePaths, ['docs/design/overview.md', 'readme.md'])
  assert.ok(fetchCalls.some((call) => String(call.url).startsWith('/plugin/markdown-preview/find')), 'the listing came from the host route')

  // Re-render with the listing in place, then close again.
  const opened = render(overlayRegistration.component({}))
  assert.equal(opened.type, 'aside')
  client.internals.update({ open: false })
  assert.equal(render(overlayRegistration.component({})), null, 'closing renders nothing again')
}

// Selection order: this conversation's Markdown, then the reader's own choice,
// and never a document the conversation did not name.
{
  const s = client.internals
  const ready = (paths) => {
    findPaths = paths
    s.update({ filesStatus: 'ready', files: paths.map((path) => ({ path })), filePaths: paths })
  }
  storage.clear()   // this block is about the conversation, not the remembered file
  s.reset()
  s.trackSession('s1', '/w')
  assert.equal(s.followTarget(s.state()), null, 'no mentions and no listing yet: nothing to show')

  s.reportMentions('s1', ['docs/b.md', 'docs/a.md'])
  ready(['docs/a.md'])
  assert.equal(s.followTarget(s.state()), 'docs/a.md', 'a mention the workspace confirms, over an unlisted one')
  s.update({ rejected: ['docs/a.md'] })
  assert.equal(s.followTarget(s.state()), null, 'with nothing confirmed there is nothing to show — not some other document')

  // A vendored README the conversation also named loses to the document it is
  // actually working on.
  ready(['third_party_libs/x-1.0/README.md', 'docs/a.md'])
  s.update({ rejected: [] })
  assert.equal(s.followTarget(s.state()), 'docs/a.md')

  // The reader's explicit choice survives a session that names nothing.
  s.selectPath('docs/notes.md')
  s.reset()
  s.trackSession('s1', '/w')
  ready(['docs/notes.md'])
  assert.equal(s.followTarget(s.state()), 'docs/notes.md', 'reopening returns to the remembered file')

  // Huge documents are still scanned within a budget rather than in full.
  assert.equal(client.internals.isDependencyPath('third_party_libs/x/README.md'), true)
  assert.equal(client.internals.isDependencyPath('docs/design/overview.md'), false)
}

// The chips node: the placement contract, and the row itself.
{
  const { KIND } = client.internals
  assert.ok(KIND.length >= 50 && KIND.length <= 59, 'the kind length puts the chips below the message')
  const key = `${KIND.length}:${KIND}7`
  assert.ok(key > '4:user7', 'sorts below a user message')
  assert.ok(key > '14:assistant-step3:4', 'sorts below the assistant message')

  const event = {
    type: 'assistant/message',
    seq: 21,
    surfaceOp: 'append',
    data: { message: { content: [{ type: 'text', text: '方案已写入 docs/implementation_plan.md，另外读了 packages/client/AGENTS.md' }] } },
  }
  const context = { key: `${KIND.length}:${KIND}21`, id: '21', matches: [], start: { event, location: { kind: 'step' } } }
  const state = definition.start(context, { event, location: { kind: 'step' } })
  const node = definition.buildViewNode({ ...context, state })
  assert.equal(node.kind, KIND, 'the node carries the placement-carrying kind')
  assert.equal(node.anchorSeq, 21)
  assert.deepEqual(node.data.paths, ['docs/implementation_plan.md', 'packages/client/AGENTS.md'])
  assert.equal(definition.buildViewNode({ ...context, state: { paths: [] } }), null, 'a message naming no Markdown publishes no node')

  // The row only offers files the workspace listing confirms, so a chip always
  // opens something. While the listing is not ready it renders nothing.
  client.internals.reset()
  const chipsRegistration = chatNodeRegistrations.get(KIND)
  assert.ok(chipsRegistration !== undefined, 'the chips renderer is registered into the chat node seat')
  const renderChips = (node) => render(chipsRegistration.component({ node, t: (key, params) => `${key}` }))

  assert.equal(renderChips(node), null, 'no chips before the listing is ready')
  // The list is per session, and it is recorded even while the chips cannot be
  // drawn yet — that is what makes switching conversations switch the panel.
  client.internals.reset()
  render(chipsRegistration.component({ node, sessionId: 's9', t: (key) => key }))
  assert.deepEqual(
    client.internals.state().mentionsBySession.s9,
    ['docs/implementation_plan.md', 'packages/client/AGENTS.md'],
    'the renderer files the message\'s paths under its own session',
  )
  assert.deepEqual(client.internals.mentionsOf({ sessionId: 's9', mentionsBySession: { s9: ['x.md'] } }), ['x.md'])
  client.internals.trackSession('s1', '/w')
  client.internals.update({
    filesStatus: 'ready',
    files: [{ path: 'docs/implementation_plan.md' }],
    filePaths: ['docs/implementation_plan.md'],
  })
  const row = renderChips(node)
  assert.equal(row.type, 'div')
  assert.equal(row.props.className, 'dsv-mp-chips')
  assert.equal(row.children.length, 1, 'a path outside this workspace is not offered as a chip')
  const chip = row.children[0]
  assert.equal(chip.type, 'button')
  const chipText = chip.children.flat().filter(Boolean).map((part) => (part.children ? part.children[0] : null))
  assert.deepEqual(chipText, ['docs/', 'implementation_plan.md'], 'the chip shows the directory muted and the name bold')
  chip.props.onClick()
  const state2 = client.internals.state()
  assert.equal(state2.open, true, 'clicking a chip opens the panel')
  assert.equal(state2.path, 'docs/implementation_plan.md', 'on the file the chip named')
  client.internals.update({ open: false })
}

// The deep link: a pasted URL opens the panel on the document it names, and the
// conversation's own following does not override it afterwards.
{
  const s = client.internals
  s.reset()
  globalThis.location = { search: '?preview=docs%2Fplan.md' }
  assert.equal(s.adoptDeepLink(), true, 'the query is adopted')
  assert.equal(s.state().open, true)
  assert.equal(s.state().path, 'docs/plan.md')
  assert.equal(s.state().manual, true, 'a linked document is not overridden by the conversation')
  globalThis.location = { search: '?preview=notes.txt' }
  assert.equal(s.adoptDeepLink(), false, 'a non-Markdown target is ignored')
  globalThis.location = { search: '?other=1' }
  assert.equal(s.adoptDeepLink(), false, 'no preview key, nothing to adopt')
  delete globalThis.location
  s.update({ open: false, manual: false })
}

// Prose mentions: a Markdown path this workspace has opens the panel; anything
// else keeps resolving through the provider that was already there.
{
  assert.ok(mentionService.forClosing.__dshMarkdownPreview === true, 'the shipped mention provider is wrapped')
  const owner = { turn: {}, seq: 1, openFile: () => {} }
  const resolver = mentionService.forClosing(owner)
  client.internals.reset()
  client.internals.trackSession('s1', '/w')
  client.internals.update({ filesStatus: 'ready', files: [{ path: 'docs/plan.md' }], filePaths: ['docs/plan.md'] })

  const mention = resolver.resolve('`docs/plan.md`'.replace(/`/g, ''))
  assert.ok(mention !== undefined, 'a listed Markdown file becomes a mention')
  assert.equal(mention.title, 'docs/plan.md')
  mention.open()
  assert.equal(client.internals.state().open, true, 'clicking it opens the panel')
  assert.equal(client.internals.state().path, 'docs/plan.md', 'on that file')

  assert.equal(resolver.resolve('docs/missing.md'), undefined, 'a path outside the workspace stays unresolved')
  assert.equal(resolver.resolve('notes.txt'), undefined, 'a non-Markdown token is left to the other provider')
  const theirs = resolver.resolve('produced.txt')
  assert.ok(theirs !== undefined && theirs.label === 'produced.txt', 'the original provider still answers')

  // The pure resolver: exact row, or a unique basename.
  assert.equal(client.internals.resolveListedPath('docs/plan.md'), 'docs/plan.md')
  client.internals.update({ filePaths: ['docs/plan.md', 'other/plan.md'] })
  assert.equal(client.internals.resolveListedPath('plan.md'), null, 'two rows sharing a basename stay inert')
  client.internals.update({ filePaths: ['docs/plan.md'] })
  assert.equal(client.internals.resolveListedPath('plan.md'), 'docs/plan.md', 'a unique basename resolves')
  assert.equal(client.internals.previewMention('notes.txt'), undefined)
  assert.equal(client.internals.previewMention(42), undefined)
}

// Auto-open: a document named while the conversation is running opens the panel
// by itself; entering an old conversation does not, and neither does a file the
// reader already closed.
{
  const s = client.internals
  const useSessions = (selector) => selector({ byId: { s1: { cwd: '/w' } } })
  const props = (running) => ({
    sessionId: 's1',
    useSessions,
    useSession: (selector) => selector({ running }),
    t: (key) => key,
  })
  const readyWith = (paths) => {
    findPaths = paths
    s.update({ filesStatus: 'ready', files: paths.map((path) => ({ path })), filePaths: paths })
  }

  s.reset()
  s.trackSession('s1', '/w')
  s.reportMentions('s1', ['docs/plan.md'])
  readyWith(['docs/plan.md'])
  render(toggleRegistration.component(props(false)))
  // Mounting the toggle reloads the listing; a real React re-runs the effect
  // when it comes back, so the test lets that settle before rendering again.
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(s.state().open, false, 'browsing a conversation that already named a document does not pop the panel')

  render(toggleRegistration.component(props(true)))
  assert.equal(s.state().open, true, 'a document named while the conversation runs opens the panel')
  assert.equal(s.state().path, 'docs/plan.md')

  // Closing it is a dismissal: the same document does not reopen.
  client.internals.closePanel()
  assert.equal(s.state().open, false)
  assert.equal(client.internals.dismissedFor(s.state()), 'docs/plan.md', 'the closed file is remembered for this session')
  render(toggleRegistration.component(props(true)))
  assert.equal(s.state().open, false, 'the file the reader closed stays closed')

  // A different document named later opens again.
  s.reportMentions('s1', ['docs/next.md'])
  readyWith(['docs/plan.md', 'docs/next.md'])
  render(toggleRegistration.component(props(true)))
  assert.equal(s.state().open, true, 'a newly named document opens the panel')
  assert.equal(s.state().path, 'docs/next.md')
  client.internals.closePanel()

  // The switch turns the whole behavior off.
  s.update({ autoOpen: false, open: false })
  s.reportMentions('s1', ['docs/third.md'])
  readyWith(['docs/plan.md', 'docs/next.md', 'docs/third.md'])
  render(toggleRegistration.component(props(true)))
  assert.equal(s.state().open, false, 'with the switch off nothing opens by itself')
  s.update({ autoOpen: true, open: false })

  // An explicit choice is not stolen by a document that arrives later.
  s.selectPath('docs/plan.md')
  render(toggleRegistration.component(props(true)))
  assert.equal(s.state().path, 'docs/plan.md', 'a file the reader picked stays put')
  s.update({ open: false, manual: false })
}

// Opening the panel collapses the frame's own right column.
{
  client.internals.reset()
  client.internals.trackSession('s1', '/w')
  layoutCalls.length = 0
  client.internals.update({ open: false })
  render(overlayRegistration.component({}))
  assert.deepEqual(layoutCalls, [], 'nothing collapses while the panel is closed')
  client.internals.update({ open: true })
  render(overlayRegistration.component({}))
  assert.deepEqual(layoutCalls, ['closeDetails'], 'opening the panel collapses the details column')
  client.internals.update({ open: false })
}

// An explicit choice is remembered per workspace, and reopening prefers it.
{
  const s = client.internals
  const ready = (paths) => {
    findPaths = paths
    s.update({ filesStatus: 'ready', files: paths.map((path) => ({ path })), filePaths: paths })
  }
  s.reset()
  s.trackSession('s1', '/w')
  ready(['a.md', 'b.md'])
  s.selectPath('b.md')
  assert.equal(storage.get('dsh-markdown-preview:/w'), 'b.md', 'the choice is stored for this workspace')
  assert.equal(s.state().manual, true, 'an explicit choice stops the automatic follow')

  // A reopened page: the remembered file comes back unless the conversation
  // this session belongs to named one, which is the follow feature.
  s.reset()
  s.trackSession('s1', '/w')
  ready(['a.md', 'b.md'])
  assert.equal(s.followTarget(s.state()), 'b.md', 'reopening returns to the remembered file')
  s.reportMentions('s1', ['a.md'])
  assert.equal(s.followTarget(s.state()), 'a.md', 'a mentioned file takes precedence over the remembered one')
  s.update({ rejected: ['a.md'] })
  assert.equal(s.followTarget(s.state()), 'b.md', 'and the remembered file is the fallback again')
  s.update({ rejected: ['a.md', 'b.md'] })
  assert.equal(s.followTarget(s.state()), null, 'with both failed the drawer says so instead of guessing')
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
