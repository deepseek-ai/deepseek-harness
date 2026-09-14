// @vitest-environment jsdom
// Assembled todo snapshot: boots the real built `packages/client/*/lib/
// client.js` bundles through AppWebEntry's ModuleLoader path against the
// keyless RemoteMock transport, opens the fixture session, and pins the
// two surfaces the fixture's parallel plan (turn 74, two items `in_progress`)
// reaches — the `todo_write` tool row and the dock's plan strip.
//
// The row is pinned as three separate fields on purpose. `summary=` is the
// ellipsized text and `suffix=` is ToolRow's non-shrinking `summarySuffix`
// slot, so a regression that folds the `+N` count back into the summary string
// changes this file even though the concatenated text would read the same; the
// jsdom package suites bench over src and cannot see the bundled registration.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { hasClass, installAssembledBootEnv, mountAssembledApp, REFRESHING_GOLDEN } from './assembled-boot.ts'

const EXPECTED = join(process.cwd(), 'apps/web/tests/expected/todo-row/parallel-plan.expected.txt')

installAssembledBootEnv()

/** Normalize the todo row and the plan strip to stable text fields: the row's
 *  title, its truncatable summary, its non-shrinking suffix, then the panel's
 *  per-status header and every list item with its status. */
function todoShape(row: Element, panel: Element): string {
  const pick = (from: Element, name: string): Element[] =>
    [...from.querySelectorAll('*')].filter(el => hasClass(el, name))
  const first = (from: Element, name: string): string =>
    pick(from, name)[0]?.textContent?.trim() ?? '<absent>'
  const items = [...panel.querySelectorAll('[data-status]')]
    .map(item => `item=${item.getAttribute('data-status')} ${item.textContent?.trim() ?? ''}`)
  return [
    `row=${row.getAttribute('data-tool')}`,
    `title=${first(row, 'title')}`,
    `summary=${first(row, 'summary')}`,
    `suffix=${first(row, 'summarySuffix')}`,
    `panel=${first(panel, 'progress')}`,
    ...items,
  ].join('\n')
}

describe('assembled todo surfaces', () => {
  it('renders the parallel plan as a row summary, a separate active count, and the dock plan strip', async () => {
    mountAssembledApp()

    const tree = await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
    fireEvent.click(await within(tree).findByText('Fixture 历史会话'))
    // The todo turn is the fixture's last, so wait for its keyed row rather
    // than for chat content in general.
    const row = await waitFor(() => {
      const found = document.querySelector('[data-tool="todo_write"]')
      expect(found).not.toBeNull()
      return found!
    }, { timeout: 10_000 })
    // The panel is the standing plan the turn's `todo/write` event feeds; it
    // mounts above the composer, outside the row, and starts collapsed — its
    // list only exists once expanded.
    const panel = await screen.findByTestId('todo-panel', undefined, { timeout: 10_000 })
    const toggle = panel.querySelector('button[aria-expanded]')
    if (toggle === null) throw new Error('the plan strip must expose its expand toggle')
    if (toggle.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle)

    const shape = todoShape(row, panel)
    if (REFRESHING_GOLDEN) {
      mkdirSync(dirname(EXPECTED), { recursive: true })
      writeFileSync(EXPECTED, shape)
    }
    await expect(shape).toMatchFileSnapshot(EXPECTED)
  })
})
