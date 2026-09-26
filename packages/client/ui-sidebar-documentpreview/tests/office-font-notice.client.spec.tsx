// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { FontNotice, type FontNoticeProps } from '../src/client/office/FontNotice.tsx'
import { en, zh } from '../src/client/office/locales.ts'

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    disconnect(): void {}
  })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function props(overrides: Partial<FontNoticeProps> = {}): FontNoticeProps {
  return {
    fonts: ['Consolas', 'Missing Serif'],
    t: makeTranslate(en), ...overrides,
  }
}

it('opens details, restores focus on Escape or close, and dismisses outside without stealing focus', () => {
  render(<FontNotice {...props()} />)
  const more = screen.getByRole('button', { name: makeTranslate(en)('viewMissingFonts', { count: 2 }) })
  fireEvent.click(more)
  const dialog = screen.getByRole('dialog', { name: en.missingFontsTitle })
  expect(dialog.textContent).toContain('Consolas')
  expect(dialog.textContent).toContain('Missing Serif')
  expect(document.activeElement).toBe(dialog)
  fireEvent.keyDown(dialog, { key: 'ArrowDown' })
  expect(screen.getByRole('dialog')).toBe(dialog)
  fireEvent.keyDown(dialog, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(more)
  fireEvent.click(more)
  fireEvent.click(screen.getByRole('button', { name: en.closeDetails }))
  expect(screen.getByRole('button', { name: makeTranslate(en)('viewMissingFonts', { count: 2 }) })).toBe(more)
  expect(screen.queryByRole('status')).toBeNull()
  expect(document.activeElement).toBe(more)
  fireEvent.click(more)
  fireEvent.pointerDown(document.body)
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(more)
  fireEvent.click(more)
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('keeps details open while focus moves inside them and closes when focus leaves the notice', () => {
  render(<><FontNotice {...props()} /><button>Other action</button></>)
  const more = screen.getByRole('button', { name: makeTranslate(en)('viewMissingFonts', { count: 2 }) })
  fireEvent.click(more)
  const dialog = screen.getByRole('dialog')
  fireEvent.blur(dialog, { relatedTarget: screen.getByRole('button', { name: en.closeDetails }) })
  expect(screen.getByRole('dialog')).toBe(dialog)
  fireEvent.blur(dialog, { relatedTarget: more })
  expect(screen.getByRole('dialog')).toBe(dialog)
  fireEvent.blur(dialog, { relatedTarget: screen.getByRole('button', { name: 'Other action' }) })
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('shows a warning without automatically opening details or remembering that they were viewed', () => {
  const view = render(<FontNotice {...props()} />)
  const warning = screen.getByRole('button')
  expect(warning.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(warning)
  fireEvent.click(screen.getByRole('button', { name: en.closeDetails }))
  expect(screen.getByRole('button', { name: makeTranslate(en)('viewMissingFonts', { count: 2 }) })).toBe(warning)
  view.unmount()
  render(<FontNotice {...props()} />)
  expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('has localized copy and does not reserve a notice for fonts that are available', () => {
  const view = render(<FontNotice {...props({ t: makeTranslate(zh) })} />)
  fireEvent.click(screen.getByRole('button', { name: makeTranslate(zh)('viewMissingFonts', { count: 2 }) }))
  expect(screen.getByRole('dialog', { name: zh.missingFontsTitle })).toBeDefined()
  view.rerender(<FontNotice {...props({ fonts: [] })} />)
  expect(view.container.childElementCount).toBe(0)
  expect(screen.queryByRole('dialog')).toBeNull()
})
