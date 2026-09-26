// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { fileMediaUrl } from '@deepseek-ai/dsh-util-workspace-path'
import { MarkdownDelegateProvider } from '../src/markdown/MarkdownDelegate.tsx'
import { MarkdownText } from './markdown-test-components.tsx'
import { parseGfm, parseGfmWithMath } from '../src/markdown/parse.ts'

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })
const labels = { open: 'View full image', dialog: 'Image preview', close: 'Close preview', loading: 'Loading image', failed: 'Image unavailable' }
const fileImages = { resolve: (path: string) => `https://example.com/api/file?path=${encodeURIComponent('/workspace/' + path)}`, labels }
function mount(text: string, streaming = false) {
  const openFile = vi.fn()
  const view = render(<MarkdownDelegateProvider openFile={openFile} fileImages={fileImages}>
    <MarkdownText text={text} streaming={streaming} />
  </MarkdownDelegateProvider>)
  return { ...view, openFile }
}

it('loads Desktop inline and hover previews through the file route after streaming settles', () => {
  vi.useFakeTimers()
  const path = '/work/测试 图片#100%.png'
  const src = fileMediaUrl('dsh-app://app/', path)!
  const images = { resolve: (value: string) => fileMediaUrl('dsh-app://app/', value), labels }
  const text = `![图片](<${encodeURI(path).replace('#', '%23')}>)\n\n[打开图片](<${encodeURI(path).replace('#', '%23')}>)`
  const openFile = vi.fn()
  const content = (streaming: boolean) => <MarkdownDelegateProvider fileImages={images} openFile={openFile}>
    <MarkdownText text={text} streaming={streaming} />
  </MarkdownDelegateProvider>
  const view = render(content(true))
  expect(view.container.querySelector('img')).toBeNull()
  view.rerender(content(false))
  expect(screen.getByRole('img').getAttribute('src')).toBe(src)
  const trigger = screen.getByRole('button', { name: 'View full image: 图片' })
  trigger.focus()
  fireEvent.click(trigger)
  expect(screen.getByRole('dialog').querySelector('img')?.getAttribute('src')).toBe(src)
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(trigger)
  const link = screen.getByRole('button', { name: '打开图片' })
  fireEvent.pointerEnter(link.parentElement!)
  act(() => { vi.advanceTimersByTime(500) })
  expect(screen.getByAltText(path).getAttribute('src')).toBe(src)
  fireEvent.error(screen.getByAltText(path))
  expect(screen.getByText(labels.failed)).toBeTruthy()
  fireEvent.click(link)
  expect(openFile).toHaveBeenCalledWith(path, undefined)
})

it('opens inline images in the shared lightbox, restores focus, and never opens the sidebar', () => {
  const { openFile } = mount('![Compare](<.artifacts/对比 image.png>)')
  const trigger = screen.getByRole('button', { name: 'View full image: Compare' })
  trigger.focus()
  expect(new URL(screen.getByRole('img').getAttribute('src')!).searchParams.get('path')).toBe('/workspace/.artifacts/对比 image.png')
  fireEvent.click(trigger)
  expect(screen.getByRole('dialog', { name: 'Image preview' })).toBeTruthy()
  fireEvent.keyDown(window, { key: 'Tab' })
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close preview' }))
  fireEvent.click(screen.getByRole('button', { name: 'Close preview' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(trigger)
  expect(openFile).not.toHaveBeenCalled()
})

it('loads a link preview only after hover dwell and keeps its existing sidebar activation', () => {
  vi.useFakeTimers()
  const { openFile } = mount('[View comparison](.artifacts/对比%20image.png)')
  const link = screen.getByRole('button', { name: 'View comparison' })
  expect(screen.queryByRole('img')).toBeNull()
  fireEvent.pointerEnter(link.parentElement!)
  act(() => { vi.advanceTimersByTime(499) })
  expect(screen.queryByRole('img')).toBeNull()
  act(() => { vi.advanceTimersByTime(1) })
  const image = screen.getByRole('img')
  expect(new URL(image.getAttribute('src')!).searchParams.get('path')).toBe('/workspace/.artifacts/对比 image.png')
  fireEvent.load(image)
  expect(screen.queryByText('Loading image')).toBeNull()
  fireEvent.pointerDown(link)
  fireEvent.click(link)
  expect(screen.queryByRole('img')).toBeNull()
  expect(openFile).toHaveBeenCalledWith('.artifacts/对比 image.png', undefined)
})

it('supports keyboard previews, Escape dismissal, and an inert failure state', () => {
  mount('[View comparison](graph.png)')
  const link = screen.getByRole('button', { name: 'View comparison' })
  // jsdom does not model keyboard input modality for :focus-visible.
  vi.spyOn(link, 'matches').mockReturnValue(true)
  act(() => { link.focus() })
  fireEvent.error(screen.getByRole('img'))
  expect(screen.getByText('Image unavailable')).toBeTruthy()
  fireEvent.keyDown(link, { key: 'Escape' })
  expect(screen.queryByText('Image unavailable')).toBeNull()
})

it('leaves non-image links and streaming paths without a preview', () => {
  mount('[Report](report.pdf)')
  fireEvent.focus(screen.getByRole('button', { name: 'Report' }))
  expect(screen.queryByRole('img')).toBeNull()
  cleanup()
  mount('![Compare](image.png)', true)
  expect(screen.queryByRole('img')).toBeNull()
})

it('keeps image-only links as one activation target', () => {
  const { container, openFile } = mount('[![Compare](image.png)](image.png)')
  expect(container.querySelectorAll('button')).toHaveLength(1)
  fireEvent.click(screen.getByRole('button'))
  expect(openFile).toHaveBeenCalledWith('image.png', undefined)
  expect(screen.queryByRole('dialog')).toBeNull()
})

it.each([parseGfm, parseGfmWithMath])('recovers standalone bare-space paths without promoting code or escaped syntax', (parse) => {
  const source = '![图](/work/test workspace/测试文件/图.png)'
  expect(parse(source).children[0]).toMatchObject({ children: [{ type: 'image', url: '/work/test workspace/测试文件/图.png' }] })
  for (const example of ['`' + source + '`', '```md\n' + source + '\n```', '\\' + source, 'Example: ' + source,
    '![图](https://example.com/test image.png)', '![图](/work/test (image).png)']) {
    expect(JSON.stringify(parse(example))).not.toContain('"type":"image"')
  }
})

it('keeps an unavailable image link navigable without showing a hover preview', () => {
  const openFile = vi.fn()
  render(<MarkdownDelegateProvider openFile={openFile} fileImages={{ ...fileImages, resolve: () => undefined }}>
    <MarkdownText text="[Image](relative.png)" />
  </MarkdownDelegateProvider>)
  const link = screen.getByRole('button', { name: 'Image' })
  fireEvent.focus(link)
  expect(screen.queryByRole('img')).toBeNull()
  fireEvent.click(link)
  expect(openFile).toHaveBeenCalledWith('relative.png', undefined)
})

it('labels empty-alt image activation and retains a localized failure description', () => {
  mount('![](image.png)')
  expect(screen.getByRole('button', { name: 'View full image' })).toBeTruthy()
  fireEvent.error(document.querySelector('img')!)
  expect(screen.getByText('Image unavailable · image.png')).toBeTruthy()
  expect(screen.queryByRole('button')).toBeNull()
})

it.each([parseGfm, parseGfmWithMath])('uses the shared image categories for bare-space recovery', (parse) => {
  for (const extension of ['avif', 'tif', 'tiff', 'heic', 'heif']) {
    expect(parse(`![图](/work/test dir/photo.${extension})`).children[0])
      .toMatchObject({ children: [{ type: 'image', url: `/work/test dir/photo.${extension}` }] })
  }
  expect(JSON.stringify(parse('![report](/work/test dir/report.pdf)'))).not.toContain('"type":"image"')
})
