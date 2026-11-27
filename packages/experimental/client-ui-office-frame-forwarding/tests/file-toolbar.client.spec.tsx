// @vitest-environment jsdom
/** Office controls preserve the document's keyboard focus while invoking actions. */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { IconPlayOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives/client'
import { FileToolbarButton } from '../src/client/primitives/FileToolbar.tsx'
import { ToolbarButton } from '../src/client/ToolbarButton.tsx'

afterEach(cleanup)

test('file and Office commands are accessible and keep focus on mouse down', () => {
  const play = vi.fn(), command = vi.fn()
  const view = render(<>
    <FileToolbarButton icon={<IconPlayOutlineRegular />} label="Play" onClick={play} />
    <ToolbarButton action="retry" label="Retry" disabled={false} onClick={command} />
    <ToolbarButton action="next" label="Forward" disabled={false} active onClick={command} />
  </>)
  fireEvent.click(view.getByRole('button', { name: 'Play' }))
  expect(play).toHaveBeenCalledOnce()
  const button = view.getByRole('button', { name: 'Retry' })
  expect(button.textContent).toBe('Retry')
  const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
  fireEvent(button, event)
  expect(event.defaultPrevented).toBe(true)
  fireEvent.click(button)
  expect(command).toHaveBeenCalledOnce()
  const forward = view.getByRole('button', { name: 'Forward' })
  expect(forward.textContent).toBe('')
  expect(forward.getAttribute('aria-pressed')).toBe('true')
})
