/** Startup diagnostics through the shipped headless profile and real MCP stdio transport. */

import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const fixtureRoot = new URL('../../../../../../packages/mcp/mcp-client/tests/fixtures/', import.meta.url)
const configPath = fileURLToPath(new URL('pagination-limit.patch.yml', fixtureRoot))
const headlessOverlayPath = fileURLToPath(new URL('./fixtures/headless-profile.patch.yml', import.meta.url))
const expectedPath = fileURLToPath(new URL('./expected/mcp-pagination/stderr-cause.txt', import.meta.url))

it('warns when MCP discovery exceeds the SDK page limit and completes the headless task', async () => {
  const { stdout, stderr } = await runLoaderSmoke({
    label: 'MCP discovery pagination limit',
    tempDirPrefix: 'dsh-mcp-pagination-',
    binScript: fileURLToPath(new URL('../../../../src/bin.ts', import.meta.url)),
    libBinScript: fileURLToPath(new URL('../../../../lib/bin.js', import.meta.url)),
    configPath,
    binArgs: [
      '--profile', 'headless',
      '--patch', headlessOverlayPath,
      '--patch', configPath,
      'Complete the task without the failed MCP server.',
    ],
    tsconfigPath: fileURLToPath(new URL('../../../../../../tsconfig.json', import.meta.url)),
    env: {
      DSH_MCP_PAGINATION_FIXTURE: fileURLToPath(new URL('pagination-limit-server.ts', fixtureRoot)),
      DSH_PERMISSION_MODE: 'danger-full-access',
      DSH_TELEMETRY_DISABLED: '1',
    },
  })
  expect(stdout).toBe('CLI tool round trip complete: CLI_TOOL_ROUND_TRIP\n')
  expect(stderr).toContain('dsh: warning: 1 entry did not activate')
  expect(stderr).toContain('mcp-pagination-limit (@deepseek-ai/dsh-mcp-client)')
  expect(stderr).toContain('initial connection or tool synchronization failed')
  const cause = stderr.split('\n').find(line => line.includes('exceeded listMaxPages'))
  await expect(`${cause}\n`).toMatchFileSnapshot(expectedPath)
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
