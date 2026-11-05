// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ShareCapabilitiesPicker } from '../src/client/ShareCapabilitiesPicker.tsx'
import type { OfferedPlugin } from '../src/client/share-types.ts'

const t = ((key: string) => key) as never
const offered: readonly OfferedPlugin[] = [{
  plugin: 'mekGit',
  endpoints: ['mekGit/commit'],
  descriptions: { 'mekGit/commit': '提交当前工作区' },
}]

describe('plugin method picker', () => {
  it('renders a partial plugin with its method description', () => {
    const onChange = vi.fn()
    render(
      <ShareCapabilitiesPicker
        offered={offered}
        access="custom"
        selection={[{ plugin: 'mekGit', mode: 'selected', endpoints: ['mekGit/commit'] }]}
        disabled={false}
        controlId="capabilities"
        onAccessChange={vi.fn()}
        onChange={onChange}
        t={t}
      />,
    )
    expect(screen.getByText('提交当前工作区')).toBeTruthy()
    expect(screen.getByText('commit')).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox'))
    expect(onChange).toHaveBeenCalled()
  })


  it('reports the global switch as none when the last exposed plugin closes', () => {
    const onAccessChange = vi.fn()
    const onChange = vi.fn()
    const { container } = render(
      <ShareCapabilitiesPicker
        offered={offered}
        access="custom"
        selection={[{ plugin: 'mekGit', mode: 'all' }]}
        disabled={false}
        controlId="capabilities"
        onAccessChange={onAccessChange}
        onChange={onChange}
        t={t}
      />,
    )
    fireEvent.click(within(container).getByRole('tab', { name: 'dialog.capabilities.tier.none' }))
    expect(onAccessChange).toHaveBeenCalledWith('none')
    expect(onChange).toHaveBeenCalledWith([])
  })

  it('renders nothing when every offered plugin has no methods', () => {
    const { container } = render(
      <ShareCapabilitiesPicker
        offered={[{ plugin: 'empty', endpoints: [] }]}
        access="none"
        selection={[]}
        disabled={false}
        controlId="capabilities"
        onAccessChange={vi.fn()}
        onChange={vi.fn()}
        t={t}
      />,
    )
    expect(container.firstChild).toBeNull()
  })
})
