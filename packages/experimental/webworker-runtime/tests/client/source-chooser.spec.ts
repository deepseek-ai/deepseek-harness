// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreviewFixtureManifest } from '../../src/fixture-manifest.ts'
import { choosePreviewSource } from '../../src/client/source-chooser.ts'

const MANIFEST_URL = new URL('https://preview.test/preview/fixtures.json')

const MANIFEST: PreviewFixtureManifest = {
  version: 1,
  defaultFixture: 'example',
  fixtures: [{
    id: 'example',
    label: 'Example & <demo> "quoted" \'single\'',
    description: 'A deterministic example.',
    overlays: ['fixtures/base.tar.gz', 'fixtures/tail.tar.gz'],
  }],
  links: [],
}

function setLocation(search = ''): void {
  history.replaceState({}, '', `/preview.html${search}`)
}

function installManifest(manifest: PreviewFixtureManifest = MANIFEST): ReturnType<typeof vi.fn> {
  const fetch = vi.fn(async () => Response.json(manifest))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

function submitChooser(): void {
  const form = document.querySelector<HTMLFormElement>('[data-preview-source-card]')
  if (form === null) throw new Error('test chooser form was not rendered')
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
}

describe('Preview source chooser', () => {
  beforeEach(() => {
    document.head.replaceChildren()
    document.body.innerHTML = '<div id="root"></div>'
    setLocation()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('bypasses the chooser and manifest for an explicit empty source', async () => {
    setLocation('?preview-fixture=none')
    const fetch = installManifest()

    await expect(choosePreviewSource(MANIFEST_URL)).resolves.toEqual([])
    expect(fetch).not.toHaveBeenCalled()
    expect(document.querySelector('[data-preview-source-chooser]')).toBeNull()
  })

  it('bypasses the chooser and resolves an explicit built-in fixture', async () => {
    document.body.replaceChildren()
    setLocation('?preview-fixture=example')
    const fetch = installManifest()

    await expect(choosePreviewSource(MANIFEST_URL)).resolves.toEqual([
      new URL('https://preview.test/preview/fixtures/base.tar.gz'),
      new URL('https://preview.test/preview/fixtures/tail.tar.gz'),
    ])
    expect(fetch).toHaveBeenCalledOnce()
    expect(document.querySelector('[data-preview-source-chooser]')).toBeNull()
  })

  it.each(['', 'missing', 'webfs'])(
    'fails loud for the explicit unavailable source %j without opening the chooser',
    async (source) => {
      setLocation(`?preview-fixture=${source}`)
      installManifest()

      await expect(choosePreviewSource(MANIFEST_URL)).rejects.toThrow(/unknown or interactive source/)
      expect(document.querySelector('[data-preview-source-chooser]')).toBeNull()
    },
  )

  it('shows the chooser only when the query is absent and returns its default selection', async () => {
    installManifest()
    const root = document.getElementById('root')
    if (root === null) throw new Error('test root is missing')
    const bootPage = document.createElement('div')
    bootPage.dataset.dshBoot = ''
    root.append(bootPage)

    const selected = choosePreviewSource(MANIFEST_URL)
    await vi.waitFor(() => {
      expect(document.querySelector('[data-preview-source-chooser]')).not.toBeNull()
    })
    expect(document.querySelector<HTMLInputElement>('input[value="example"]')?.checked).toBe(true)
    expect(document.querySelector<HTMLInputElement>('input[value="webfs"]')?.disabled).toBe(true)
    expect(document.querySelector('[data-preview-source-card]')?.textContent)
      .toContain(MANIFEST.fixtures[0]?.label)
    expect(document.querySelector('[data-preview-source-card] script')).toBeNull()

    submitChooser()

    await expect(selected).resolves.toEqual([
      new URL('https://preview.test/preview/fixtures/base.tar.gz'),
      new URL('https://preview.test/preview/fixtures/tail.tar.gz'),
    ])
    expect(root.contains(bootPage)).toBe(true)
    expect(root.childElementCount).toBe(1)
    expect(document.querySelector('[data-preview-source-chooser]')).toBeNull()
    expect(document.querySelector('[data-preview-source-style]')).toBeNull()
  })

  it('shows manifest links resolved against the manifest URL', async () => {
    installManifest({ ...MANIFEST, links: [{ label: 'Snapshot <changes>', href: '../snapshot-diff/' }] })

    const selected = choosePreviewSource(MANIFEST_URL)
    await vi.waitFor(() => {
      expect(document.querySelector('[data-preview-source-link]')).not.toBeNull()
    })
    const link = document.querySelector<HTMLAnchorElement>('[data-preview-source-link]')
    expect([link?.textContent, link?.href]).toEqual(['Snapshot <changes>', 'https://preview.test/snapshot-diff/'])
    submitChooser()
    await selected
  })

  it('shows no link when the manifest has none', async () => {
    installManifest()

    const selected = choosePreviewSource(MANIFEST_URL)
    await vi.waitFor(() => {
      expect(document.querySelector('[data-preview-source-chooser]')).not.toBeNull()
    })
    expect(document.querySelector('[data-preview-source-link]')).toBeNull()
    submitChooser()
    await selected
  })

  it('selects the empty source when the manifest has no default', async () => {
    installManifest({ ...MANIFEST, defaultFixture: null })

    const selected = choosePreviewSource(MANIFEST_URL)
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLInputElement>('input[value="none"]')?.checked).toBe(true)
    })
    submitChooser()

    await expect(selected).resolves.toEqual([])
  })

  it('reports manifest, mount, form, selection, and catalog failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('missing', { status: 404 })))
    await expect(choosePreviewSource(MANIFEST_URL)).rejects.toThrow(/returned 404/)

    installManifest()
    document.body.replaceChildren()
    await expect(choosePreviewSource(MANIFEST_URL)).rejects.toThrow(/missing #root/)

    document.body.innerHTML = '<div id="root"></div>'
    const root = document.getElementById('root')
    if (root === null) throw new Error('test root is missing')
    const querySelector = vi.spyOn(HTMLElement.prototype, 'querySelector').mockReturnValueOnce(null)
    await expect(choosePreviewSource(MANIFEST_URL)).rejects.toThrow(/form was not rendered/)
    querySelector.mockRestore()

    document.head.replaceChildren()
    document.body.innerHTML = '<div id="root"></div>'
    const missingSelection = choosePreviewSource(MANIFEST_URL)
    await vi.waitFor(() => { expect(document.querySelector('form')).not.toBeNull() })
    document.querySelectorAll('input[name="preview-source"]').forEach((input) => {
      input.removeAttribute('name')
    })
    submitChooser()
    await expect(missingSelection).rejects.toThrow(/no source selected/)

    document.head.replaceChildren()
    document.body.innerHTML = '<div id="root"></div>'
    const unavailableSelection = choosePreviewSource(MANIFEST_URL)
    await vi.waitFor(() => { expect(document.querySelector('form')).not.toBeNull() })
    const selected = document.querySelector<HTMLInputElement>('input:checked')
    if (selected === null) throw new Error('test selection is missing')
    selected.value = 'missing'
    submitChooser()
    await expect(unavailableSelection).rejects.toThrow(/unavailable source/)
  })
})
