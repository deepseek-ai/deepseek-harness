// @vitest-environment jsdom
/**
 * Shared-session attribution above Chat's official user row.
 *
 * The durable `user/message` source carries the share-viewer principal only
 * for a caller other than the owner. The client registers one chain entry in
 * Chat's `conversation.chat.user.before` seat; its selector elects exactly the
 * share-viewer sources and the component renders the Relay-asserted author.
 */

import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { apply } from '../src/client/index.ts'
import { de, en, es, fr, ja, NS, pt, ru, zh } from '../src/client/locales.ts'
import { shareViewerAuthor, shareViewerSubject, SharedSessionOrigin } from '../src/client/user-origin.tsx'
import { forgetOwnerDisplay } from '../src/client/owner-display.ts'

afterEach(() => { forgetOwnerDisplay(); cleanup() })

/** One durable user message source written for a share reader. */
const SHARED = {
  kind: 'user',
  rpcId: 'rpc-shared',
  principal: {
    kind: 'share-viewer',
    shareId: 'share-1',
    actor: { providerId: 'relay', tenantId: 'tenant', subjectId: 'subject-42' },
  },
}

/** A source that recorded the Relay display name beside the subject. */
const SHARED_NAMED = {
  ...SHARED,
  principal: { ...SHARED.principal, actor: { ...SHARED.principal.actor, displayName: '许翰翔' } },
}

/** The same source by the owner, and a source with no principal at all. */
const OWNER = { kind: 'user', rpcId: 'rpc-owner' }

/** The subject a persisted source names, or undefined for another author. */
describe('shareViewerSubject', () => {
  it.each([
    ['a string source', 'user'],
    ['a null source', null],
    ['an undefined source', undefined],
    ['an owner-authored source', OWNER],
    ['a non-user source', { kind: 'other', principal: SHARED.principal }],
    ['a null principal', { kind: 'user', principal: null }],
    ['a non-object principal', { kind: 'user', principal: 'share-viewer' }],
    ['another principal kind', { kind: 'user', principal: { kind: 'owner' } }],
    ['a principal without a share id', { kind: 'user', principal: { kind: 'share-viewer', actor: { subjectId: 's' } } }],
    ['a non-string share id', { kind: 'user', principal: { kind: 'share-viewer', shareId: 7, actor: { subjectId: 's' } } }],
    ['a blank share id', { kind: 'user', principal: { kind: 'share-viewer', shareId: '  ', actor: { subjectId: 's' } } }],
    ['a principal without an actor', { kind: 'user', principal: { kind: 'share-viewer', shareId: 's' } }],
    ['a null actor', { kind: 'user', principal: { kind: 'share-viewer', shareId: 's', actor: null } }],
    ['an actor without a subject', { kind: 'user', principal: { kind: 'share-viewer', shareId: 's', actor: {} } }],
    ['a non-string subject', { kind: 'user', principal: { kind: 'share-viewer', shareId: 's', actor: { subjectId: 42 } } }],
    ['a blank subject', { kind: 'user', principal: { kind: 'share-viewer', shareId: 's', actor: { subjectId: '   ' } } }],
  ])('names no subject for %s', (_label, source) => {
    expect(shareViewerSubject(source)).toBeUndefined()
  })

  it('states the Relay-asserted subject exactly as persisted', () => {
    expect(shareViewerSubject(SHARED)).toBe('subject-42')
    expect(shareViewerSubject({ ...SHARED, clientTimeZone: 'Asia/Shanghai' })).toBe('subject-42')
  })

  it('states the recorded display name and ignores a malformed one', () => {
    expect(shareViewerAuthor(SHARED_NAMED)).toEqual({ subjectId: 'subject-42', displayName: '许翰翔' })
    expect(shareViewerAuthor({
      ...SHARED,
      principal: { ...SHARED.principal, actor: { ...SHARED.principal.actor, displayName: '  ' } },
    })).toEqual({ subjectId: 'subject-42' })
    expect(shareViewerAuthor({
      ...SHARED,
      principal: { ...SHARED.principal, actor: { ...SHARED.principal.actor, displayName: 7 } },
    })).toEqual({ subjectId: 'subject-42' })
  })
})

/** The registered chain seat, its selector, and its component. */
describe('shared-session origin chain', () => {
  it('registers one chain entry whose selector elects only a share-viewer user row', async () => {
    const { runtime } = await renderBench()
    const entries = runtime.slots.entriesOfSlot('conversation.chat.user.before')
    expect(entries).toHaveLength(1)
    expect(entries[0]?.component).toBe(SharedSessionOrigin)
    expect(entries[0]?.locale).toBe(NS)
    const select = entries[0]?.select as (owner: { source: unknown; kind: 'user' | 'steering' }) => unknown
    expect(select({ source: SHARED, kind: 'user' })).toEqual({ subjectId: 'subject-42' })
    expect(select({ source: SHARED_NAMED, kind: 'user' })).toEqual({ subjectId: 'subject-42', displayName: '许翰翔' })
    expect(select({ source: OWNER, kind: 'user' })).toBeNull()
    expect(select({ source: SHARED, kind: 'steering' })).toBeNull()
    expect(select({ source: { kind: 'user', principal: { kind: 'owner' } }, kind: 'user' })).toBeNull()
  })

  it('renders the elected author in the active locale', () => {
    const view = render(createElement(SharedSessionOrigin, {
      matched: { subjectId: 'subject-42' }, t: translate('zh'),
    } as never))
    expect(view.container.querySelector('[data-liveshare-origin="subject-42"]')?.textContent)
      .toBe('来自会话分享【subject-42】')
    view.unmount()
    const named = render(createElement(SharedSessionOrigin, {
      matched: { subjectId: 'subject-42', displayName: '许翰翔' }, t: translate('en'),
    } as never))
    expect(named.container.querySelector('[data-liveshare-origin="subject-42"]')?.textContent)
      .toBe('From a shared session [许翰翔]')
  })

  it('defines the shared-session line in every dictionary', () => {
    const dictionaries = { zh, en, ja, es, fr, de, ru, pt }
    const keys = Object.keys(zh).sort()
    for (const dictionary of Object.values(dictionaries)) {
      expect(Object.keys(dictionary).sort()).toEqual(keys)
      expect(dictionary['inputOrigin.sharedSession']).toContain('{subjectId}')
    }
  })
})

/** One package dictionary as the component's translator. */
function translate(locale: 'zh' | 'en') {
  const dictionary = locale === 'zh' ? zh : en
  return (key: keyof typeof zh, params?: Record<string, string | number>): string => {
    let result = dictionary[key] ?? key
    for (const [name, value] of Object.entries(params ?? {})) result = result.replace(`{${name}}`, String(value))
    return result
  }
}

/**
 * Mount the Liveshare client face over the real slot registry and declare Chat's
 * before-row chain.
 * @returns The runtime carrying the registered chain entry.
 */
async function renderBench() {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  const locale = new LocaleRuntime(runtime.ctx)
  locale.setLocale('zh')
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  // The test runtime owns the Remote double; the face only needs its mount and
  // share-management namespace to reach the owner branch.
  runtime.remote.$mount = async () => async () => {}
  runtime.remote.provideNamespaces({ liveshareShares: {} })
  await runtime.declare({ 'conversation.chat.user.before': { kind: 'chain', scope: 'session' } as never })
  // The origin registration and dictionaries install synchronously; the owner
  // Remote mount that follows is irrelevant to this face test.
  await runtime.mount({
    inject: ['slots', 'locale', 'remote'],
    apply: (ctx) => { void apply(ctx) },
  })
  return { runtime }
}
