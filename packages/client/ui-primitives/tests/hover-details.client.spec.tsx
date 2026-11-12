// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { HoverDetails } from '@deepseek-ai/dsh-client-ui-primitives'

afterEach(cleanup)

describe('HoverDetails', () => {
  it('stacks the title, lines, state, and measures in order', () => {
    const view = render(
      <HoverDetails
        title="Survey open-source harnesses"
        lines={['Owner: open-source-arch']}
        status={{ state: 'done', label: 'Completed' }}
        facts={[{ icon: <svg data-testid="tokens" />, label: '3.3M tok' }, { icon: <svg />, label: '6m 56s' }]}
      />,
    )
    const root = view.container.querySelector('[data-hover-details]') as HTMLElement
    expect([...root.children].map(child => child.textContent))
      .toEqual(['Survey open-source harnesses', 'Owner: open-source-arch', 'Completed', '3.3M tok6m 56s'])
    expect(root.children[2]?.querySelector('[data-state="done"]')).not.toBeNull()
    expect(screen.getByTestId('tokens').parentElement?.getAttribute('aria-hidden')).toBe('true')
  })

  it('renders only the title when nothing else is given', () => {
    const view = render(<HoverDetails title="sleep 30" />)
    expect((view.container.querySelector('[data-hover-details]') as HTMLElement).children).toHaveLength(1)
  })

  it('starts with the lines when the title is omitted', () => {
    const view = render(<HoverDetails lines={['bash']} status={{ state: 'ongoing', label: 'running' }} />)
    expect([...(view.container.querySelector('[data-hover-details]') as HTMLElement).children].map(child => child.textContent))
      .toEqual(['bash', 'running'])
  })
})
