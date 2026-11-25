// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { createDocumentPortal } from '@deepseek-ai/dsh-client-ui-renderer/src/client/document-portal.tsx'
import { DropOverlay } from '../src/DropOverlay.tsx'

afterEach(cleanup)

/** The renderer's portal into this test document, as a mounted Slot receives it. */
const Portal = createDocumentPortal(document)

describe('DropOverlay', () => {
  it('portals the invitation with its title and limits desc to the body', () => {
    const view = render(
      <DropOverlay Portal={Portal} disabled={false} labels={{ title: '图片拖动到此处即可添加', desc: '最多 20 张，每张 5MB' }} />,
    )
    const overlay = view.getByRole('status')
    expect(view.container.contains(overlay)).toBe(false)
    expect(document.body.contains(overlay)).toBe(true)
    expect(overlay.textContent).toContain('图片拖动到此处即可添加')
    expect(overlay.textContent).toContain('最多 20 张，每张 5MB')
  })

  it('omits the desc line when none is resolved', () => {
    const view = render(<DropOverlay Portal={Portal} disabled={false} labels={{ title: '图片拖动到此处即可添加' }} />)
    expect(view.getByRole('status').textContent).toBe('图片拖动到此处即可添加')
  })

  it('drops the desc and switches the illustration while disabled', () => {
    const enabled = render(
      <DropOverlay Portal={Portal} disabled={false} labels={{ title: '拖入', desc: '限制' }} />,
    )
    const enabledSvg = enabled.getByRole('status').querySelector('svg')!.innerHTML
    enabled.unmount()
    const disabled = render(
      <DropOverlay Portal={Portal} disabled labels={{ title: '当前无法添加图片', desc: '限制' }} />,
    )
    const overlay = disabled.getByRole('status')
    expect(overlay.textContent).toBe('当前无法添加图片')
    expect(overlay.querySelector('svg')!.innerHTML).not.toBe(enabledSvg)
  })
})
