// @vitest-environment jsdom
/** The Settings entry that leaves Settings for the Plugins page. */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginsSettingsLink, type PluginsSettingsLinkProps } from '../src/client/PluginsSettingsLink.tsx'

afterEach(cleanup)

describe('PluginsSettingsLink', () => {
  it('closes Settings and opens the Plugins page when selected, rendering nothing', () => {
    const calls: string[] = []
    const props = {
      close: vi.fn(() => { calls.push('close') }),
      openPlugins: vi.fn(() => { calls.push('open') }),
    } satisfies Pick<PluginsSettingsLinkProps, 'close' | 'openPlugins'>
    // The entry reads only its owner and injected members; the standard seats stay unused.
    const { container } = render(<PluginsSettingsLink {...props as PluginsSettingsLinkProps} />)
    expect(calls).toEqual(['close', 'open'])
    expect(container.childElementCount).toBe(0)
  })
})
