// @vitest-environment jsdom

import { useState } from 'react'
import type { PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { en, zh } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'
import { UiConversation } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation/assembly.ts'
import { ImageGallery, MessageImage } from '../src/MessageImage.tsx'
import type { MessageImageLabels } from '../src/MessageImage.tsx'
import * as attachmentPlugin from '../src/client/index.ts'

afterEach(cleanup)

const labels: MessageImageLabels = {
  image: '图片',
  open: '查看原图',
  openNamed: label => `${label}，点击查看原图`,
  loading: '图片加载中…',
  loadFailed: '图片加载失败，点击重试',
  lightbox: { dialog: '原图预览', close: '关闭原图预览' },
}

const attachment = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
  mediaType: 'image/png' as const,
  bytes: 68,
  width: 640,
  height: 320,
  name: 'history.png',
}

describe('MessageImage', () => {
  it('renders a cached URL on the first frame while refreshing it', () => {
    const load = Object.assign(vi.fn(() => new Promise<string>(() => {})), {
      peek: vi.fn(() => 'blob:seeded'),
    })
    const view = render(<MessageImage fileDrag={fileDrag} image={{ attachment }} load={load} variant="single" labels={labels} />)
    expect(view.queryByText('图片加载中…')).toBeNull()
    expect((view.getByAltText('history.png') as HTMLImageElement).src).toContain('blob:seeded')
    expect(load).toHaveBeenCalledWith(attachment)
  })

  it('loads a session-authorized URL, bounds the thumbnail, and clicks into the original', async () => {
    const load = vi.fn().mockResolvedValue('blob:history')
    const view = render(<MessageImage fileDrag={fileDrag} image={{ attachment }} load={load} variant="single" labels={labels} />)
    const frame = view.getByRole('button', { name: 'history.png，点击查看原图' })
    expect(frame.getAttribute('style')).toContain('width: 240px')
    expect(frame.getAttribute('style')).toContain('height: 120px')
    expect(frame.getAttribute('title')).toBe('查看原图')
    await waitFor(() => { expect(view.getByAltText('history.png')).toBeTruthy() })
    expect(load).toHaveBeenCalledWith(attachment)
    fireEvent.click(frame)
    expect(view.getByRole('dialog', { name: '原图预览' })).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: '关闭原图预览' }))
    expect(view.queryByRole('dialog', { name: '原图预览' })).toBeNull()
  })

  it('ignores a click while the thumbnail is still loading', () => {
    const load = vi.fn(() => new Promise<string>(() => {}))
    const view = render(<MessageImage fileDrag={fileDrag} image={{ attachment }} load={load} variant="single" labels={labels} />)
    const frame = view.getByRole('button', { name: 'history.png，点击查看原图' })
    expect(view.getByText('图片加载中…')).toBeTruthy()
    fireEvent.click(frame)
    expect(view.queryByRole('dialog')).toBeNull()
  })

  it('falls back to the image label for an unnamed attachment', async () => {
    const { name: _named, ...unnamed } = attachment
    const load = vi.fn().mockResolvedValue('blob:unnamed')
    const view = render(<MessageImage fileDrag={fileDrag} image={{ attachment: unnamed }} load={load} variant="single" labels={labels} />)
    await waitFor(() => { expect(view.getByAltText('图片')).toBeTruthy() })
    expect(view.getByRole('button', { name: '图片，点击查看原图' })).toBeTruthy()
  })

  it('surfaces a retry control when durable bytes cannot be read, including a failed retry', async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('still offline'))
      .mockResolvedValueOnce('blob:retry')
    const view = render(<MessageImage fileDrag={fileDrag} image={{ attachment }} load={load} variant="single" labels={labels} />)
    const retry = await view.findByRole('button', { name: '图片加载失败，点击重试' })
    fireEvent.click(retry)
    const retryAgain = await view.findByRole('button', { name: '图片加载失败，点击重试' })
    fireEvent.click(retryAgain)
    await waitFor(() => { expect(view.getByAltText('history.png')).toBeTruthy() })
    expect(load).toHaveBeenCalledTimes(3)
  })

  it('clamps extreme aspect ratios and anchors the crop toward the informative edge', async () => {
    const load = vi.fn().mockResolvedValue('blob:ratio')
    const tall = render(
      <MessageImage fileDrag={fileDrag} image={{ attachment: { ...attachment, width: 100, height: 2000 } }} load={load} variant="single" labels={labels} />,
    )
    const tallFrame = tall.getByRole('button', { name: 'history.png，点击查看原图' })
    expect(tallFrame.getAttribute('style')).toContain('width: 60px')
    expect(tallFrame.getAttribute('style')).toContain('height: 240px')
    await waitFor(() => { expect(tall.getByAltText('history.png')).toBeTruthy() })
    expect(tall.getByAltText('history.png').style.objectPosition).toBe('center top')
    tall.unmount()
    const wide = render(
      <MessageImage fileDrag={fileDrag} image={{ attachment: { ...attachment, width: 4000, height: 100 } }} load={load} variant="single" labels={labels} />,
    )
    const wideFrame = wide.getByRole('button', { name: 'history.png，点击查看原图' })
    expect(wideFrame.getAttribute('style')).toContain('width: 240px')
    expect(wideFrame.getAttribute('style')).toContain('height: 60px')
    await waitFor(() => { expect(wide.getByAltText('history.png')).toBeTruthy() })
    expect(wide.getByAltText('history.png').style.objectPosition).toBe('left center')
    wide.unmount()
    const small = render(
      <MessageImage fileDrag={fileDrag} image={{ attachment: { ...attachment, width: 100, height: 100 } }} load={load} variant="single" labels={labels} />,
    )
    const smallFrame = small.getByRole('button', { name: 'history.png，点击查看原图' })
    expect(smallFrame.getAttribute('style')).toContain('width: 100px')
    expect(smallFrame.getAttribute('style')).toContain('height: 100px')
  })

  it('renders a tile at the fixed square without inline sizing', () => {
    const load = vi.fn(() => new Promise<string>(() => {}))
    const view = render(<MessageImage fileDrag={fileDrag} image={{ attachment }} load={load} variant="tile" labels={labels} />)
    const frame = view.getByRole('button', { name: 'history.png，点击查看原图' })
    expect(frame.getAttribute('data-variant')).toBe('tile')
    expect(frame.getAttribute('style')).toBeNull()
  })

  it.each(['tile', 'thumbnail'] as const)('keeps the %s variant on the failed-load retry control', async (variant) => {
    const load = vi.fn().mockRejectedValue(new Error('offline'))
    const view = render(<MessageImage fileDrag={fileDrag} image={{ attachment }} load={load} variant={variant} labels={labels} />)
    const retry = await view.findByRole('button', { name: '图片加载失败，点击重试' })
    expect(retry.getAttribute('data-variant')).toBe(variant)
  })

  it.each([
    ['Chinese', labels],
    ['English', { ...labels, loading: 'Loading image…', loadFailed: 'Image failed to load; click to retry' }],
  ] as const)('labels thumbnail status icons and retries a failed read in %s', async (_locale, statusLabels) => {
    const pending = Promise.withResolvers<string>()
    const load = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue('blob:retry')
    const view = render(<MessageImage fileDrag={fileDrag} image={{ attachment }} load={load} variant="thumbnail" labels={statusLabels} />)
    const loading = view.getByRole('button', { name: statusLabels.loading })
    expect(loading.getAttribute('title')).toBe(statusLabels.loading)
    expect(loading.getAttribute('aria-busy')).toBe('true')
    expect(loading.textContent).toBe('')
    expect(loading.querySelector('svg')).not.toBeNull()

    await act(async () => { pending.reject(new Error('offline')) })
    const retry = view.getByRole('button', { name: statusLabels.loadFailed })
    expect(retry.getAttribute('title')).toBe(statusLabels.loadFailed)
    expect(retry.textContent).toBe('')
    expect(retry.querySelector('svg')).not.toBeNull()
    fireEvent.click(retry)
    await view.findByAltText(attachment.name)
    const opener = view.getByRole('button', { name: statusLabels.openNamed(attachment.name) })
    expect(opener.getAttribute('aria-busy')).toBeNull()
    expect(opener.getAttribute('title')).toBe(statusLabels.open)
    expect(load).toHaveBeenCalledTimes(2)
    expect(load).toHaveBeenLastCalledWith(attachment)
  })

  it('uses the owner display name for an unnamed thumbnail and its original-image viewer', async () => {
    const { name: _name, ...unnamed } = attachment
    const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('blob:thumbnail')
    const view = render(<ImageGallery fileDrag={fileDrag} images={[{ attachment: unnamed, label: 'Image 2' }]} load={load} align="start" thumbnail labels={labels} />)
    fireEvent.click(await view.findByRole('button', { name: labels.loadFailed }))
    const image = await view.findByAltText('Image 2')
    expect(image.closest('button')?.getAttribute('data-variant')).toBe('thumbnail')
    const opener = view.getByRole('button', { name: 'Image 2，点击查看原图' })
    opener.focus()
    fireEvent.click(opener)
    expect(view.getByRole('dialog')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(view.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
    expect(load).toHaveBeenLastCalledWith(unnamed)
    expect(unnamed).not.toHaveProperty('name')
  })

  it('ignores a load settling after unmount', async () => {
    let resolve: ((url: string) => void) | undefined
    const load = vi.fn(() => new Promise<string>((r) => { resolve = r }))
    const view = render(<MessageImage fileDrag={fileDrag} image={{ attachment }} load={load} variant="single" labels={labels} />)
    view.unmount()
    resolve?.('blob:late')
    await Promise.resolve()
    let reject: ((error: Error) => void) | undefined
    const failing = vi.fn(() => new Promise<string>((_r, rej) => { reject = rej }))
    const second = render(<MessageImage fileDrag={fileDrag} image={{ attachment }} load={failing} variant="single" labels={labels} />)
    second.unmount()
    reject?.(new Error('late failure'))
    await Promise.resolve()
  })
})

describe('MessageImage preview arm', () => {
  it('displays a local preview immediately, without the loader, sized by its probed dimensions', () => {
    const load = vi.fn()
    const view = render(
      <MessageImage fileDrag={fileDrag}
        image={{ preview: { url: 'blob:echo', name: 'echo.png', width: 640, height: 320 } }}
        load={load}
        variant="single"
        labels={labels}
      />,
    )
    expect(load).not.toHaveBeenCalled()
    const img = view.getByAltText('echo.png') as HTMLImageElement
    expect(img.src).toContain('blob:echo')
    const frame = img.closest('button') as HTMLButtonElement
    expect(frame.style.width).toBe('240px')
    expect(frame.style.height).toBe('120px')
  })

  it('sizes an unprobed lone preview as a square crop and falls back to the image label', () => {
    const load = vi.fn()
    const view = render(
      <MessageImage fileDrag={fileDrag} image={{ preview: { url: 'blob:unprobed' } }} load={load} variant="single" labels={labels} />,
    )
    const img = view.getByAltText('图片') as HTMLImageElement
    const frame = img.closest('button') as HTMLButtonElement
    expect(frame.style.width).toBe('240px')
    expect(frame.style.height).toBe('240px')
  })

  it('opens the lightbox from a preview thumbnail', () => {
    const view = render(
      <MessageImage fileDrag={fileDrag} image={{ preview: { url: 'blob:box' } }} load={vi.fn(async () => '')} variant="tile" labels={labels} />,
    )
    fireEvent.click(view.getByRole('button', { name: '图片，点击查看原图' }))
    expect(view.getByRole('dialog', { name: '原图预览' })).toBeTruthy()
  })
})

describe('ImageGallery', () => {
  it('renders nothing without images and an aligned wrapping group with them', async () => {
    const load = vi.fn().mockResolvedValue('blob:gallery')
    const empty = render(<ImageGallery fileDrag={fileDrag} images={[]} load={load} align="start" labels={labels} />)
    expect(empty.container.firstChild).toBeNull()
    const view = render(
      <ImageGallery fileDrag={fileDrag}
        images={[{ attachment }, { preview: { url: 'blob:echo', name: 'echo.png' } }, { attachment }]}
        load={load}
        align="end"
        labels={labels}
      />,
    )
    expect(view.container.querySelector('[data-align="end"]')).not.toBeNull()
    await waitFor(() => { expect(view.getAllByAltText('history.png')).toHaveLength(2) })
    expect(view.getByAltText('echo.png')).toBeTruthy()
  })

  it('renders a lone image large and compact or grouped images as square tiles', () => {
    const load = vi.fn(() => new Promise<string>(() => {}))
    const lone = render(<ImageGallery fileDrag={fileDrag} images={[{ attachment }]} load={load} align="start" labels={labels} />)
    expect(lone.container.querySelectorAll('[data-variant="single"]')).toHaveLength(1)
    lone.unmount()
    const compact = render(
      <ImageGallery fileDrag={fileDrag} images={[{ attachment }]} load={load} align="end" compact labels={labels} />,
    )
    expect(compact.container.querySelectorAll('[data-variant="tile"]')).toHaveLength(1)
    compact.unmount()
    const several = render(
      <ImageGallery fileDrag={fileDrag} images={[{ attachment }, { attachment }, { attachment }]} load={load} align="end" labels={labels} />,
    )
    expect(several.container.querySelectorAll('[data-variant="tile"]')).toHaveLength(3)
  })

  it('uses complete Factory labels unchanged and restores defaults without remounting the image', async () => {
    const runtime = await SlotTestRuntime.create()
    onTestFinished(() => runtime.dispose())
    const locale = new LocaleRuntime(runtime.ctx)
    locale.register('conversation', { en, zh })
    locale.setLocale('en')
    runtime.ctx.provide('locale', locale)
    runtime.slots.installLocale(locale)
    runtime.ctx.provide('fileDrag', { actions: fileDrag, read: () => undefined })
    await runtime.mount(attachmentPlugin)
    const images = [{ preview: { url: 'blob:labels', name: 'preview.png' } }]
    const loadImage = vi.fn(async () => 'blob:unused')
    await runtime.root.declare({}, ({ renderFactorySlot }: PropsRuntime<'root'> & PropsRenderFactories) => {
      const [custom, setCustom] = useState(true)
      return <>
        <button onClick={() => { setCustom(false) }}>Default labels</button>
        {renderFactorySlot('conversation.images.content', {
          images, loadImage, align: 'start', ...(custom ? { labels } : {}),
        })}
      </>
    })
    const view = runtime.renderRoot()
    const image = view.getByAltText('preview.png')
    const frame = view.getByRole('button', { name: 'preview.png，点击查看原图' })
    expect(frame.getAttribute('title')).toBe(labels.open)
    fireEvent.click(frame)
    expect(view.getByRole('dialog', { name: labels.lightbox.dialog })).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: labels.lightbox.close }))
    fireEvent.click(view.getByRole('button', { name: 'Default labels' }))
    const defaultFrame = view.getByRole('button', { name: 'preview.png, click to view original' })
    expect(defaultFrame).toBe(frame)
    expect(view.getByAltText('preview.png')).toBe(image)
    expect(defaultFrame.getAttribute('title')).toBe('View original')
    fireEvent.click(defaultFrame)
    expect(view.getByRole('dialog', { name: 'Original image preview' })).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Close original image preview' }))
    expect(loadImage).not.toHaveBeenCalled()
  })

  it('renders the conversation slot entry with translated labels', async () => {
    const runtime = await SlotTestRuntime.create()
    onTestFinished(() => runtime.dispose())
    const locale = new LocaleRuntime(runtime.ctx)
    locale.register('conversation', { en, zh })
    locale.setLocale('zh')
    runtime.ctx.provide('locale', locale)
    new UiConversation(runtime.ctx, runtime.sessions)
    runtime.slots.installLocale(locale)
    await runtime.declare({ 'conversation.chat.message.images': { kind: 'single', scope: 'session' } })
    runtime.ctx.provide('fileDrag', { actions: fileDrag, read: () => undefined })
    await runtime.mount(attachmentPlugin)
    await runtime.sessions.add({ id: 'message-images-test' })
    const session = runtime.sessions.retainFor(runtime.ctx, SessionId('message-images-test'))
    const loadImage = vi.fn().mockResolvedValue('blob:slot-image')
    const slot = runtime.renderSlot('conversation.chat.message.images', {
      images: [{ attachment }], loadImage, align: 'end',
    }, { session })
    const { view, container } = slot
    await waitFor(() => { expect(view.getByAltText('history.png')).toBeTruthy() })
    expect(view.getByRole('button', { name: 'history.png，点击查看原图' })).toBeTruthy()
    expect(container.querySelector('[data-align="end"]')).not.toBeNull()
    expect(loadImage).toHaveBeenCalledWith(attachment)
    expect(view.getByRole('button', { name: 'history.png，点击查看原图' }).getAttribute('data-variant')).toBe('single')
    for (const [compact, thumbnail, variant] of [
      [true, false, 'tile'],
      [false, true, 'thumbnail'],
      [false, false, 'single'],
    ] as const) {
      slot.update({ images: [{ attachment }], loadImage, align: 'end', compact, thumbnail })
      expect(view.getByRole('button', { name: 'history.png，点击查看原图' }).getAttribute('data-variant')).toBe(variant)
      expect(view.getByAltText('history.png').getAttribute('src')).toBe('blob:slot-image')
      expect(container.querySelector('[data-align="end"]')).not.toBeNull()
    }
    expect(loadImage).toHaveBeenCalledOnce()
  })
})

const fileDrag = { prepare: vi.fn(async () => ({ start: () => true, release: () => {} })), reportFailure: vi.fn() }
