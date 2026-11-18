// @vitest-environment jsdom
/** A detached tab cannot render Session-scoped extension rows. */
import type { ReactNode } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { TabMenuContent } from '../src/client/shell/TabMenuContent.tsx'

afterEach(cleanup)
it('renders no extension rows for another target or an unretained Session', () => {
  const renderSlot = vi.fn(() => null)
  const props = { dismiss: vi.fn(), useViews: (select: (views: never[]) => unknown) => select([]),
    SessionProvider: ({ children }: { children: ReactNode }) => children,
    renderSlot, target: { kind: 'image', value: { url: 'blob:original' } },
  } as ComponentProps<typeof TabMenuContent>
  const view = render(<TabMenuContent {...props} />)
  view.rerender(<TabMenuContent {...props} target={{ kind: 'tab', value: { sessionId: 'gone', paneId: 'gone', tab: {} } } as never} />)
  expect(view.container.textContent).toBe('')
  expect(renderSlot).not.toHaveBeenCalled()
})
