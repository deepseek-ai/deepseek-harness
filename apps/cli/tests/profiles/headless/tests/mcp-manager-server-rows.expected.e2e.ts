/** MCP manager server rows beside its `servers` dictionary, through the shipped headless profile and the package's `./server` entry. */

import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const configPath = fileURLToPath(new URL('../../../../../../packages/mcp/mcp-manager/tests/fixtures/server-rows.patch.yml', import.meta.url))
const headlessOverlayPath = fileURLToPath(new URL('./fixtures/headless-profile.patch.yml', import.meta.url))

it('reports each refused MCP server row alone and completes the headless task', async () => {
  const { stdout, stderr } = await runLoaderSmoke({
    label: 'MCP manager server rows',
    tempDirPrefix: 'dsh-mcp-manager-server-rows-',
    binScript: fileURLToPath(new URL('../../../../src/bin.ts', import.meta.url)),
    libBinScript: fileURLToPath(new URL('../../../../lib/bin.js', import.meta.url)),
    configPath,
    binArgs: [
      '--profile', 'headless',
      '--patch', headlessOverlayPath,
      '--patch', configPath,
      'Complete the task without the refused MCP server rows.',
    ],
    tsconfigPath: fileURLToPath(new URL('../../../../../../tsconfig.json', import.meta.url)),
    env: {
      DSH_PERMISSION_MODE: 'danger-full-access',
      DSH_TELEMETRY_DISABLED: '1',
    },
  })
  expect(stdout).toBe('CLI tool round trip complete: CLI_TOOL_ROUND_TRIP\n')
  // The manager with its dictionary entry and the valid `silent` row activate, so the warning counts only the three refused rows.
  expect(stderr).toContain('dsh: warning: 3 entries did not activate')
  expect(stderr).toContain('mcp-server-incomplete (@deepseek-ai/dsh-mcp-manager/server)')
  expect(stderr).toContain('servers.incomplete: a stdio server requires "command"')
  expect(stderr).toContain('mcp-server-copied (@deepseek-ai/dsh-mcp-manager/server)')
  expect(stderr).toContain('$.enabled expected nullable but got false')
  expect(stderr).toContain('mcp-server-listed (@deepseek-ai/dsh-mcp-manager/server)')
  expect(stderr).toContain('mcp-manager: server "listed" is already configured or registered')
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
