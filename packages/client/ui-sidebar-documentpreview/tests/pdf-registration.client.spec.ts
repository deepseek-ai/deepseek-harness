// @vitest-environment jsdom
/** PDF metadata, keyed slot, dictionary, and tab-view lifetime registration. */
import { createElement } from 'react'
import { Context } from '@deepseek-ai/cordis'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { DocumentPreviewRegistry } from '../src/client/document/registry.ts'
import { createPdfStore } from '../src/client/pdf/store.ts'
import type { PdfBodyInjected } from '../src/client/pdf/pdf.tsx'

vi.mock('../src/client/pdf/runtime.ts', () => ({ openPdf: vi.fn() }))
const renderedPdf = vi.hoisted(() => vi.fn(() => null))
vi.mock('../src/client/pdf/pdf.tsx', () => ({ PdfBody: renderedPdf }))
import { apply, PDF_BODY_ID } from '../src/client/pdf/index.ts'
import { LazyPdfBody } from '../src/client/pdf/LazyPdfBody.tsx'
import { en, zh } from '../src/client/pdf/locales.ts'

afterEach(() => { cleanup(); renderedPdf.mockClear() })

describe('PDF registration', () => {
  it('shows localized loading feedback while the PDF chunk resolves', async () => {
    render(createElement(LazyPdfBody, { t: makeTranslate(en) } as never))
    expect(screen.getByRole('status', { name: en.loading })).toBeDefined()
    await waitFor(() => { expect(renderedPdf).toHaveBeenCalledOnce() })
  })

  it('registers a builtin complete-bytes body and removes all contributions and retained view state on dispose', async () => {
    const ctx = new Context()
    const previews = new DocumentPreviewRegistry()
    const dictionaries = new Map<string, unknown>()
    const entries: Array<{
      name: string
      key: string
      locale: string
      store: ReturnType<typeof createPdfStore>
      inject: (sessionId: SessionId, actions: ReturnType<ReturnType<typeof createPdfStore>['create']>['actions']) => PdfBodyInjected
    }> = []
    const register = vi.fn((options: typeof entries[number], component: unknown) => {
      expect(component).toBe(LazyPdfBody)
      entries.push(options)
      return () => { entries.splice(entries.indexOf(options), 1) }
    })
    ctx.provide('documentPreviews', previews)
    ctx.provide('locale', {
      register: (name: string, value: unknown) => { dictionaries.set(name, value); return () => { dictionaries.delete(name) } },
      bind: () => makeTranslate(en),
    } as never)
    ctx.provide('slots', {
      inject: (_name: string, callback: () => () => void) => callback(), register,
    } as never)
    const fiber = ctx.plugin({ apply })
    try {
      await fiber.await()
      expect(previews.candidates('REPORT.PDF')).toMatchObject([
        { id: PDF_BODY_ID, extensions: ['pdf'], priority: 'builtin', loading: 'bytes-complete', wrap: false },
      ])
      expect(previews.candidates('report.pdf')[0]!.title()).toBe('PDF')
      expect(dictionaries.get('sidebarPdf')).toEqual({ zh, en })
      expect(entries[0]).toMatchObject({ name: 'sidebar.right.tab.document', key: PDF_BODY_ID, locale: 'sidebarPdf' })
      const instance = entries[0]!.store.create()
      const face = entries[0]!.inject('s1' as SessionId, instance.actions)
      const controller = new AbortController()
      face.retainTab('one' as TabId, controller.signal)
      face.retainTab('one' as TabId, controller.signal)
      instance.actions.page('one' as TabId, 2)
      controller.abort()
      expect(instance.getSnapshot().byTab).toEqual({})
      instance.actions.page('ended' as TabId, 3)
      face.retainTab('ended' as TabId, controller.signal)
      expect(instance.getSnapshot().byTab).toEqual({})
      const other = new AbortController()
      face.retainTab('two' as TabId, other.signal)
      instance.actions.page('two' as TabId, 2)
      await fiber.dispose()
      expect(instance.getSnapshot().byTab).toEqual({})
      expect(previews.getSnapshot()).toEqual([])
      expect(entries).toEqual([])
      expect(dictionaries.size).toBe(0)
    } finally {
      await fiber.dispose()
    }
  })
})
