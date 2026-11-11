// @vitest-environment jsdom
/** Direct component fixtures fail loudly when an unstubbed menu is activated. */
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { contextMenuHook } from '../src/context-menu.ts'
import { brandString } from '@deepseek-ai/dsh-brand'

afterEach(cleanup)

it('requires an activation observer when a fixture opens a menu', () => {
  const { getTriggerProps } = contextMenuHook()()
  const contextMenuProps = getTriggerProps({ kind: 'file', value: { sessionId: brandString<SessionId>('fixture'), path: '/file' } })
  const observed = vi.fn()
  const view = render(<button onContextMenu={(event) => {
    expect(() => contextMenuProps.onContextMenu?.(event)).toThrow('Unexpected context menu')
    observed()
  }}>File</button>)
  fireEvent.contextMenu(view.getByRole('button'), { clientX: 1, clientY: 2 })
  expect(observed).toHaveBeenCalledOnce()
})
