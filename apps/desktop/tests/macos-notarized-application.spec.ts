/** Verify application qualification commands without invoking Apple tools. */

import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { verifyMacOSNotarizedApplication } from '../scripts/verify-macos-signature.mjs'

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawnSync: vi.fn(),
}))

const expected = { signingIdentity: 'Example Company (TEAMID1234)', teamId: 'TEAMID1234' }
const appPath = '/private build/DeepSeek Harness.app'
const commands = [
  ['/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]],
  ['/usr/bin/codesign', ['--display', '--verbose=4', appPath]],
  ['/usr/bin/xcrun', ['stapler', 'validate', appPath]],
  ['/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath]],
] as const

afterEach(() => { vi.resetAllMocks() })

describe('notarized application qualification', () => {
  it.each([undefined, 0, 1, 2, 3])('stops at failed command %s or verifies every qualification', (failedCommand) => {
    let index = 0
    vi.mocked(spawnSync).mockImplementation(() => ({
      pid: 1,
      output: [],
      stdout: '',
      stderr: `Authority=Developer ID Application: ${expected.signingIdentity}\nTeamIdentifier=${expected.teamId}\n`,
      status: index++ === failedCommand ? 1 : 0,
      signal: null,
    }))
    if (failedCommand === undefined) {
      expect(() => { verifyMacOSNotarizedApplication(appPath, expected) }).not.toThrow()
    } else {
      expect(() => { verifyMacOSNotarizedApplication(appPath, expected) }).toThrow('exited with 1')
    }
    const calledCommands = commands.slice(0, failedCommand === undefined ? commands.length : failedCommand + 1)
    expect(spawnSync).toHaveBeenCalledTimes(calledCommands.length)
    for (const [index, [command, args]] of calledCommands.entries()) {
      expect(spawnSync).toHaveBeenNthCalledWith(index + 1, command, args, { encoding: 'utf8' })
    }
  })
})
