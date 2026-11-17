// @vitest-environment jsdom
/** Shared file menus insert references through the Session's real draft editor. */
import { expect, it, onTestFinished, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { MenuRegistry } from '@deepseek-ai/dsh-client-ui-context-menu/src/client/registry.ts'
import { SessionInputShell } from '@deepseek-ai/dsh-client-ui-conversation/src/client/input/facade.ts'
import { ComposerBlockRegistry } from '@deepseek-ai/dsh-client-ui-conversation/src/client/input/blocks.ts'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ContextMenuTargetMap } from '@deepseek-ai/dsh-client-ui-context-menu/client'
import { registerReferenceMenu } from '../src/client/context-menu.ts'
import { en, zh } from '../src/client/locales.ts'

const id = 'target' as SessionId
const actionId = 'reference.file/addToChat'

async function bench() {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.ctx.effect(() => locale.register('reference', { en, zh }))
  locale.setLocale('en')
  await runtime.declare({ 'contextMenu.icon': { kind: 'keyed', scope: 'root', inline: true } })
  await runtime.sessions.add({ id, summary: { cwd: '/workspace' } })
  const owner = runtime.sessions.retain(id)
  onTestFinished(() => { owner.release() })
  const binding = runtime.sessions.binding(id)!
  const sink = vi.fn(async () => ({ kind: 'success' as const }))
  const blocks = new ComposerBlockRegistry()
  const shell = new SessionInputShell({
    actx: binding.ctx, defaultSink: sink,
    commandAttachments: { serialize: async () => [], release: () => {}, unsupportedNotice: token => token },
    session: () => binding.session.getSnapshot(),
    composerBlock: () => blocks.storeFor(id).getSnapshot(),
  })
  onTestFinished(() => { shell.dispose() })
  const focus = vi.spyOn(shell, 'focus').mockImplementation(() => {})
  const resolveInput = vi.fn(() => shell)
  runtime.ctx.provide('conversation', { input: { for: resolveInput } })
  const failed = vi.fn()
  const menus = new MenuRegistry(failed)
  onTestFinished(() => { menus.dispose() })
  runtime.ctx.provide('contextMenus', { register: menus.register.bind(menus) })
  const fiber = runtime.ctx.plugin({
    inject: ['slots', 'sessions', 'conversation', 'contextMenus', 'locale'],
    apply: (ctx) => { registerReferenceMenu(ctx, locale.bind('reference')) },
  })
  await fiber.await()
  const menu = async (value: Partial<ContextMenuTargetMap['file']> = {}) => {
    const result = menus.resolve({ kind: 'file', value: { sessionId: id, path: 'docs/a b.md', ...value } })
    onTestFinished(() => { result.dispose() })
    await result.ready
    return result
  }
  return { runtime, locale, owner, binding, shell, sink, focus, blocks, resolveInput, failed, menus, fiber, menu }
}

it('appends the final action after other providers and inserts the captured file without sending', async () => {
  const b = await bench()
  const ready = Promise.withResolvers<undefined>()
  b.menus.register({ id: 'open', target: 'file', order: 100, resolve: async () => {
    await ready.promise
    return [{ id: 'preview', label: 'Preview' }]
  } })
  b.menus.register({ id: 'save', target: 'file', order: 200, resolve: () => [{ id: 'download', label: 'Download' }] })
  b.shell.setDraft('Review this')
  const pending = b.menu({ line: 24 })
  ready.resolve(undefined)
  const menu = await pending
  expect(menu.source.getSnapshot().map(row => row.label)).toEqual(['Preview', 'Download', en['menu.addToChat']])
  expect(menu.source.getSnapshot().at(-1)).toMatchObject({ separatorBefore: true, disabled: false })
  menu.select(actionId)
  expect(b.resolveInput).toHaveBeenCalledWith(b.binding.ctx)
  expect(b.shell.snapshot.draft).toBe('Review this @"/workspace/docs/a b.md" ')
  expect(b.shell.snapshot.occurrences).toMatchObject([{
    source: 'reference', ref: '@"/workspace/docs/a b.md"', label: 'a b.md', appearance: 'file',
  }])
  expect(b.shell.snapshot.attachmentIds).toEqual([])
  expect(b.focus).toHaveBeenCalledOnce()
  expect(b.sink).not.toHaveBeenCalled()
  expect(b.failed).not.toHaveBeenCalled()
})

it.each(['bad"name.txt', 'bad\nname.txt'])('disables paths outside the mention grammar: %j', async (path) => {
  const b = await bench()
  const menu = await b.menu({ path })
  expect(menu.source.getSnapshot()[0]?.disabled).toBe(true)
  menu.select(actionId)
  expect(b.shell.snapshot.draft).toBe('')
  expect(b.focus).not.toHaveBeenCalled()
})

it('disables an unretained Session and never opens it or targets another draft', async () => {
  const b = await bench()
  const menu = await b.menu({ sessionId: 'absent' as SessionId })
  expect(menu.source.getSnapshot()[0]?.disabled).toBe(true)
  expect(b.resolveInput).not.toHaveBeenCalled()
  menu.select(actionId)
  expect(b.shell.snapshot.draft).toBe('')
})

it('reads composer blocks when the menu opens and rechecks them at execution', async () => {
  const b = await bench()
  b.blocks.set(id, { reason: 'Unavailable' })
  expect((await b.menu()).source.getSnapshot()[0]?.disabled).toBe(true)
  b.blocks.set(id, undefined)
  const menu = await b.menu()
  expect(menu.source.getSnapshot()[0]?.disabled).toBe(false)
  b.blocks.set(id, { reason: 'Unavailable' })
  // An open menu keeps the state read when it opened; execution refuses the stale action.
  expect(menu.source.getSnapshot()[0]?.disabled).toBe(false)
  menu.select(actionId)
  expect(b.failed).toHaveBeenCalledWith(en['menu.addToChatFailed'])
  expect(b.shell.snapshot.draft).toBe('')
  expect(b.focus).not.toHaveBeenCalled()
})

it('rejects a stale Session binding at execution', async () => {
  const b = await bench()
  const menu = await b.menu()
  b.owner.release()
  menu.select(actionId)
  expect(b.failed).toHaveBeenCalledWith(en['menu.addToChatFailed'])
  expect(b.focus).not.toHaveBeenCalled()
})

it('disables removed and one-shot Sessions but permits continuable Sessions', async () => {
  const b = await bench()
  await b.runtime.sessions.updateSessionSnapshot(id, (state) => { state.removed = true })
  expect((await b.menu()).source.getSnapshot()[0]?.disabled).toBe(true)
  await b.runtime.sessions.updateSessionSnapshot(id, (state) => {
    state.removed = false
    state.subagent = { address: { parentSessionId: 'parent' as SessionId, childSessionId: id, mode: 'one-shot' } }
  })
  expect((await b.menu()).source.getSnapshot()[0]?.disabled).toBe(true)
  await b.runtime.sessions.updateSessionSnapshot(id, (state) => {
    state.subagent = { address: { parentSessionId: 'parent' as SessionId, childSessionId: id, mode: 'continuable' } }
  })
  expect((await b.menu()).source.getSnapshot()[0]?.disabled).toBe(false)
})

it('disables the action while a submission owns the draft but not while a turn runs', async () => {
  const b = await bench()
  const pending = Promise.withResolvers<{ kind: 'success' }>()
  b.sink.mockImplementation(() => pending.promise)
  await b.runtime.sessions.updateSessionSnapshot(id, (state) => { state.running = true })
  expect((await b.menu()).source.getSnapshot()[0]?.disabled).toBe(false)
  b.shell.setDraft('Sending')
  b.shell.submit()
  expect((await b.menu()).source.getSnapshot()[0]?.disabled).toBe(true)
  pending.resolve({ kind: 'success' })
  await vi.waitFor(() => { expect(b.shell.snapshot.phase).toBe('plain') })
  expect((await b.menu()).source.getSnapshot()[0]?.disabled).toBe(false)
})

it('reports insertion refusal without focusing or sending', async () => {
  const b = await bench()
  vi.spyOn(b.shell, 'addReferences').mockReturnValue(false)
  const menu = await b.menu()
  menu.select(actionId)
  expect(b.failed).toHaveBeenCalledWith(en['menu.addToChatFailed'])
  expect(b.focus).not.toHaveBeenCalled()
  expect(b.sink).not.toHaveBeenCalled()
})

it('withdraws open menu actions and their icon on plugin disposal', async () => {
  const b = await bench()
  const menu = await b.menu()
  expect(b.runtime.ctx.slots.entries('contextMenu.icon').map(row => row.options.key)).toEqual(['reference.addToChat'])
  await b.fiber.dispose()
  expect(menu.source.getSnapshot()).toEqual([])
  expect(b.runtime.ctx.slots.entries('contextMenu.icon')).toEqual([])
  menu.select(actionId)
  expect(b.focus).not.toHaveBeenCalled()
  expect(zh['menu.addToChat']).toBe('添加到对话')
})

it('refreshes open labels and failure feedback when the locale changes', async () => {
  const b = await bench()
  const menu = await b.menu()
  const unavailable = await b.menu({ sessionId: 'absent' as SessionId })
  expect(menu.source.getSnapshot()[0]?.label).toBe(en['menu.addToChat'])
  expect(unavailable.source.getSnapshot()[0]?.label).toBe(en['menu.addToChat'])
  b.locale.setLocale('zh')
  expect(menu.source.getSnapshot()[0]?.label).toBe(zh['menu.addToChat'])
  expect(unavailable.source.getSnapshot()[0]?.label).toBe(zh['menu.addToChat'])
  vi.spyOn(b.shell, 'addReferences').mockReturnValue(false)
  menu.select(actionId)
  expect(b.failed).toHaveBeenCalledWith(zh['menu.addToChatFailed'])
  await b.fiber.dispose()
  b.locale.setLocale('en')
  expect(unavailable.source.getSnapshot()).toEqual([])
})

it.each(['/work/a b.md', 'C:\\work\\a b.md', '\\\\server\\share\\a b.md', '/work/a b.md/'])(
  'uses the final nonempty path segment as the reference label: %j', async (path) => {
    const b = await bench()
    const menu = await b.menu({ path })
    menu.select(actionId)
    expect(b.shell.snapshot.occurrences).toMatchObject([{ label: 'a b.md', ref: `@"${path}"` }])
  },
)

it('disables the action and refuses direct insertion after the draft editor is disposed', async () => {
  const b = await bench()
  b.shell.setDraft('Keep this')
  b.shell.dispose()
  expect((await b.menu()).source.getSnapshot()[0]?.disabled).toBe(true)
  expect(b.shell.addReferences([{ source: 'reference', ref: '@file.txt', label: 'file.txt', clipboardText: '@file.txt' }])).toBe(false)
  expect(b.shell.snapshot.draft).toBe('Keep this')
})
