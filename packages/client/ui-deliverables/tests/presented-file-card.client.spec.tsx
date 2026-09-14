// @vitest-environment jsdom
/** Explicit file actions preserve their destination, availability, and independent failure state. */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { PresentedFileCard } from '../src/client/PresentedFileCard.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)
const props = () => ({
  cwd: undefined,
  file: { path: 'out/report.pdf', description: 'Final report', seq: 4, index: 1 },
  host: { name: 'remote-desktop', available: true, fileManager: 'finder' as const },
  phase: undefined,
  onPreview: vi.fn(),
  onAction: vi.fn(),
  t: makeTranslate(en),
})

it.each([
  ['finder', 'Show in Finder'], ['explorer', 'Show in File Explorer'], ['directory', 'Open containing folder'],
] as const)('uses the Host %s action and closes the menu after selection', (fileManager, label) => {
  const p = props()
  const view = render(<PresentedFileCard {...p} host={{ ...p.host, fileManager }} />)
  fireEvent.click(view.getByRole('button', { name: 'More file actions for out/report.pdf' }))
  fireEvent.click(view.getByRole('menuitem', { name: new RegExp(label) }))
  expect(p.onAction).toHaveBeenCalledWith('reveal')
  expect(view.queryByRole('menu')).toBeNull()
  fireEvent.click(view.getByRole('button', { name: 'More file actions for out/report.pdf' }))
  fireEvent.click(view.getByRole('menuitem', { name: /Open in default app/ }))
  expect(p.onAction).toHaveBeenLastCalledWith('open')
  expect(p.onAction).toHaveBeenCalledTimes(2)
})

it('dismisses the menu with Escape or an outside click without launching anything', () => {
  const p = props()
  const view = render(<PresentedFileCard {...p} />)
  const trigger = view.getByRole('button', { name: 'More file actions for out/report.pdf' })
  fireEvent.click(trigger)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(view.queryByRole('menu')).toBeNull()
  fireEvent.click(trigger)
  fireEvent.pointerDown(document.body)
  expect(view.queryByRole('menu')).toBeNull()
  expect(p.onAction).not.toHaveBeenCalled()
})

it.each(['opening', 'revealing'] as const)('keeps sidebar previews available while the native action is %s', (phase) => {
  const p = props()
  const view = render(<PresentedFileCard {...p} phase={phase} />)
  expect((view.getByRole('button', { name: 'More file actions for out/report.pdf' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(view.getByRole('button', { name: 'Preview out/report.pdf in sidebar' }))
  fireEvent.click(view.getByRole('button', { name: 'Open out/report.pdf in sidebar' }))
  expect(p.onPreview).toHaveBeenCalledTimes(2)
  expect(p.onAction).not.toHaveBeenCalled()
})

it('keeps the native menu disabled until a desktop is available', () => {
  const p = props()
  const view = render(<PresentedFileCard {...p} host={null} />)
  expect((view.getByRole('button', { name: 'More file actions for out/report.pdf' }) as HTMLButtonElement).disabled).toBe(true)
  expect((view.getByRole('button', { name: 'Open out/report.pdf in sidebar' }) as HTMLButtonElement).disabled).toBe(false)
  view.rerender(<PresentedFileCard {...p} host={{ ...p.host, available: false, fileManager: null }} />)
  expect((view.getByRole('button', { name: 'More file actions for out/report.pdf' }) as HTMLButtonElement).disabled).toBe(true)
})

it('opens the right sidebar from either the card or its primary button', () => {
  const p = props()
  const view = render(<PresentedFileCard {...p} />)
  fireEvent.click(view.getByRole('button', { name: 'Preview out/report.pdf in sidebar' }))
  fireEvent.click(view.getByRole('button', { name: 'Open out/report.pdf in sidebar' }))
  expect(p.onPreview).toHaveBeenCalledTimes(2)
  expect(p.onAction).not.toHaveBeenCalled()
})

it('localizes reveal failures and accurately reports a directory-only action', () => {
  const p = props()
  const view = render(<PresentedFileCard {...p} phase="revealError" t={makeTranslate(zh)} />)
  expect(view.getByText(zh['presented.revealError'])).toBeTruthy()
  view.rerender(<PresentedFileCard {...p} phase="revealed" host={{ ...p.host, fileManager: 'directory' }} />)
  expect(view.getByText(en['presented.directoryOpened'])).toBeTruthy()
  view.rerender(<PresentedFileCard {...p} phase="revealed" />)
  expect(view.getByText(en['presented.revealed'])).toBeTruthy()
})


it('supports keyboard selection and returns focus to the trigger on Escape', () => {
  const view = render(<PresentedFileCard {...props()} />)
  const trigger = view.getByRole('button', { name: 'More file actions for out/report.pdf' })
  fireEvent.click(trigger)
  const items = view.getAllByRole('menuitem')
  expect(document.activeElement).toBe(items[0])
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
  expect(document.activeElement).toBe(items[1])
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
  expect(document.activeElement).toBe(items[0])
  fireEvent.keyDown(document.activeElement!, { key: 'End' })
  expect(document.activeElement).toBe(items[1])
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
  expect(document.activeElement).toBe(items[0])
  fireEvent.keyDown(document.activeElement!, { key: 'Home' })
  expect(document.activeElement).toBe(items[0])
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  expect(document.activeElement).toBe(trigger)
})


it('shows the basename while retaining the full location for hover and actions', () => {
  const p = props()
  const path = '/work/reports/result.pdf'
  const view = render(<PresentedFileCard {...p} cwd="/work" file={{ ...p.file, path }} />)
  expect(view.getByTitle(path)).toBeTruthy()
  expect(view.getByText('result.pdf')).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: `More file actions for ${path}` }))
  fireEvent.click(view.getByRole('menuitem', { name: 'Open in default app' }))
  expect(p.onAction).toHaveBeenCalledWith('open')
  view.rerender(<PresentedFileCard {...p} cwd="/work" />)
  expect(view.getByTitle('/work/out/report.pdf')).toBeTruthy()
  expect(view.getByText('report.pdf')).toBeTruthy()
})

it.each([
  ['Quarterly summary (.pdf)', 'Quarterly summary'],
  ['季度总结（PDF）', '季度总结'],
] as const)('omits a trailing parenthesized file suffix from %s', (description, expected) => {
  const p = props()
  const view = render(<PresentedFileCard {...p} file={{ ...p.file, description }} />)
  expect(view.getByText(expected)).toBeTruthy()
  expect(view.queryByText(description)).toBeNull()
})


it('does not reopen a menu after a shared native request settles', () => {
  const p = props()
  const view = render(<PresentedFileCard {...p} />)
  fireEvent.click(view.getByRole('button', { name: 'More file actions for out/report.pdf' }))
  expect(view.getByRole('menu')).toBeTruthy()
  view.rerender(<PresentedFileCard {...p} phase="opening" />)
  expect(view.queryByRole('menu')).toBeNull()
  view.rerender(<PresentedFileCard {...p} phase="opened" />)
  expect(view.queryByRole('menu')).toBeNull()
})

it('keeps focus on the available preview button after selecting a native action', () => {
  const p = props()
  const view = render(<PresentedFileCard {...p} />)
  fireEvent.click(view.getByRole('button', { name: 'More file actions for out/report.pdf' }))
  const item = view.getByRole('menuitem', { name: 'Show in Finder' })
  item.focus()
  fireEvent.click(item)
  view.rerender(<PresentedFileCard {...p} phase="revealing" />)
  const preview = view.getByRole('button', { name: 'Open out/report.pdf in sidebar' })
  expect(document.activeElement).toBe(preview)
  view.rerender(<PresentedFileCard {...p} phase="revealed" />)
  expect(document.activeElement).toBe(preview)
})

it.each([en, zh])('distinguishes directory-only progress and errors in each locale', (dictionary) => {
  const p = { ...props(), t: makeTranslate(dictionary) }
  const view = render(<PresentedFileCard {...p} phase="revealing" />)
  expect(view.getByText(dictionary['presented.revealing'])).toBeTruthy()
  view.rerender(<PresentedFileCard {...p} phase="revealing" host={{ ...p.host, fileManager: 'directory' }} />)
  expect(view.getByText(dictionary['presented.directoryOpening'])).toBeTruthy()
  view.rerender(<PresentedFileCard {...p} phase="revealError" host={{ ...p.host, fileManager: 'directory' }} />)
  expect(view.getByText(dictionary['presented.directoryError'])).toBeTruthy()
})
