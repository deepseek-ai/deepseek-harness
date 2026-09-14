/** HTML metadata and keyed slot contributions share one identity and unwind with their fiber. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { DocumentPreviewRegistry } from '../src/client/document/registry.ts'
import { apply, HTML_BODY_ID, htmlBodyDefinition } from '../src/client/html/index.ts'
import { HtmlBody } from '../src/client/html/HtmlBody.tsx'
import { en, zh } from '../src/client/html/locales.ts'
import type { HtmlBodyProps } from '../src/client/html/HtmlBody.tsx'

type Registration = {
  name: string
  key: string
  locale: string
  inject: () => Pick<HtmlBodyProps, 'readRelated'>
}

let dispose: (() => Promise<void>) | undefined
afterEach(async () => { await dispose?.(); dispose = undefined })

describe('HTML registration', () => {
  it('claims HTML suffixes as a builtin complete-byte renderer without wrap', () => {
    const title = vi.fn(() => 'localized HTML')
    expect(htmlBodyDefinition(title)).toEqual({
      id: HTML_BODY_ID, extensions: ['html', 'htm'], priority: 'builtin', title, loading: 'bytes-complete', wrap: false,
    })
    expect(title).not.toHaveBeenCalled()
    expect(htmlBodyDefinition(title).title()).toBe('localized HTML')
  })

  it('registers its dictionary and matching keyed body, and removes all contributions on disposal', async () => {
    const ctx = new Context()
    // No Session or Tab services are mounted; the global callback must use its file address.
    const registry = new DocumentPreviewRegistry()
    const dictionaries = new Map<string, unknown>()
    const bodies = new Map<string, unknown>()
    const readRelated = vi.fn().mockResolvedValue({ ok: true, value: { data: '' } })
    ctx.provide('remote', { workspaceFiles: { readRelated } } as never)
    const register = vi.fn((options: Registration, body: unknown) => {
      bodies.set(options.key, body)
      return () => { bodies.delete(options.key) }
    })
    ctx.provide('documentPreviews', registry)
    ctx.provide('slots', { inject: (_key: string, callback: () => () => void) => callback(), register } as never)
    ctx.provide('locale', {
      bind: () => (key: keyof typeof en) => en[key],
      register: (name: string, value: unknown) => { dictionaries.set(name, value); return () => { dictionaries.delete(name) } },
    } as never)
    const fiber = ctx.plugin({ apply })
    dispose = async () => { await fiber.dispose() }
    await fiber.await()
    expect(registry.candidates('INDEX.HTM').map(entry => entry.id)).toEqual([HTML_BODY_ID])
    expect(registry.getSnapshot()[0]?.title()).toBe(en.title)
    expect(dictionaries.get('documentHtml')).toEqual({ zh, en })
    expect(register).toHaveBeenCalledOnce()
    const registration = register.mock.calls[0]?.[0]
    expect(registration).toMatchObject({ name: 'sidebar.right.tab.document', key: HTML_BODY_ID, locale: 'documentHtml' })
    expect(register.mock.calls[0]?.[1]).toBe(HtmlBody)
    const injected = registration?.inject()
    expect(typeof injected?.readRelated).toBe('function')
    const signal = new AbortController().signal
    await injected?.readRelated('dsh-resource://file/session/explicit-session/sub/index.html', '../app.js', signal)
    expect(readRelated).toHaveBeenLastCalledWith('explicit-session', 'sub/index.html', '../app.js', signal)
    await injected?.readRelated(sessionFileAddress('absolute-session', '/workspace/index.html'), './app.js', signal)
    expect(readRelated).toHaveBeenLastCalledWith('absolute-session', '/workspace/index.html', './app.js', signal)
    expect(() => injected?.readRelated('dsh-resource://file/absolute/workspace/index.html', './app.js', signal))
      .toThrow('not a session file address')
    expect(readRelated).toHaveBeenCalledTimes(2)
    await dispose()
    expect(registry.getSnapshot()).toEqual([])
    expect(bodies.size).toBe(0)
    expect(dictionaries.size).toBe(0)
  })
})
