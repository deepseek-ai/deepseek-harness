import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const driver = fileURLToPath(new URL('./fixtures/loader/driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/loader/composition.patch.yml', import.meta.url))

it('composes OAR providers and their tool through Loader without probing or starting installed agents', { timeout: 75_000, retry: 0 }, async () => {
  const { stdout, stderr } = await runLoaderSmoke({
    label: 'experimental OAR provider and tool Loader composition',
    tempDirPrefix: 'dsh-oar-loader-',
    binScript: driver,
    libBinScript: driver,
    configPath,
    tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)),
    processTimeoutMs: 60_000,
    env: {
      PATH: '',
      OAR_CODEX_BIN: '/missing-oar-loader-codex',
      OAR_CLAUDE_BIN: '/missing-oar-loader-claude',
    },
  })
  expect(stderr).toBe('')
  const capabilities = { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false }
  expect(JSON.parse(stdout)).toEqual({
    providers: ['oar-codex', 'oar-claude'].map(name => ({ name, capabilities, inheritsParentContext: false })),
    tools: [{ name: 'subagent_oar', required: ['runtime', 'description', 'prompt'] }],
    starts: 0,
  })
})
