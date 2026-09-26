// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GuideArtworkBrowser, GuideArtworkFiles,
  PluginArtworkDefault, PluginArtworkLoop, PluginArtworkSearch, PluginArtworkSubagent, PluginArtworkTerminal,
} from '@deepseek-ai/dsh-client-ui-primitives'

afterEach(cleanup)

const artworks = {
  GuideArtworkBrowser,
  GuideArtworkFiles,
  PluginArtworkTerminal,
  PluginArtworkLoop,
  PluginArtworkSubagent,
  PluginArtworkSearch,
  PluginArtworkDefault,
} as const

describe('plugin artwork', () => {
  it.each(Object.entries(artworks))('%s renders its 36-viewBox svg honoring size and className', (_name, Artwork) => {
    const { container } = render(<Artwork size={30} className="deco" />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('viewBox')).toBe('0 0 36 36')
    expect(svg?.getAttribute('width')).toBe('30')
    expect(svg?.getAttribute('height')).toBe('30')
    expect(svg?.getAttribute('class')).toBe('deco')
  })

  it('clips the search ring through its per-instance clipPath around the conic-gradient div', () => {
    const { container } = render(<PluginArtworkSearch />)
    const clipId = container.querySelector('clipPath')?.id ?? ''
    expect(clipId).not.toBe('')
    expect(container.querySelector('g[clip-path]')?.getAttribute('clip-path')).toBe(`url(#${clipId})`)
    expect(container.querySelector('foreignObject div')).not.toBeNull()
  })

  it.each(Object.entries(artworks))('%s renders at 36 by default and repeats without document-global ids', (_name, Artwork) => {
    const { container } = render(
      <>
        <Artwork />
        <Artwork />
      </>,
    )
    for (const svg of container.querySelectorAll('svg')) expect(svg.getAttribute('width')).toBe('36')
    const ids = [...container.querySelectorAll('[id]')].map(node => node.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const reference of container.querySelectorAll('[fill^="url("], [clip-path^="url("]')) {
      const target = (reference.getAttribute('fill') ?? reference.getAttribute('clip-path') ?? '').slice('url(#'.length, -1)
      expect(ids).toContain(target)
    }
  })
})
