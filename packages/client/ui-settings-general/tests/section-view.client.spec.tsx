// @vitest-environment jsdom
/** The Factory that renders one settings page wherever a surface shows it. */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'
import { SettingsSectionView } from '../src/client/SettingsSectionView.tsx'

afterEach(cleanup)

describe('SettingsSectionView', () => {
  it('renders the requested entry with the caller\'s leave action', () => {
    const close = vi.fn()
    const renderSlot = vi.fn(() => <p>page body</p>)
    const props = { id: 'timeline', close, renderSlot } as Partial<FactoryComponentPropsOf<'settings.section.view'>>
    render(<SettingsSectionView {...props as FactoryComponentPropsOf<'settings.section.view'>} />)
    expect(screen.getByText('page body')).toBeTruthy()
    expect(renderSlot).toHaveBeenCalledExactlyOnceWith('settings.section', { close }, { only: 'timeline' })
  })
})
