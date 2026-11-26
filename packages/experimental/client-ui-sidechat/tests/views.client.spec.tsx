// @vitest-environment jsdom
/** Tabs show loading, failure and the embedded Chat; titles follow the child; the root Toast reports a failed creation. */
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SidechatConversation, SidechatTab, SidechatTitle, SidechatToast } from '../src/client/views.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)
const t = makeTranslate(en)

it('shows loading and failure feedback before binding the retained child around the Conversation', () => {
  const reference = { id: 'child' }
  const received = vi.fn()
  let resource: { status: string; value: unknown } = { status: 'loading', value: undefined }
  const props: Partial<Parameters<typeof SidechatTab>[0]> = {
    t,
    useTabInfo: () => ({ tab: { contentId: 'resource' } }) as never,
    useResource: () => resource as never,
    SessionProvider: ({ session, children }) => { received(session); return <>{children}</> },
    renderSlot: () => <span>Child conversation</span>,
  }
  const view = render(<SidechatTab {...props as Parameters<typeof SidechatTab>[0]} />)
  expect(view.getByRole('status').textContent).toBe(en.loading)
  resource = { status: 'failed', value: undefined }
  view.rerender(<SidechatTab {...props as Parameters<typeof SidechatTab>[0]} />)
  expect(view.getByRole('alert').textContent).toBe(en.openFailed)
  resource = { status: 'live', value: reference }
  view.rerender(<SidechatTab {...props as Parameters<typeof SidechatTab>[0]} />)
  expect(view.getByText('Child conversation')).toBeDefined()
  expect(received).toHaveBeenCalledWith(reference)
})

interface ContentInput {
  variant: string
  phase: string
  hero: boolean
  onWorkspaceSelected: (id: string, adopt: () => void) => Promise<void>
}
type RenderView = (props: { renderSlot: (name: string, owner: object) => ReactNode }) => ReactNode
interface ContentOptions { slots: { views: RenderView } }

it.each([
  { openState: 'loading', phase: 'settling' },
  { openState: 'open', phase: 'active' },
])('renders the embedded Chat content in the $phase phase without a Hero', async ({ openState, phase }) => {
  const inputs: ContentInput[] = []
  const renderFactorySlot = (_name: string, input: ContentInput, options: ContentOptions): ReactNode => {
    inputs.push(input)
    return options.slots.views({ renderSlot: (name, owner) => <span>{name}:{JSON.stringify(owner)}</span> })
  }
  const props: Partial<Parameters<typeof SidechatConversation>[0]> = {
    useSession: select => select({ openState } as never),
    renderFactorySlot: renderFactorySlot as never,
  }
  render(<SidechatConversation {...props as Parameters<typeof SidechatConversation>[0]} />)
  expect(inputs.map(({ onWorkspaceSelected: _pick, ...rest }) => rest)).toEqual([{ variant: 'embedded', phase, hero: false }])
  expect(document.body.textContent).toBe('conversation.session:{"view":"chat"}')
  // The Hero never shows, so a Workspace pick has nothing to adopt.
  const adopt = vi.fn()
  await inputs[0]!.onWorkspaceSelected('workspace', adopt)
  expect(adopt).not.toHaveBeenCalled()
})

it.each([
  { address: 'dsh-resource://sidechat/session/child', title: 'Live title', byId: { child: { displayTitle: 'Live title' } } },
  { address: 'dsh-resource://sidechat/session/child', title: en.title, byId: {} },
  { address: 'https://example.test', title: en.title, byId: {} },
])('shows the child display title with the localized type title as fallback: $title', ({ address, title, byId }) => {
  const props: Partial<Parameters<typeof SidechatTitle>[0]> = {
    t,
    useTabInfo: () => ({ tab: { contentId: address, title: 'Stored title' } }) as never,
    useSessions: selector => selector({ byId } as never),
  }
  expect(render(<SidechatTitle {...props as Parameters<typeof SidechatTitle>[0]} />).container.textContent).toBe(title)
})

it('keeps the root failure notice optional and renders its localized text', () => {
  const props: Partial<Parameters<typeof SidechatToast>[0]> = { t, dismiss: vi.fn(), useNotice: selector => selector(null) }
  const view = render(<SidechatToast {...props as Parameters<typeof SidechatToast>[0]} />)
  expect(view.container.textContent).toBe('')
  view.rerender(<SidechatToast {...{ ...props, useNotice: selector => selector({ serial: 1, key: 'createFailed' }) } as Parameters<typeof SidechatToast>[0]} />)
  expect(document.body.textContent).toContain(en.createFailed)
})
