// @vitest-environment jsdom
// Assembled search-card snapshot: boots the real built workspace client bundles
// through AppWebEntry's ModuleLoader path against the keyless
// RemoteMock transport (no API key, no model round), opens the fixture
// session, and pins the search card the `grep` turn (fixture turn 67) renders in
// the assembled application. The built-boot smoke proves the graph boots but
// intentionally carries no behavior assertions; this is the assembled-output check
// that a broken SearchRow registration or a dropped card would fail — the
// per-package suites bench over src and cannot see the bundled wiring.
//
// Keyless and deterministic: the fixture is the fake server, so the grep turn's
// matches, its truncation summary, and its head/tail cap are fixed in the
// fixture, not harvested from a live model. The recovery-footer arm is a pure
// derivation over the result view, pinned at every render site by the
// ui-conversation suite; here the fixture turn exercises the assembled card
// fields and its cap.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { hasClass, installAssembledBootEnv, mountAssembledApp, REFRESHING_GOLDEN } from './assembled-boot.ts'

const EXPECTED = join(process.cwd(), 'apps/web/tests/expected/search-card/grep-card.expected.txt')

installAssembledBootEnv()

/** Normalize a rendered search card to stable text fields: the kind, the banner
 *  summary, each file header (path + count), each visible match line, the expand
 *  control label, and the recovery footer. */
function cardShape(root: Element): string {
  const card = root.querySelector('[data-search]')
  if (card === null) return '<no search card>'
  const pick = (from: Element, name: string): Element[] =>
    [...from.querySelectorAll('*')].filter(el => hasClass(el, name))
  const lines: string[] = [`kind=${card.getAttribute('data-search')}`]
  const summary = pick(card, 'summary')[0]?.textContent?.trim()
  if (summary !== undefined && summary !== '') lines.push(`summary=${summary}`)
  for (const header of pick(card, 'fileHeader')) lines.push(`file=${header.textContent?.trim() ?? ''}`)
  for (const row of pick(card, 'line')) lines.push(`line=${row.textContent?.trim() ?? ''}`)
  const expand = pick(card, 'expand')[0]?.textContent?.trim()
  if (expand !== undefined && expand !== '') lines.push(`expand=${expand}`)
  const recovery = pick(root, 'searchRecovery')[0]?.textContent?.trim()
  if (recovery !== undefined && recovery !== '') lines.push(`recovery=${recovery}`)
  return lines.join('\n')
}

describe('assembled search card', () => {
  it('renders the grep card, its truncation summary, and its capped head/tail slice from the built bundles', async () => {
    mountAssembledApp()

    const tree = await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
    fireEvent.click(await within(tree).findByText('Fixture 历史会话'))
    // Wait for chat content to reach the fixture's later turns (the bash sample
    // is turn 66, the grep card turn 67).
    await waitFor(() => {
      expect(document.querySelector('[data-sample="bash"]')).not.toBeNull()
    }, { timeout: 10_000 })
    // The grep turn's keyed SearchRow composes ToolRow: the card is collapsed
    // by default, so wait for the summary row, then expand it to reach the card.
    await waitFor(() => {
      const tools = [...document.querySelectorAll('[data-tool]')].map(el => el.getAttribute('data-tool'))
      expect(tools, `tools present: ${tools.join(', ')}`).toContain('grep')
    }, { timeout: 10_000 })

    // `data-tool` sits on the ToolRow root; the collapsed row is the expand
    // toggle. Click it so the card and its recovery footer mount, then serialize the
    // whole row (the card lives inside ToolRow's body wrapper).
    const grepRow = document.querySelector('[data-tool="grep"]')!
    act(() => { fireEvent.click(grepRow.querySelector('[data-expandable]') ?? grepRow) })
    await waitFor(() => {
      expect(grepRow.querySelector('[data-search]')).not.toBeNull()
    }, { timeout: 10_000 })
    const shape = cardShape(grepRow)
    if (REFRESHING_GOLDEN) {
      mkdirSync(dirname(EXPECTED), { recursive: true })
      writeFileSync(EXPECTED, shape)
    }
    await expect(shape).toMatchFileSnapshot(EXPECTED)
  })
})
