// @vitest-environment jsdom
/** What the viewer page's own plugin blocks under its access snapshot, and whose scopes it touches. */

import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply, inject, viewerSignInHref } from '../src/client/viewer-session-plugin.ts'
import { publishViewerCapabilities, viewerCapabilities } from '../src/client/viewer-capabilities.ts'
import { viewerContextFacts } from '../src/client/viewer-context.ts'
import { viewerStatus, viewerStatusFacts } from '../src/client/viewer-status.ts'
import { en, zh } from '../src/client/locales.ts'
import { cleanup, render } from '@testing-library/react'
import { createElement, createRef } from 'react'
import { DraftEditor } from '@deepseek-ai/dsh-client-ui-conversation/src/client/input/editor/DraftEditor.tsx'
import {
  provideViewerConnection, provideViewerLocale, provideViewerRemoteAccess, type ViewerRemoteAccess,
} from './viewer-plugin-services.client.ts'

const SHARED = 'fx-shared' as SessionId
const CHILD = 'fx-child' as SessionId
const OTHER = 'fx-other' as SessionId

interface ViewerTargetWindow {
  __DSH_LIVESHARE_VIEWER__?: { shareId: string; sessionId: string; basePath?: string }
}

/** Blocks one Session's composer carries, keyed by the store the plugin wrote. */
type BlockRecord = { readonly reason: string }

/**
 * Own one page's plugin over a minimal session list: the source it presents, a branch it made, and a
 * row it does not address.
 * @returns The page, its list, the blocks each Session was given, and which scopes were asked for.
 */
async function bench(
  initial?: Parameters<typeof provideViewerRemoteAccess>[1],
  language: 'zh' | 'en' = 'zh',
  options: { readonly target?: boolean; readonly missingConversation?: boolean } = {},
) {
  const rows = createSnapshotStore<{ byId: Record<string, unknown> }>({ byId: {} })
  const blocks = new Map<string, BlockRecord | undefined>()
  const scopesAsked: string[] = []
  const openSession = vi.fn<(sessionId: string) => void>()
  const ctx = new Context()
  provideViewerLocale(ctx, language)
  const fiber = ctx.plugin({
    inject: [...inject],
    apply,
  })
  ctx.provide('sessions', {
    list: {
      getSnapshot: () => rows.getSnapshot(),
      subscribe: (observer: () => void) => rows.subscribe(observer),
    },
    scope: (sessionId: string) => {
      scopesAsked.push(sessionId)
      if (options.missingConversation === true) return { get: () => undefined }
      return {
        get: () => ({
          blocks: {
            set: (_sessionId: string, block: BlockRecord | undefined) => {
              blocks.set(sessionId, block)
            },
          },
        }),
      }
    },
  } as never)
  ctx.provide('uiWorkspace', { openSession } as never)
  const access = provideViewerRemoteAccess(ctx, initial)
  const connection = provideViewerConnection(ctx)
  if (options.target !== false) {
    (globalThis as ViewerTargetWindow).__DSH_LIVESHARE_VIEWER__ = {
      shareId: 'share-1',
      sessionId: SHARED,
      basePath: '',
    }
  }
  await fiber.await()
  return { ctx, fiber, rows, blocks, scopesAsked, openSession, access, connection }
}

/** One action button the page's own status banner offers. */
function bannerAction(action: 'reload' | 'sign-in' | 'directory' | 'retry'): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(`button[data-liveshare-action="${action}"]`)
  if (button === null) throw new Error(`the page offers no ${action} action`)
  return button
}

/** Endpoints a Session grant lists while the reader may prompt and stop it. */
const WRITES = ['session/cancel', 'session/prompt'] as const

/**
 * Deliver one non-owner baseline: the complete Session grants the owner's share policy allows this reader.
 * @param access - Bench access snapshot.
 * @param grants - Endpoints allowed per Session; a Session absent here is granted nothing.
 */
function deliverGrants(access: ViewerRemoteAccess, grants: Record<string, readonly string[]>): void {
  access.push({
    type: 'baseline',
    owner: false,
    grants: Object.entries(grants).map(([id, actions]) => ({ resource: { kind: 'session', id: id as SessionId }, actions })),
  })
}

/**
 * List the three rows a reader page can carry, with the branch facts the Host publishes for them.
 * @param page - Bench whose access snapshot receives the grants.
 * @param options - Whether the page made the branch, and whether its share policy grants the shared
 *   Session (a scenario about a share that does not drive passes false).
 */
function listRows(page: Awaited<ReturnType<typeof bench>>, options: { ownFork: boolean; shared?: boolean }): void {
  // Both tiers drive the shared Session, and the reader's own branch is driven in either of them: what a
  // tier decides is the confined write, which the access snapshot does not carry.
  deliverGrants(page.access, {
    ...(options.shared === false ? {} : { [SHARED]: ['session/fork', ...WRITES] }),
    ...(options.ownFork ? { [CHILD]: WRITES } : {}),
  })
  page.rows.set({
    byId: {
      [SHARED]: { id: SHARED },
      ...(options.ownFork
        ? {
          [CHILD]: {
            id: CHILD,
            projectionValues: {
              forkLineage: {
                origin: 'fork',
                sourceSessionId: SHARED,
                authoredByViewer: true,
                workspaceReadOnly: true,
              },
            },
          },
        }
        : {}),
      [OTHER]: { id: OTHER },
    },
  })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete (globalThis as ViewerTargetWindow).__DSH_LIVESHARE_VIEWER__
  viewerCapabilities.set({ mode: 'view' })
  viewerStatusFacts.set({})
  viewerStatus.set('connecting')
})

describe('viewer page state lifetime', () => {
  it('releases the page state when the plugin is disposed', async () => {
    vi.stubGlobal('fetch', vi.fn((input: unknown) => {
      const url = String(input)
      return Promise.resolve(url.includes('/__liveshare/context')
        ? Response.json({
          ownerDisplayName: 'Owner',
          dshVersion: '0.1.5-rc.2',
          viewer: { providerId: 'oidc', subjectId: 'subject-42', displayName: '许翰翔' },
          capabilities: { sessionMode: 'write', online: true },
        })
        : Response.json({ release_id: 'release-7' }))
    }))
    const page = await bench()
    try {
      await vi.waitFor(() => {
        expect(viewerCapabilities.getSnapshot().mode).toBe('write')
        expect(viewerContextFacts.getSnapshot()).toMatchObject({
          owner: 'Owner',
          dshVersion: '0.1.5-rc.2',
          viewerSubjectId: 'subject-42',
          viewerDisplayName: '许翰翔',
        })
        expect(viewerStatus.getSnapshot()).toBe('ready')
      })
    } finally {
      await page.fiber.dispose()
    }
    // A disposed page leaves nothing behind for whichever page mounts next.
    expect(viewerCapabilities.getSnapshot()).toEqual({ mode: 'view' })
    expect(viewerContextFacts.getSnapshot()).toEqual({})
    expect(viewerStatusFacts.getSnapshot()).toEqual({})
    expect(viewerStatus.getSnapshot()).toBe('connecting')
  })

  it('starts each page from the empty state instead of inheriting the previous one', async () => {
    // Leftovers from a page that is gone must not speak for the page that mounts now.
    viewerCapabilities.set({ mode: 'write', reason: 'mode-view' })
    viewerContextFacts.set({ owner: 'Previous owner' })
    viewerStatusFacts.set({ reason: 'share-stopped' })
    viewerStatus.set('stopped')
    // The reads stay pending until disposal aborts them, so only the page's own entry can clear the
    // stores under test.
    vi.stubGlobal('fetch', vi.fn((_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new Error('read cancelled')) }, { once: true })
    })))
    const page = await bench()
    try {
      expect(viewerCapabilities.getSnapshot()).toEqual({ mode: 'view' })
      expect(viewerContextFacts.getSnapshot()).toEqual({})
      expect(viewerStatusFacts.getSnapshot()).toEqual({})
      expect(viewerStatus.getSnapshot()).toBe('connecting')
    } finally {
      await page.fiber.dispose()
    }
  })

  it('leaves the page stores to the mount that replaced it', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('the share is not read here'))))
    const page = await bench()
    const successor = page.ctx.plugin({ inject: [...inject], apply })
    await successor.await()
    // The replaced page's delayed teardown must not wipe what its successor already read.
    viewerCapabilities.set({ mode: 'write' })
    await page.fiber.dispose()
    expect(viewerCapabilities.getSnapshot()).toEqual({ mode: 'write' })
    await successor.dispose()
    expect(viewerCapabilities.getSnapshot()).toEqual({ mode: 'view' })
    expect(viewerContextFacts.getSnapshot()).toEqual({})
  })
})

describe('viewer sign-in return address', () => {
  it('returns the reader to the page they left, keeping the share in its query', () => {
    // The viewer page's address is `${relay}/?shareId=...`: signing in from it must come back to that
    // share, not to the Relay's bare directory.
    expect(viewerSignInHref('https://relay.example.test', '', {
      pathname: '/', search: '?shareId=e8HUU7dYsW7Y',
    })).toBe('https://relay.example.test/__liveshare/auth/start?returnTo='
      + encodeURIComponent('/?shareId=e8HUU7dYsW7Y'))
    // A relay mounted under a base path keeps it in both the entry and the return address.
    expect(viewerSignInHref('https://relay.example.test', '/team/liveshare', {
      pathname: '/team/liveshare/', search: '?shareId=e8HUU7dYsW7Y&review=1',
    })).toBe('https://relay.example.test/team/liveshare/__liveshare/auth/start?returnTo='
      + encodeURIComponent('/team/liveshare/?shareId=e8HUU7dYsW7Y&review=1'))
  })

  it('keeps the bare page when it carries no query', () => {
    expect(viewerSignInHref('https://relay.example.test', '/team/liveshare', {
      pathname: '/team/liveshare/', search: '',
    })).toBe('https://relay.example.test/team/liveshare/__liveshare/auth/start?returnTo='
      + encodeURIComponent('/team/liveshare/'))
  })
})

describe('viewer session plugin', () => {
  for (const [language, dictionary] of [['zh', zh], ['en', en]] as const) {
    describe(`readable viewer in ${language}`, () => {
      it('renders localized blocked-composer copy and keeps read navigation available', async () => {
        // The share grants writing but this page's snapshot holds no prompt for it, which is the state a
        // blocked composer states in the reader's own language.
        vi.stubGlobal('fetch', vi.fn((input: unknown) => Promise.resolve(
          String(input).includes('/context')
            ? Response.json({ capabilities: { sessionMode: 'write', online: true } })
            : new Response('', { status: 404 }),
        )))
        const page = await bench(undefined, language)
        try {
          listRows(page, { ownFork: false, shared: false })
          await vi.waitFor(() => {
            expect(page.blocks.get(SHARED)?.reason).toBe(dictionary['viewer.writeUnavailableNote'])
          })
          const reason = page.blocks.get(SHARED)!.reason
          const editor = render(createElement(DraftEditor, {
            classNames: {}, editor: null, scrollRef: createRef<HTMLDivElement>(), editable: false,
            editorDisabled: true, phase: 'inert', placeholderText: reason, ariaLabel: reason,
            workspaceTrigger: false, workspacePickerOpen: false, onWorkspaceKeyDown: () => {},
            hint: null, showPlaceholder: true,
          }))
          expect(editor.getByRole('textbox', { name: dictionary['viewer.writeUnavailableNote'] }).getAttribute('contenteditable'))
            .toBe('false')
          expect(editor.container.querySelector('[data-composer-placeholder]')?.textContent)
            .toBe(dictionary['viewer.writeUnavailableNote'])
          expect(page.openSession).toHaveBeenCalledWith(SHARED)
          expect(viewerStatus.getSnapshot()).toBe('ready')
          expect(document.getElementById('liveshare-viewer-status')?.style.display).toBe('none')
        } finally { await page.fiber.dispose() }
        expect(document.getElementById('liveshare-viewer-status')).toBeNull()
      })
    })
  }

  it('replaces an unconfirmed share read when the page regains it on focus', async () => {
    let admitted = false
    vi.stubGlobal('fetch', vi.fn((input: unknown) => {
      const url = String(input)
      return Promise.resolve(url.includes('/context') && admitted
        ? Response.json({ capabilities: { sessionMode: 'view', online: true } })
        : new Response('', { status: 403 }))
    }))
    const page = await bench()
    try {
      deliverGrants(page.access, {})
      // A refused context read leaves the page unable to confirm the share: it states that, and
      // offers no action, because the only way forward is another read.
      await vi.waitFor(() => { expect(viewerStatus.getSnapshot()).toBe('connecting') })
      expect(document.querySelector('button[data-liveshare-action]')).toBeNull()
      admitted = true
      window.dispatchEvent(new Event('focus'))
      await vi.waitFor(() => { expect(viewerStatus.getSnapshot()).toBe('ready') })
      expect(page.blocks.get(SHARED)?.reason).toBe(zh['viewer.readonlyNote'])
      expect(document.getElementById('liveshare-viewer-status')?.style.display).toBe('none')
    } finally { await page.fiber.dispose() }
  })

  it('discards context and pending responses that finish after the page plugin is disposed', async () => {
    let settle!: (response: Response) => void
    const response = new Promise<Response>((resolve) => { settle = resolve })
    const signals: AbortSignal[] = []
    vi.stubGlobal('fetch', vi.fn((_input: unknown, init?: RequestInit) => {
      if (init?.signal !== undefined && init.signal !== null) signals.push(init.signal)
      return response
    }))
    const page = await bench()
    const disposing = page.fiber.dispose()
    await vi.waitFor(() => { expect(signals.every(signal => signal.aborted)).toBe(true) })
    expect(signals).toHaveLength(2)
    settle(Response.json({ capabilities: { sessionMode: 'write' } }))
    await disposing
    expect(viewerStatusFacts.getSnapshot()).toEqual({})
    expect(viewerCapabilities.getSnapshot()).toEqual({ mode: 'view' })
    expect(document.getElementById('liveshare-viewer-status')).toBeNull()
  })
  it('clears every composer block it set when the page plugin is disposed', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('the share is not read here'))))
    const page = await bench()
    listRows(page, { ownFork: false, shared: false })
    await vi.waitFor(() => { expect(page.blocks.get(SHARED)?.reason).toBeDefined() })
    await page.fiber.dispose()
    // A disposed viewer page must not leave the owner's composer blocked behind it.
    expect(page.blocks.get(SHARED)).toBeUndefined()
  })

  it('blocks the shared Session and addresses no Session this page was not given', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('the share is not read here'))))
    const page = await bench()
    try {
      listRows(page, { ownFork: false, shared: false })
      // The Workspace navigation action is what selects the Session this page presents.
      expect(page.openSession).toHaveBeenCalledWith(SHARED)
      // The page presents one Session and addresses only that one: a row it does not present is never
      // asked for a scope, because asking would materialize one.
      expect(new Set(page.scopesAsked)).toEqual(new Set([SHARED]))
      expect(page.scopesAsked).not.toContain(OTHER)
      // The share never answered, so this page states that it could not confirm the share's state
      // rather than claiming the read-only fact an answer would have stated.
      expect(page.blocks.get(SHARED)?.reason).toContain('无法确认该分享的当前状态')
    } finally {
      await page.fiber.dispose()
    }
  })

  it('opens the branch this page made while the tier grants driving, and closes it when the switch goes off', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('the share is not read here'))))
    const page = await bench()
    try {
      publishViewerCapabilities({ capabilities: { sessionMode: 'view' } })
      listRows(page, { ownFork: true })
      // The branch is this page's own and the view tier still drives it: nothing blocks its composer, and
      // the row it does not address is still untouched.
      expect(new Set(page.scopesAsked)).toEqual(new Set([SHARED, CHILD]))
      expect(page.scopesAsked).not.toContain(OTHER)
      expect(page.blocks.get(CHILD)).toBeUndefined()
      // The shared Session is driven at this tier too, so its composer is open as well.
      expect(page.blocks.get(SHARED)).toBeUndefined()

      // The owner turns the share's fork switch off: the snapshot withdraws the branch, and the branch
      // states the fork verdict rather than the read-only note, which would claim a reach it lost.
      publishViewerCapabilities({
        capabilities: { sessionMode: 'view', sessionModeReason: 'fork-not-permitted' },
      })
      page.access.push({ type: 'upsert', grant: { resource: { kind: 'session', id: CHILD }, actions: [] } })
      expect(page.blocks.get(CHILD)?.reason).toBe('分享者未允许分支此会话')
      expect(page.blocks.get(SHARED)).toBeUndefined()
    } finally {
      await page.fiber.dispose()
    }
  })

  it('writes the shared Session in write mode and keeps the owner\u2019s own reach out of it', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('the share is not read here'))))
    const page = await bench()
    try {
      publishViewerCapabilities({ capabilities: { sessionMode: 'write' } })
      listRows(page, { ownFork: true })
      // The owner opened this Session, so the page writes it and says nothing about read-only — and
      // the branch this page created stays writable beside it.
      expect(page.blocks.get(SHARED)).toBeUndefined()
      expect(page.blocks.get(CHILD)).toBeUndefined()
      // A Session this page was not given is still not addressed at all.
      expect(page.scopesAsked).not.toContain(OTHER)
    } finally {
      await page.fiber.dispose()
    }
  })

  it('states the share\u2019s own end on every composer, not the read-only placeholder', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('the share is not read here'))))
    const page = await bench()
    try {
      publishViewerCapabilities({ capabilities: { sessionMode: 'fork-readonly' } })
      listRows(page, { ownFork: true })
      expect(page.blocks.get(CHILD)).toBeUndefined()

      // The owner stops the share: both the shared Session and the branch this page made state the
      // same verdict, because nothing on the page can change it. The read-only placeholder would hide
      // the one fact the reader needs.
      publishViewerCapabilities({
        capabilities: { sessionMode: 'view', sessionModeReason: 'share-stopped' },
      })
      deliverGrants(page.access, {})
      expect(page.blocks.get(SHARED)?.reason).toBe('分享已停止')
      expect(page.blocks.get(CHILD)?.reason).toBe('分享已停止')

      // Expiry reads the same way, and a deployment that cannot fork at all leaves the shared Session
      // stating that it is read-only.
      publishViewerCapabilities({
        capabilities: { sessionMode: 'view', sessionModeReason: 'share-expired' },
      })
      expect(page.blocks.get(SHARED)?.reason).toBe('分享已过期')
      publishViewerCapabilities({
        capabilities: { sessionMode: 'view', sessionModeReason: 'fork-not-implemented' },
      })
      expect(page.blocks.get(SHARED)?.reason).toContain('仅可查看')
    } finally {
      await page.fiber.dispose()
    }
  })

  it('states a lost access on the shared Session too, not only on a branch', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('the share is not read here'))))
    const page = await bench()
    try {
      publishViewerCapabilities({ capabilities: { sessionMode: 'view' } })
      listRows(page, { ownFork: true })
      expect(page.blocks.get(CHILD)).toBeUndefined()

      // The owner removes this reader: the tier falls back to view with the account statement
      // beside it, and the shared Session states that verdict rather than the read-only placeholder —
      // this reader can read neither Session any more.
      publishViewerCapabilities({
        capabilities: { sessionMode: 'view', sessionModeReason: 'viewer-not-authorized' },
      })
      deliverGrants(page.access, {})
      expect(page.blocks.get(SHARED)?.reason).toBe('你的账号已无权访问该分享')
      expect(page.blocks.get(CHILD)?.reason).toBe('你的账号已无权访问该分享')
    } finally {
      await page.fiber.dispose()
    }
  })

  it('states a lost Connection as offline until a generation is connected again', async () => {
    vi.stubGlobal('fetch', vi.fn((input: unknown) => Promise.resolve(String(input).includes('/context')
      ? Response.json({ capabilities: { sessionMode: 'view', online: true } })
      : new Response('', { status: 404 }))))
    const page = await bench()
    try {
      page.connection.set('connected')
      await vi.waitFor(() => { expect(viewerStatus.getSnapshot()).toBe('ready') })
      page.connection.set('disconnected')
      expect(viewerStatus.getSnapshot()).toBe('offline')
      // A retry in flight keeps stating the loss; only a connected generation clears it.
      page.connection.set('connecting')
      expect(viewerStatus.getSnapshot()).toBe('offline')
      page.connection.set('connected')
      expect(viewerStatus.getSnapshot()).toBe('ready')
    } finally { await page.fiber.dispose() }
  })

  it.each([undefined, 'fork-not-permitted'])('states the fork verdict on a branch whose share answer names %s', async (reason) => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('context unavailable'))))
    const page = await bench()
    try {
      publishViewerCapabilities({ capabilities: { sessionMode: 'view' } })
      listRows(page, { ownFork: true })
      publishViewerCapabilities({
        capabilities: { sessionMode: 'view', ...(reason === undefined ? {} : { sessionModeReason: reason }) },
      })
      page.access.push({ type: 'remove', resource: { kind: 'session', id: CHILD } })
      expect(page.blocks.get(CHILD)?.reason).toBe('分享者未允许分支此会话')
    } finally { await page.fiber.dispose() }
  })

  it('follows the access snapshot: an upsert or remove moves one Session\u2019s block at once', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('context unavailable'))))
    const page = await bench()
    try {
      publishViewerCapabilities({ capabilities: { sessionMode: 'view' } })
      listRows(page, { ownFork: true })
      expect(page.blocks.get(CHILD)).toBeUndefined()
      page.access.push({ type: 'remove', resource: { kind: 'session', id: CHILD } })
      expect(page.blocks.get(CHILD)?.reason).toContain('分享者未允许分支此会话')
      page.access.push({ type: 'upsert', grant: { resource: { kind: 'session', id: CHILD }, actions: WRITES } })
      expect(page.blocks.get(CHILD)).toBeUndefined()
      // A list change re-reads the same answers and keeps them.
      page.rows.set({ byId: { ...page.rows.getSnapshot().byId } })
      expect(page.blocks.get(CHILD)).toBeUndefined()
    } finally { await page.fiber.dispose() }
  })

  it('offers the composer from the baseline the index injected, and blocks it without one', async () => {
    // The served index carries the reader's opening access snapshot, so a granted prompt is offered
    // before the snapshot stream answers; a page without a baseline answers false until one arrives.
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('context unavailable'))))
    const injected = await bench({
      type: 'baseline',
      owner: false,
      grants: [{ resource: { kind: 'session', id: SHARED }, actions: WRITES }],
    })
    try {
      injected.rows.set({ byId: { [SHARED]: { id: SHARED } } })
      expect(injected.blocks.has(SHARED)).toBe(true)
      expect(injected.blocks.get(SHARED)).toBeUndefined()
      deliverGrants(injected.access, {})
      await vi.waitFor(() => { expect(injected.blocks.get(SHARED)?.reason).toContain('无法确认该分享的当前状态') })
    } finally { await injected.fiber.dispose() }
    const bare = await bench()
    try {
      bare.rows.set({ byId: { [SHARED]: { id: SHARED } } })
      await vi.waitFor(() => { expect(bare.blocks.get(SHARED)?.reason).toContain('无法确认该分享的当前状态') })
    } finally { await bare.fiber.dispose() }
  })

  it('holds each Session\u2019s own reach, and closes the Session the access snapshot withdraws', async () => {
    // The share answers for the Session this page presents; each other Session is judged by the grant the
    // access snapshot lists for it. Here the owner authorized another Session for writing.
    const contextAnswered = { capabilities: { sessionMode: 'write' } }
    vi.stubGlobal('fetch', vi.fn((input: unknown) => Promise.resolve(String(input).includes('/__liveshare/context')
      ? Response.json(contextAnswered)
      : new Response('', { status: 404 }))))
    const page = await bench()
    try {
      publishViewerCapabilities(contextAnswered)
      listRows(page, { ownFork: false })
      deliverGrants(page.access, { [SHARED]: WRITES, [OTHER]: WRITES })
      page.rows.set({
        byId: { ...page.rows.getSnapshot().byId, [OTHER]: { id: OTHER, retainedBy: { mainView: 1 } } },
      })
      // Switching to it offers its own writes, which the Session the page presents does not decide.
      expect(page.blocks.get(OTHER)).toBeUndefined()
      expect(page.blocks.get(SHARED)).toBeUndefined()

      // The snapshot withdraws that Session: its composer returns to read-only at once and states the
      // page's own read-only reason, because the snapshot carries no per-Session refusal code.
      page.access.push({ type: 'remove', resource: { kind: 'session', id: OTHER } })
      expect(page.blocks.get(OTHER)?.reason).toBe(zh['viewer.readonlyNote'])
      // One withdrawn Session does not narrow what the page holds for the Session it presents.
      expect(page.blocks.get(SHARED)).toBeUndefined()
    } finally {
      await page.fiber.dispose()
    }
  })

  it('performs every action a page state offers', async () => {
    const request = vi.fn(() => Promise.reject(new Error('context unavailable')))
    vi.stubGlobal('fetch', request)
    const page = await bench()
    const location = {
      href: '', origin: 'https://relay.example.test', pathname: '/', search: '?shareId=share-1',
      reload: vi.fn(),
    }
    vi.stubGlobal('location', location)
    try {
      viewerStatus.set('unavailable')
      await vi.waitFor(() => { expect(bannerAction('reload')).toBeDefined() })
      bannerAction('reload').click()
      expect(location.reload).toHaveBeenCalledOnce()

      // A served document that names no base path points the page at its own origin's root.
      ;(globalThis as ViewerTargetWindow).__DSH_LIVESHARE_VIEWER__ = { shareId: 'share-1', sessionId: SHARED }
      viewerStatus.set('reauthenticate')
      await vi.waitFor(() => { expect(bannerAction('sign-in')).toBeDefined() })
      bannerAction('sign-in').click()
      expect(location.href).toBe(viewerSignInHref('https://relay.example.test', '', {
        pathname: '/', search: '?shareId=share-1',
      }))

      viewerStatus.set('invalid')
      await vi.waitFor(() => { expect(bannerAction('directory')).toBeDefined() })
      bannerAction('directory').click()
      expect(location.href).toBe('https://relay.example.test/')

      // The retry action re-reads the share instead of navigating anywhere.
      const before = request.mock.calls.length
      viewerStatus.set('offline')
      await vi.waitFor(() => { expect(bannerAction('retry')).toBeDefined() })
      bannerAction('retry').click()
      await vi.waitFor(() => { expect(request.mock.calls.length).toBeGreaterThan(before) })
    } finally {
      await page.fiber.dispose()
    }
  })

  it('skips the focus re-read while the page is hidden', async () => {
    const request = vi.fn(() => Promise.reject(new Error('context unavailable')))
    vi.stubGlobal('fetch', request)
    const page = await bench()
    try {
      await vi.waitFor(() => { expect(request).toHaveBeenCalled() })
      const before = request.mock.calls.length
      Object.defineProperty(document, 'hidden', { configurable: true, value: true })
      window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
      await Promise.resolve()
      expect(request.mock.calls.length).toBe(before)
    } finally {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false })
      await page.fiber.dispose()
    }
  })

  it('addresses no composer when a Session exposes no conversation face', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('the share is not read here'))))
    const page = await bench(undefined, 'zh', { missingConversation: true })
    try {
      listRows(page, { ownFork: false })
      await vi.waitFor(() => { expect(page.scopesAsked).toContain(SHARED) })
      // Nothing to block: the Session's own face is what carries the composer, and it exposes none.
      expect(page.blocks.size).toBe(0)
    } finally {
      await page.fiber.dispose()
    }
  })

  it('reads the bare page when the served document names no share', async () => {
    const request = vi.fn((_input: unknown) => Promise.reject(new Error('context unavailable')))
    vi.stubGlobal('fetch', request)
    const page = await bench(undefined, 'zh', { target: false })
    try {
      await vi.waitFor(() => { expect(request).toHaveBeenCalled() })
      // No share and no base path named: the context read asks for the empty share.
      expect(String(request.mock.calls[0]?.[0])).toBe('/__liveshare/context?shareId=')
    } finally {
      await page.fiber.dispose()
    }
  })
})
