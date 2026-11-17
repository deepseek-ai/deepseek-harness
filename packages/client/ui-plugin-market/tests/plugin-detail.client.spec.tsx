// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { PluginDetailDocumentId } from '@deepseek-ai/dsh-api-remotes/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { LocaleSnapshot } from '@deepseek-ai/dsh-client-locale/client'
import { PluginDetailSection, type PluginDetailSectionProps } from '../src/client/PluginDetailSection.tsx'
import { detailKey, type DetailRequest, type DetailsState } from '../src/client/market-store.ts'
import { en, zh, type PluginMarketLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

const COMMON: Record<string, string> = { 'copy': 'Copy', 'copied': 'Copied', 'codeBlock.title': 'Code block', 'codeBlock.wrap': 'Wrap', 'codeBlock.unwrap': 'Unwrap', 'retry': 'Retry' }

function translator(dictionary: Record<PluginMarketLocaleKey, string>): PluginDetailSectionProps['t'] {
  const strings: Record<string, string> = dictionary
  return (key: string) => strings[key] ?? COMMON[key] ?? key
}

const REQUEST: DetailRequest = { url: 'https://a.example/index.json', name: 'a', version: '1.0.0', npm: true }
const DOCUMENT = brandString<PluginDetailDocumentId>('doc')

function setup(initial: DetailsState = {}, language = 'en') {
  const details = createSnapshotStore<DetailsState>(initial)
  const locale = createSnapshotStore<LocaleSnapshot>({ active: language, locales: [], revision: 0 })
  const face = {
    loadDetail: vi.fn(), retryDetail: vi.fn(),
    detailImage: vi.fn((document: PluginDetailDocumentId, destination: string) => `https://dsh.example/api/plugin-market/detail-file?document=${document}&path=${destination}`),
    useDetails: bindSnapshotSelector(details), useLocale: bindSnapshotSelector(locale),
  }
  const set = (key: string, state: DetailsState[string]): void => { act(() => { details.set({ ...details.getSnapshot(), [key]: state }) }) }
  const forget = (): void => { details.set({}) }
  return { face, set, locale, forget }
}

it('reads the document of the request in the active language and renders its Markdown with images beside it', () => {
  const { face, set, locale, forget } = setup()
  const view = render(<PluginDetailSection request={REQUEST} t={translator(en)} {...face} />)
  expect(face.loadDetail).toHaveBeenCalledWith(REQUEST, 'en')
  expect(screen.getByRole('status', { name: en.detailLoading })).toBeTruthy()
  set(detailKey(REQUEST, 'en'), { status: 'ready', detail: { status: 'found', origin: 'readme', markdown: '# Alpha\n\n![shot](img/shot.png) [guide](docs/guide.md)', document: DOCUMENT } })
  expect(screen.queryByRole('heading', { name: en.detailTitle })).toBeNull()
  expect(screen.getByRole('heading', { name: 'Alpha' })).toBeTruthy()
  expect(screen.getByRole('img', { name: 'shot' }).getAttribute('src')).toBe('https://dsh.example/api/plugin-market/detail-file?document=doc&path=img/shot.png')
  // Relative links stay text.
  expect(screen.queryByRole('link', { name: 'guide' })).toBeNull()
  expect(screen.getByText('guide')).toBeTruthy()
  act(() => { locale.set({ active: 'zh', locales: [], revision: 1 }) })
  expect(face.loadDetail).toHaveBeenLastCalledWith(REQUEST, 'zh')
  view.rerender(<PluginDetailSection request={REQUEST} t={translator(zh)} {...face} />)
  expect(face.loadDetail).toHaveBeenCalledTimes(2)
  // A read the controller forgot starts again; a settled one does not.
  set(detailKey(REQUEST, 'zh'), { status: 'ready', detail: { status: 'none' } })
  act(() => { forget() })
  expect(face.loadDetail).toHaveBeenCalledTimes(3)
})

it('renders nothing without a document, and a reason with a retry when the read failed', () => {
  const key = detailKey(REQUEST, 'en')
  const { face, set } = setup({ [key]: { status: 'ready', detail: { status: 'none' } } })
  const view = render(<PluginDetailSection request={REQUEST} t={translator(en)} {...face} />)
  expect(view.container.innerHTML).toBe('')
  const reasons = [
    ['too-large', en.detailTooLarge], ['network', en.detailNetwork], ['denied', en.detailDenied],
    ['invalid', en.detailInvalid], ['other', en.detailFailed],
  ] as const
  for (const [failure, text] of reasons) {
    set(key, { status: 'error', failure })
    expect(screen.getByRole('alert').textContent).toBe(text)
  }
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(face.retryDetail).toHaveBeenCalledWith(REQUEST, 'en')
})
