// @vitest-environment jsdom
/** The band draws a serialized mod tree and sends a button press to the Host with the generation it saw. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SurfaceSnapshot } from '@deepseek-ai/dsh-experimental-claude-code-mods/types'
import { afterEach, expect, it, vi } from 'vitest'
import { Band, type BandProps } from '../src/client/Band.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const WEATHER: SurfaceSnapshot = {
  generation: 3,
  tree: [{
    type: 'Box',
    props: { flexDirection: 'row', paddingX: 1, gap: 1 },
    children: [
      { type: 'Text', props: { color: 'yellow', bold: true }, children: ['☀  Clear'] },
      { type: 'Text', props: {}, children: ['  18% of context'] },
      { type: 'Text', props: { dimColor: true, italic: true, underline: true }, children: ['  36k / 200k'] },
      'plain tail',
    ],
  }],
}

const HOLD: SurfaceSnapshot = {
  generation: 4,
  tree: [{
    type: 'Box',
    props: { flexDirection: 'column', border: true, borderColor: 'yellow', padding: 1 },
    children: [
      { type: 'Text', props: { color: 'nonsense' }, children: ['Blast Radius: rm -rf build'] },
      { type: 'Text', props: { color: 'grey' }, children: ['grey text'] },
      {
        type: 'Box',
        props: { flexDirection: 'row' },
        children: [
          { type: 'Button', props: { label: 'Proceed', hotkey: '1' }, children: [], actionId: 'a0' },
          { type: 'Button', props: { label: 'Cancel', hotkey: '2' }, children: [], actionId: 'a1' },
          { type: 'Button', props: { label: 'Inert' }, children: [] },
          { type: 'Button', props: { label: 'Off', disabled: true }, children: [], actionId: 'a2' },
        ],
      },
    ],
  }],
}

function fixture(initial: SurfaceSnapshot | undefined) {
  const state = createSnapshotStore<SurfaceSnapshot | undefined>(initial)
  const press = vi.fn<(generation: number, actionId: string) => Promise<void>>(() => Promise.resolve())
  const props = { t: makeTranslate(zh), press, useBand: bindSnapshotSelector(state) } as BandProps
  render(<Band {...props} />)
  return { press, publish(next: SurfaceSnapshot | undefined) { act(() => { state.set(next) }) } }
}

it('draws nothing without a tree, then the tree as the Host serialized it', () => {
  const b = fixture(undefined)
  expect(screen.queryByRole('group')).toBeNull()
  b.publish({ generation: 1, tree: null })
  expect(screen.queryByRole('group')).toBeNull()
  b.publish(WEATHER)
  const band = screen.getByRole('group', { name: zh.band })
  expect(band.getAttribute('data-generation')).toBe('3')
  expect(band.textContent).toBe('☀  Clear  18% of context  36k / 200kplain tail')
  expect(screen.getByText(/Clear/).getAttribute('data-color')).toBe('yellow')
  expect(screen.getByText(/Clear/).getAttribute('data-bold')).toBe('true')
  const dim = screen.getByText(/36k/)
  expect([dim.getAttribute('data-dim'), dim.getAttribute('data-italic'), dim.getAttribute('data-underline')]).toEqual(['true', 'true', 'true'])
  expect(dim.getAttribute('data-color')).toBeNull()
  const row = band.firstElementChild?.firstElementChild as HTMLElement
  expect(row.getAttribute('data-direction')).toBe('row')
  expect(row.style.paddingLeft).toBe('4px')
  expect(row.style.gap).toBe('4px')
})

it('presses a button with the generation it was drawn in and shows the failure of a refused press', async () => {
  const b = fixture(HOLD)
  const box = screen.getByText(/Blast Radius/).parentElement as HTMLElement
  expect([box.getAttribute('data-direction'), box.getAttribute('data-border'), box.getAttribute('data-color')]).toEqual(['column', 'true', 'yellow'])
  expect(box.style.paddingTop).toBe('4px')
  expect(screen.getByText(/Blast Radius/).getAttribute('data-color')).toBeNull()
  expect(screen.getByText('grey text').getAttribute('data-color')).toBe('gray')
  const proceed = screen.getByRole('button', { name: /Proceed/ })
  expect(proceed.textContent).toBe('Proceed[1]')
  const inert = screen.getByRole('button', { name: 'Inert' })
  const off = screen.getByRole('button', { name: 'Off' })
  expect((inert as HTMLButtonElement).disabled).toBe(true)
  expect((off as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(proceed)
  expect(b.press).toHaveBeenCalledWith(4, 'a0')
  await act(async () => { await Promise.resolve() })
  expect(screen.queryByRole('status')).toBeNull()

  b.press.mockImplementationOnce(() => Promise.reject(new Error('gone')))
  fireEvent.click(screen.getByRole('button', { name: /Cancel/ }))
  await act(async () => { await Promise.resolve() })
  expect(screen.getByRole('status').textContent).toBe('按钮操作失败：gone')

  // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- a press rejected with a bare value is the scenario.
  b.press.mockImplementationOnce(() => Promise.reject('text failure'))
  fireEvent.click(screen.getByRole('button', { name: /Cancel/ }))
  await act(async () => { await Promise.resolve() })
  expect(screen.getByRole('status').textContent).toBe('按钮操作失败：text failure')
})

it('disables every button while a press is in flight', async () => {
  const b = fixture(HOLD)
  let settle: (() => void) | undefined
  b.press.mockImplementationOnce(() => new Promise<void>((resolve) => { settle = resolve }))
  fireEvent.click(screen.getByRole('button', { name: /Proceed/ }))
  expect(screen.getByRole<HTMLButtonElement>('button', { name: /Cancel/ }).disabled).toBe(true)
  expect(screen.getByRole('button', { name: /Proceed/ }).getAttribute('aria-busy')).toBe('true')
  await act(async () => { settle?.(); await Promise.resolve() })
  expect(screen.getByRole<HTMLButtonElement>('button', { name: /Cancel/ }).disabled).toBe(false)
})
