/** Exercise developer signing tooling without reading or mutating real keychains. */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it.skipIf(process.platform === 'win32')('creates, reuses, and removes developer identities outside DSH home', () => {
  const output = execFileSync('python3', [fileURLToPath(new URL('../.agents/skills/dsh-cua-macos-signing/scripts/test_signing_identity.py', import.meta.url))], {
    encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
  })
  expect(output).toBe('')
})
