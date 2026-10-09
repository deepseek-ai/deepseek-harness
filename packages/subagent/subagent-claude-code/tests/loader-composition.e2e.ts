import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const PRODUCTION_PROFILE_PROCESS_TIMEOUT_MS = 60_000
const PRODUCTION_PROFILE_TEST_TIMEOUT_MS = PRODUCTION_PROFILE_PROCESS_TIMEOUT_MS + 15_000

const fixtureDir = fileURLToPath(new URL(
  './fixtures/loader/',
  import.meta.url,
))
const driver = join(fixtureDir, 'driver.ts')
const configPath = join(fixtureDir, 'claude-code.patch.yml')
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

describe('product-provider public Loader composition', () => {
  it('loads the configured default, two named Claude instances, their tools, and Codex without starting either product', async () => {
    const { stdout, stderr } = await runLoaderSmoke({
      label: 'product-provider Loader composition',
      tempDirPrefix: 'dsh-product-provider-loader-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      binArgs: [configPath],
      tsconfigPath: repoTsconfig,
      processTimeoutMs: PRODUCTION_PROFILE_PROCESS_TIMEOUT_MS,
      env: {
        // Loading the optional package must not probe or start a Claude binary.
        PATH: '',
      },
    })

    expect(stderr).toBe('')
    expect(JSON.parse(stdout)).toEqual({
      registeredProviders: ['claude-code', 'claude-primary', 'claude-secondary', 'codex'],
      providers: [
        {
          name: 'codex',
          capabilities: {
            agentOptions: false,
            outputSchema: false,
            depthLimit: false,
            toolFilter: false,
            persona: false,
          },
          inheritsParentContext: false,
        },
        {
          name: 'claude-code',
          capabilities: {
            agentOptions: false,
            outputSchema: false,
            depthLimit: false,
            toolFilter: false,
            persona: false,
          },
          inheritsParentContext: false,
        },
        {
          name: 'claude-primary',
          capabilities: {
            agentOptions: false,
            outputSchema: false,
            depthLimit: false,
            toolFilter: false,
            persona: false,
          },
          inheritsParentContext: false,
        },
        {
          name: 'claude-secondary',
          capabilities: {
            agentOptions: false,
            outputSchema: false,
            depthLimit: false,
            toolFilter: false,
            persona: false,
          },
          inheritsParentContext: false,
        },
      ],
      tools: [
        {
          name: 'subagent_codex',
          parameterNames: ['cwd', 'description', 'prompt'],
          required: ['description', 'prompt'],
        },
        {
          name: 'subagent_claude_code',
          parameterNames: ['cwd', 'description', 'prompt'],
          required: ['description', 'prompt'],
        },
        {
          name: 'subagent_claude_primary',
          parameterNames: ['cwd', 'description', 'prompt'],
          required: ['description', 'prompt'],
        },
        {
          name: 'subagent_claude_secondary',
          parameterNames: ['cwd', 'description', 'prompt'],
          required: ['description', 'prompt'],
        },
      ],
      jobTools: ['job_kill', 'job_list', 'job_output'],
      starts: 0,
    })
  }, PRODUCTION_PROFILE_TEST_TIMEOUT_MS)
})
