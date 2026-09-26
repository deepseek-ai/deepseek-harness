// @vitest-environment jsdom
import { render, cleanup } from '@testing-library/react'
import { $getRoot, $isTextNode, PASTE_COMMAND } from 'lexical'
import { projectUserText } from '@deepseek-ai/dsh-client-ui-primitives'
import { registerComposerKeymap } from '../src/client/input/editor/keymap.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { CommandContribution, CommandUiContract } from '@deepseek-ai/dsh-client-ui-commands/client'
import type { ISession, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import {
  SlotTestRuntime, stubConfigForm, usePinnedBrowserLanguages,
} from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionBehaviorOverrides } from '@deepseek-ai/dsh-client-test-runtime'
import {
  apply, inject, type ComposerBarInjected, type ConversationInjected,
  type ConversationSessionHeaderInjected, type ConversationSessionInjected, type ViewTab,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { createConversationStore } from '../src/client/stores.ts'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'

usePinnedBrowserLanguages('zh-CN')

const ROOT = 'root-1' as SessionId

type ConversationInstance = ReturnType<ReturnType<typeof createConversationStore>['create']>
type ConversationActions = ConversationInstance['actions']

function sessionFakeFor() {
  return {
    loadOlder: vi.fn<ISession['loadOlder']>(() => Promise.resolve()),
    prompt: vi.fn<ISession['prompt']>(() => Promise.resolve({ ok: true, value: { accepted: true } })),
    cancel: vi.fn<ISession['cancel']>(() => Promise.resolve({ ok: true, value: { accepted: true } })),
  } satisfies SessionBehaviorOverrides
}

async function bench() {
  const runtime = await SlotTestRuntime.create()
  const rootUpload = vi.fn(() => Promise.resolve({
    ok: true as const,
    value: {
      receiptId: 'root-receipt' as never,
      file: { attachmentId: 'root-file' as never, name: 'draft.pdf', bytes: 1 },
    },
  }))
  const uploads = new Map<SessionId, (...args: unknown[]) => Promise<unknown>>([[ROOT, rootUpload]])
  runtime.fileUpload.upload = (sessionId: SessionId, ...args: unknown[]) => {
    const upload = uploads.get(sessionId)
    if (upload === undefined) throw new Error('test file upload has no Session fixture')
    return upload(...args)
  }
  const developerTools = createSnapshotStore(true)
  runtime.ctx.provide('configForms', {
    developerTools: {
      enabled: developerTools,
      setEnabled: async (enabled: boolean) => { developerTools.set(enabled) },
    },
    get: () => stubConfigForm().scope,
  } as never)
  const connectWorkspace = vi.fn(async () => ROOT)
  const references = new Map<SessionId, SessionReference>()
  const opened = vi.fn<(id: SessionId) => void>()
  let mainReference: SessionReference | undefined
  const replaceMain = (id: SessionId, beforeOpen?: (id: SessionId) => void): void => {
    const next = runtime.sessions.retain(id, { source: 'mainView' })
    try {
      beforeOpen?.(id)
    } catch (error: unknown) {
      next.release()
      throw error
    }
    mainReference?.release()
    mainReference = next
    opened(id)
  }
  const openSession = vi.fn((id: SessionId) => { replaceMain(id) })
  runtime.ctx.provide('uiWorkspace', {
    openWorkspace: async (_workspaceId: WorkspaceId, beforeOpen: (id: SessionId) => void) => {
      const id = await connectWorkspace()
      replaceMain(id, beforeOpen)
    },
    openSession,
  } as never)
  const sessionFake = sessionFakeFor()
  await runtime.sessions.add({
    id: ROOT,
    summary: { title: 'R', displayTitle: 'R', cwd: '/proj' },
    session: sessionFake,
  })
  const rootReference = runtime.sessions.retain(ROOT)
  references.set(ROOT, rootReference)
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  await runtime.root.declare({
    'main': { kind: 'keyed', scope: 'root' },
  }, (_props: { renderSlot?: unknown }) => null)

  const feature = await runtime.mount({ inject: [...inject], apply })
  runtime.renderRoot()
  const entryOf = (key: 'main.conversation' | 'conversation.session' | 'conversation.session.header' | 'conversation.composer.bar') =>
    runtime.slots.entries(key)[0]!
  const conversationApi = (id: SessionId) => {
    const entry = entryOf('conversation.session')
    const instance = runtime.storeOf('conversation.session', references.get(id)) as ConversationInstance
    const injected = (entry.inject as unknown as (
      sessionId: SessionId,
      actions: ConversationActions,
    ) => ConversationSessionInjected)(id, instance.actions)
    return { instance, injected }
  }
  const residentApi = (id: SessionId | undefined) => {
    const definition = runtime.factoryOf('conversation.content')
    return (definition.inject as unknown as (
      sessionId: SessionId | undefined,
    ) => ConversationInjected)(id)
  }
  const headerApi = (id: SessionId) => {
    const entry = entryOf('conversation.session.header')
    const instance = runtime.storeOf('conversation.session.header', references.get(id)) as ConversationInstance
    const injected = (entry.inject as unknown as (
      sessionId: SessionId,
      actions: ConversationActions,
    ) => ConversationSessionHeaderInjected)(id, instance.actions)
    return { instance, injected }
  }
  const composerApi = (id: SessionId | undefined) => {
    const entry = entryOf('conversation.composer.bar')
    return (entry.inject as unknown as (sessionId: SessionId | undefined) => ComposerBarInjected)(id)
  }
  const inputApi = (id: SessionId) => {
    const input = runtime.ctx.conversation.input.for(runtime.sessions.scope(id)!)
    return { state: input.state, actions: input }
  }
  const viewSource = (id: SessionId): ObservableSnapshot<readonly ViewTab[]> =>
    conversationApi(id).injected.hooks.conversationViews
  return {
    runtime, feature, slots: runtime.slots, entryOf, conversationApi, headerApi, residentApi, composerApi,
    inputApi, viewSource, sessionFake, connectWorkspace, rootUpload, uploads, rootReference, references, opened,
  }
}

describe('Conversation inject API', () => {
  it('owns the File action, reads its mounted composer availability, and unregisters on disposal', async () => {
    const b = await bench()
    onTestFinished(() => b.runtime.dispose())
    const contributions = new Map<string, CommandContribution>()
    const registry = {
      register: (contribution: CommandContribution) => {
        contributions.set(contribution.name, contribution)
        return () => { contributions.delete(contribution.name) }
      },
    } satisfies Pick<CommandUiContract, 'register'>
    b.runtime.ctx.provide('commandUi', registry)
    await vi.waitFor(() => { expect(contributions.has('file')).toBe(true) })
    const file = contributions.get('file')!
    const target = { sessionId: ROOT }
    expect(file.label!()).toBe('文件')
    expect(file.available(target)).toBe(false)
    expect(file.available({ sessionId: 'missing' as SessionId })).toBe(false)
    if (file.ui.kind !== 'action') throw new Error('File must be an action')
    file.ui.run({ sessionId: 'missing' as SessionId })
    const keyboard = b.composerApi(ROOT).keyboard!
    const open = vi.fn()
    let available = true
    const unbind = keyboard.bindFilePicker({ open, available: () => available })
    expect(file.available(target)).toBe(true)
    file.ui.run(target)
    expect(open).toHaveBeenCalledOnce()
    available = false
    expect(file.available(target)).toBe(false)
    file.ui.run(target)
    expect(open).toHaveBeenCalledOnce()
    const replacement = vi.fn()
    const removeReplacement = keyboard.bindFilePicker({ open: replacement, available: () => true })
    unbind()
    expect(file.available(target)).toBe(true)
    file.ui.run(target)
    expect(replacement).toHaveBeenCalledOnce()
    removeReplacement()
    expect(file.available(target)).toBe(false)
    file.ui.run(target)
    expect(replacement).toHaveBeenCalledOnce()
    await b.feature.dispose()
    expect(contributions.size).toBe(0)
  })

  it('assembles the target-neutral read face without Session side effects', async () => {
    const b = await bench()
    const { injected } = b.conversationApi(ROOT)
    expect(b.sessionFake.loadOlder).not.toHaveBeenCalled()
    expect(Object.keys(injected)).toEqual(['hooks', 'bindDraftMirror', 'openView'])
    expect(b.viewSource(ROOT).getSnapshot()).toEqual([])
    await b.runtime.dispose()
  })

  it('offers Inspect only while a registered tool-call inspector is visible', async () => {
    const b = await bench()
    const body = b.conversationApi(ROOT)
    const source = body.injected.hooks.inspectCall
    const changed = vi.fn()
    const unsubscribe = source.subscribe(changed)
    expect(source.getSnapshot()).toBeUndefined()
    const removeDefinition = b.runtime.ctx.uiConversation.views.register({
      target: 'trajectory',
      toolCallFocus: callId => `tool:${callId}`,
      create: () => ({ empty: null, replace: () => null, apply: () => null }),
    })
    expect(source.getSnapshot()).toBeUndefined()
    const removeView = b.slots.register(
      { name: 'conversation.view', id: 'trajectory' }, (() => null) as never,
    )
    await b.runtime.flush()
    const inspect = source.getSnapshot()!
    expect(inspect).toBeTypeOf('function')
    expect(source.getSnapshot()).toBe(inspect)
    inspect('call-1')
    expect(body.instance.store.getSnapshot().viewRequest).toEqual({ view: 'trajectory', focus: 'tool:call-1' })
    await b.runtime.ctx.configForms.developerTools.setEnabled(false)
    expect(source.getSnapshot()).toBeUndefined()
    await b.runtime.ctx.configForms.developerTools.setEnabled(true)
    expect(source.getSnapshot()).toBe(inspect)
    // Trajectory still owns inspection while both Views are visible; hiding
    // it must leave a third-party View's inspection capability reachable.
    const removePipelineDefinition = b.runtime.ctx.uiConversation.views.register({
      target: 'pipeline',
      toolCallFocus: callId => `stage:${callId}`,
      create: () => ({ empty: null, replace: () => null, apply: () => null }),
    })
    const removePipelineView = b.slots.register(
      { name: 'conversation.view', id: 'pipeline' }, (() => null) as never,
    )
    await b.runtime.flush()
    expect(source.getSnapshot()).toBe(inspect)
    await b.runtime.ctx.configForms.developerTools.setEnabled(false)
    const pipelineInspect = source.getSnapshot()!
    expect(pipelineInspect).toBeTypeOf('function')
    pipelineInspect('call-2')
    expect(body.instance.store.getSnapshot().viewRequest).toEqual({ view: 'pipeline', focus: 'stage:call-2' })
    await b.runtime.ctx.configForms.developerTools.setEnabled(true)
    removePipelineView()
    removePipelineDefinition()
    await b.runtime.flush()
    expect(source.getSnapshot()).toBe(inspect)
    removeView()
    await b.runtime.flush()
    expect(source.getSnapshot()).toBeUndefined()
    inspect('stale-call')
    expect(body.instance.store.getSnapshot().viewRequest?.focus).not.toBe('tool:stale-call')
    expect(changed).toHaveBeenCalled()
    unsubscribe()
    changed.mockClear()
    removeDefinition()
    expect(changed).not.toHaveBeenCalled()
    await b.runtime.dispose()
  })

  it('activates a target before committing an explicit View selection', async () => {
    const b = await bench()
    const binding = b.runtime.ctx.uiConversation.binding(ROOT)
    const activate = vi.spyOn(binding, 'activate')
    const removeChat = b.slots.register(
      { name: 'conversation.view', id: 'chat', order: 0 },
      (() => null) as never,
    )
    const removeTrajectory = b.slots.register(
      { name: 'conversation.view', id: 'trajectory', order: 10 },
      (() => null) as never,
    )
    await Promise.resolve()
    activate.mockClear()

    const body = b.conversationApi(ROOT)
    body.injected.openView('trajectory', 'call-1')
    expect(activate).toHaveBeenLastCalledWith('trajectory')
    expect(body.instance.store.getSnapshot()).toMatchObject({
      view: 'trajectory',
      viewRequest: { view: 'trajectory', focus: 'call-1' },
    })

    const header = b.headerApi(ROOT)
    header.injected.selectView('chat')
    expect(activate).toHaveBeenLastCalledWith('chat')
    expect(header.instance.store.getSnapshot().view).toBe('chat')

    removeTrajectory()
    await b.runtime.flush()
    activate.mockClear()
    body.injected.openView('trajectory', 'hidden-call')
    expect(activate).not.toHaveBeenCalled()
    expect(body.instance.store.getSnapshot().view).toBe('chat')
    removeChat()
    await b.runtime.dispose()
  })

  it('restores the selected View when a cached Session becomes Provider-bound', async () => {
    const b = await bench()
    const binding = b.runtime.ctx.uiConversation.binding(ROOT)
    const activate = vi.spyOn(binding, 'activate')
    const removeChat = b.slots.register(
      { name: 'conversation.view', id: 'chat', order: 0 },
      (() => null) as never,
    )
    let removeCustom: (() => void) | undefined
    try {
      await b.runtime.flush()
      localStorage.setItem(`dsh.conversation.${ROOT}`, JSON.stringify({
        draft: '', view: 'custom', viewRequest: null,
      }))

      b.runtime.ctx.uiSession.adapter.bindingSource(b.rootReference).getSnapshot()
      expect(activate).toHaveBeenLastCalledWith('chat')
      activate.mockClear()

      removeCustom = b.slots.register(
        { name: 'conversation.view', id: 'custom', order: 10 },
        (() => null) as never,
      )
      await b.runtime.flush()
      expect(activate).toHaveBeenLastCalledWith('custom')
      activate.mockClear()

      using mainReference = b.runtime.sessions.retain(ROOT, { source: 'mainView' })
      await b.runtime.flush()
      expect(mainReference.sessionId).toBe(ROOT)
      expect(activate).not.toHaveBeenCalled()
    } finally {
      removeCustom?.()
      removeChat()
      await b.runtime.dispose()
    }
  })

  it('submits through the provided input machine and mirrors accepted draft edits', async () => {
    const b = await bench()
    const { injected } = b.conversationApi(ROOT)
    const { state, actions } = b.inputApi(ROOT)
    actions.setDraft('   ')
    actions.submit()
    expect(b.sessionFake.prompt).not.toHaveBeenCalled()
    expect(state.getSnapshot().draft).toBe('   ')

    actions.setDraft('hello')
    actions.submit()
    // Optimistic commit clears the draft at enter; the prompt lands after the
    // paint-yield inside the send pipeline.
    expect(state.getSnapshot().draft).toBe('')
    await vi.waitFor(() => {
      expect(b.sessionFake.prompt).toHaveBeenCalledWith(
        [{ type: 'text', text: 'hello' }], 'queue', expect.any(AbortSignal), expect.any(String),
      )
    })

    b.sessionFake.prompt.mockResolvedValueOnce({
      ok: false, error: new RemoteError('session/agent-busy', 'busy', { reason: 'busy' }),
    })
    actions.setDraft('retry me')
    actions.submit()
    await vi.waitFor(() => { expect(b.sessionFake.prompt).toHaveBeenCalledTimes(2) })
    await Promise.resolve()
    expect(state.getSnapshot().draft).toBe('retry me')

    const mirrored: string[] = []
    const unbind = injected.bindDraftMirror(text => mirrored.push(text))
    actions.setDraft('mirrored text')
    expect(mirrored).toEqual(['mirrored text'])
    unbind()
    expect(b.inputApi(ROOT).state).toBe(state)

    b.sessionFake.cancel.mockResolvedValueOnce({
      ok: false, error: new RemoteError('gateway/internal', 'stop failed', {}),
    })
    b.composerApi(ROOT).stop!()
    await vi.waitFor(() => { expect(b.sessionFake.cancel).toHaveBeenCalledOnce() })
    await b.runtime.dispose()
  })

  it('releases a draft attachment only after the input shell accepts its removal', async () => {
    const b = await bench()
    const composer = b.composerApi(ROOT)
    expect(composer.addFiles?.([
      new File([Uint8Array.of(1)], 'draft.pdf', { type: 'application/pdf' }),
    ])).toBeNull()
    const controller = b.runtime.ctx.get('conversation') as unknown as {
      releaseDraftAttachment(id: string): void
    }
    const release = vi.spyOn(controller, 'releaseDraftAttachment')
    const input = b.inputApi(ROOT).actions
    const remove = vi.spyOn(input, 'removeAttachment').mockReturnValue(false)
    const draft = composer.resolveDraftAttachments?.(
      b.inputApi(ROOT).state.getSnapshot().attachmentIds,
    )[0]
    if (draft === undefined) throw new Error('missing draft attachment')

    composer.removeAttachment?.(draft.id)
    expect(release).not.toHaveBeenCalled()
    remove.mockReturnValueOnce(true)
    composer.removeAttachment?.(draft.id)
    expect(release).toHaveBeenCalledWith(draft.id)
    await b.runtime.dispose()
  })

  it('cites shell-named files and folders as @ references and refuses folders without the shell bridge', async () => {
    const browser = await bench()
    const folder = new File([], 'project')
    expect(browser.composerApi(ROOT).addFiles?.([folder], new Set([folder])))
      .toBe('只有桌面端支持添加文件夹，浏览器里请添加单个文件')
    expect(browser.inputApi(ROOT).state.getSnapshot().attachmentIds).toEqual([])
    await browser.runtime.dispose()

    const paths = new Map([['project', '/Users/me/my project'], ['notes.md', '/Users/me/notes.md'], ['shot.png', '/Users/me/shot.png']])
    vi.stubGlobal('__DSH_HOST_PATHS__', { pathFor: (file: File) => paths.get(file.name) ?? '' })
    try {
      const desktop = await bench()
      const composer = desktop.composerApi(ROOT)
      const { state } = desktop.inputApi(ROOT)
      const note = new File([Uint8Array.of(1)], 'notes.md', { type: 'text/markdown' })
      const shot = new File([Uint8Array.of(2)], 'shot.png', { type: 'image/png' })
      const pasted = new File([Uint8Array.of(3)], 'pasted.bin', { type: 'application/octet-stream' })
      expect(composer.addFiles?.([folder, note, shot, pasted], new Set([folder]))).toBeNull()
      // The folder and the file became references in the draft; the image and the pathless bytes stayed drafts.
      expect(state.getSnapshot().draft).toBe('@"/Users/me/my project/" @/Users/me/notes.md ')
      const drafts = composer.resolveDraftAttachments?.(state.getSnapshot().attachmentIds) ?? []
      expect(drafts.map(draft => draft.kind)).toEqual(['image', 'file'])
      await vi.waitFor(() => { expect(desktop.rootUpload).toHaveBeenCalledOnce() })
      // A directory the shell cannot name is refused even with the bridge present.
      const nameless = new File([], 'nameless')
      expect(composer.addFiles?.([nameless], new Set([nameless])))
        .toBe('无法获取文件夹路径，请重新拖入')
      await desktop.runtime.dispose()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('preserves selected text and file order and restores pasted directory chips from the draft', async () => {
    vi.stubGlobal('__DSH_HOST_PATHS__', { pathFor: (file: File) => `/proj/${file.name}` })
    onTestFinished(() => { vi.unstubAllGlobals(); cleanup() })
    const b = await bench()
    onTestFinished(() => b.runtime.dispose())
    const composer = b.composerApi(ROOT)
    const editor = composer.keyboard!.editor
    const { state, actions } = b.inputApi(ROOT)
    actions.setDraft('读取')
    editor.update(() => {
      const text = $getRoot().getAllTextNodes()[0]
      if (text === undefined || !$isTextNode(text)) throw new Error('expected text selection')
      text.select(0, 2)
    }, { discrete: true })
    const off = registerComposerKeymap(editor, {
      arbitrate: () => 'pass', space: () => false, dismissPopup: () => {},
      canSubmit: () => true, submit: () => {}, pasteText: (text) => { composer.keyboard!.paste(text) },
      intakeFiles: (files, directories) => { expect(composer.addFiles?.(files, directories)).toBeNull() },
    })
    onTestFinished(off)
    const folder = new File([], 'my project')
    const files = [new File([], 'a.txt'), folder, new File([], 'b.txt')]
    const event = new KeyboardEvent('paste', { cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: {
      items: files.map(file => ({
        kind: 'file', getAsFile: () => file, webkitGetAsEntry: () => ({ isDirectory: file === folder }),
      })), getData: () => '',
    } })
    editor.update(() => { editor.dispatchCommand(PASTE_COMMAND, event) }, { discrete: true })
    expect(state.getSnapshot().draft).toBe('读取 @a.txt @"my project/" @b.txt ')
    const view = render(<div>{projectUserText(state.getSnapshot().draft, [])}</div>)
    expect(view.container.querySelector('[data-ref-chip="folder"]')?.textContent).toBe('my project')
    expect(view.container.querySelector('[data-ref-chip="folder"]')?.getAttribute('title')).toBe('@"my project/"')
  })

  it('rejects the whole file batch before changing the draft when a later path is unrepresentable', async () => {
    vi.stubGlobal('__DSH_HOST_PATHS__', { pathFor: (file: File) => `/proj/${file.name}` })
    onTestFinished(() => { vi.unstubAllGlobals() })
    const b = await bench()
    onTestFinished(() => b.runtime.dispose())
    const { state, actions } = b.inputApi(ROOT)
    actions.setDraft('keep this text')
    for (const name of ['bad"name', 'bad\nname']) {
      const files = [new File([], 'good.txt'), new File([], name)]
      expect(b.composerApi(ROOT).addFiles?.(files)).toBe('路径含有无法引用的字符，请改名后再试')
      expect(state.getSnapshot().draft).toBe('keep this text')
      expect(state.getSnapshot().attachmentIds).toEqual([])
      expect(b.rootUpload).not.toHaveBeenCalled()
    }
  })

  it('fails loud for an unknown binding or an unloaded scoped service', async () => {
    const b = await bench()
    const entry = b.entryOf('conversation.composer.bar')
    const injectBar = entry.inject as unknown as (
      sessionId: SessionId | undefined,
    ) => ComposerBarInjected
    expect(() => { injectBar('ghost' as SessionId).stop!() }).toThrow(/resolved no binding/)

    const absent = injectBar(undefined)
    expect(absent.keyboard).toBeUndefined()
    expect(absent.toggleCommandMenu).toBeUndefined()
    expect(absent.stop).toBeUndefined()
    expect(absent.hooks.notices.getSnapshot()).toBeNull()
    expect(absent.hooks.lexicon.getSnapshot().size).toBe(0)
    expect(absent.hooks.menuLauncher.getSnapshot()).toBeNull()

    const stop = injectBar(ROOT).stop!
    await b.feature.dispose()
    expect(() => { stop() }).toThrow(/unavailable through the session scope/)
    await b.runtime.dispose()
  })

  it('moves a draft only when Workspace navigation changes Session', async () => {
    const b = await bench()
    const resident = b.residentApi(ROOT)
    const { state, actions } = b.inputApi(ROOT)
    actions.setDraft('carry me')
    expect(b.composerApi(ROOT).addFiles?.([
      new File([Uint8Array.of(1)], 'draft.pdf', { type: 'application/pdf' }),
    ])).toBeNull()
    await vi.waitFor(() => { expect(b.rootUpload).toHaveBeenCalledOnce() })

    b.connectWorkspace.mockResolvedValueOnce(ROOT)
    await resident.selectWorkspace('workspace-1' as WorkspaceId)
    expect(b.opened).toHaveBeenCalledWith(ROOT)
    expect(state.getSnapshot().draft).toBe('carry me')

    const other = 'other-1' as SessionId
    const targetUpload = vi.fn(() => Promise.resolve({
      ok: true,
      value: {
        receiptId: 'target-receipt' as never,
        file: { attachmentId: 'target-file' as never, name: 'draft.pdf', bytes: 1 },
      },
    }))
    b.uploads.set(other, targetUpload)
    await b.runtime.sessions.add({ id: other, session: {} })
    b.connectWorkspace.mockResolvedValueOnce(other)
    await resident.selectWorkspace('workspace-2' as WorkspaceId)
    expect(b.opened).toHaveBeenCalledWith(other)
    expect(state.getSnapshot().draft).toBe('')
    expect(b.inputApi(other).state.getSnapshot().draft).toBe('carry me')
    await vi.waitFor(() => { expect(targetUpload).toHaveBeenCalledOnce() })
    expect(b.inputApi(other).state.getSnapshot().attachmentIds).toHaveLength(1)
    await b.runtime.dispose()
  })

  it('supports no-Session navigation and propagates Workspace connection failure', async () => {
    const b = await bench()
    b.connectWorkspace.mockResolvedValueOnce(ROOT)
    await b.residentApi(undefined).selectWorkspace('workspace-0' as WorkspaceId)
    expect(b.opened).toHaveBeenCalledWith(ROOT)

    const opens = b.opened.mock.calls.length
    b.connectWorkspace.mockRejectedValueOnce(new Error('offline'))
    await expect(b.residentApi(ROOT).selectWorkspace('workspace-4' as WorkspaceId))
      .rejects.toThrow('offline')
    expect(b.opened).toHaveBeenCalledTimes(opens)
    await b.runtime.dispose()
  })

  it('projects the dynamic View registration ledger', async () => {
    const b = await bench()
    const source = b.viewSource(ROOT)
    const before = source.getSnapshot()
    const listener = vi.fn()
    const unsubscribe = source.subscribe(listener)
    const removeNamed = b.slots.register(
      { name: 'conversation.view', id: 'trajectory', order: 5, label: 'Trajectory' },
      (() => null) as never,
    )
    await vi.waitFor(() => {
      expect(source.getSnapshot()).toEqual([{ id: 'trajectory', label: 'Trajectory' }])
    })
    expect(listener).toHaveBeenCalledOnce()
    expect(source.getSnapshot()).not.toBe(before)

    const removeBare = b.slots.register(
      { name: 'conversation.view', id: 'bare', order: 6 },
      (() => null) as never,
    )
    await vi.waitFor(() => {
      expect(source.getSnapshot().map(view => view.label)).toEqual(['Trajectory', 'bare'])
    })
    removeNamed()
    removeBare()
    unsubscribe()
    await b.runtime.dispose()
  })
})
