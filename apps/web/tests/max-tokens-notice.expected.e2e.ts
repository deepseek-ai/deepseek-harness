// @vitest-environment jsdom
// Assembled max-tokens snapshot: boots the real built `packages/client/*/lib/
// client.js` bundles through AppWebEntry's ModuleLoader path against the
// keyless RemoteMock transport, opens the fixture session, and pins the
// surface its max-tokens turn (72) reaches — the turn-end notice row that a
// provider output-cap truncation must render instead of ending silently.
//
// The dot state is pinned beside the copy on purpose: `dot=warning` is what
// distinguishes this notice from the error row, so a regression that routes
// max-tokens through the turn-error presentation changes this file even when
// its own copy still renders.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { hasClass, installAssembledBootEnv, mountAssembledApp, REFRESHING_GOLDEN } from './assembled-boot.ts'

const EXPECTED = join(process.cwd(), 'apps/web/tests/expected/max-tokens-notice/history-turn.expected.txt')

installAssembledBootEnv()

/** Normalize the notice row to stable fields: its dot state, title, and hint. */
function noticeShape(row: Element): string {
  const first = (name: string): string =>
    [...row.querySelectorAll('*')].filter(el => hasClass(el, name))[0]?.textContent?.trim() ?? '<absent>'
  return [
    `dot=${row.querySelector('[data-state]')?.getAttribute('data-state') ?? '<absent>'}`,
    `title=${first('maxTokensTitle')}`,
    `hint=${first('turnErrorMessage')}`,
  ].join('\n')
}

describe('assembled max-tokens turn-end notice', () => {
  it('renders the localized truncation notice after the cut-off answer instead of ending silently', async () => {
    mountAssembledApp()

    const tree = await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
    fireEvent.click(await within(tree).findByText('Fixture 历史会话'))
    // The truncated answer itself stays in the flow: the notice supplements the
    // partial output, it never replaces it.
    await screen.findByText(/条目 3：这一条写到一半被/, undefined, { timeout: 10_000 })
    const row = await waitFor(() => {
      const found = [...document.querySelectorAll('[role="status"]')]
        .find(candidate => [...candidate.querySelectorAll('*')].some(el => hasClass(el, 'maxTokensTitle')))
      expect(found).not.toBeUndefined()
      return found!
    }, { timeout: 10_000 })

    const shape = noticeShape(row)
    if (REFRESHING_GOLDEN) {
      mkdirSync(dirname(EXPECTED), { recursive: true })
      writeFileSync(EXPECTED, shape)
    }
    await expect(shape).toMatchFileSnapshot(EXPECTED)
  })
})
