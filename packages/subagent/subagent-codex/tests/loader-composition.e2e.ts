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
const configPath = join(fixtureDir, 'codex.patch.yml')
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

describe('Codex provider public Loader composition', () => {
  it('loads the configured default, two named instances, their tools, and job controls without starting Codex', async () => {
    const { stdout, stderr } = await runLoaderSmoke({
      label: 'subagent-codex Loader composition',
      tempDirPrefix: 'dsh-subagent-codex-loader-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      binArgs: [configPath],
      tsconfigPath: repoTsconfig,
      processTimeoutMs: PRODUCTION_PROFILE_PROCESS_TIMEOUT_MS,
      env: {
        // Loading the optional package must not probe or start a Codex binary.
        PATH: '',
      },
    })

    expect(stderr).toBe('')
    expect(JSON.parse(stdout)).toEqual({
      providers: ['codex', 'codex-primary', 'codex-secondary'],
      providerDetails: [
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
          name: 'codex-primary',
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
          name: 'codex-secondary',
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
          name: 'subagent_codex_primary',
          parameterNames: ['cwd', 'description', 'prompt'],
          required: ['description', 'prompt'],
        },
        {
          name: 'subagent_codex_secondary',
          parameterNames: ['cwd', 'description', 'prompt'],
          required: ['description', 'prompt'],
        },
      ],
      jobTools: ['job_kill', 'job_list', 'job_output'],
      starts: 0,
    })
  }, PRODUCTION_PROFILE_TEST_TIMEOUT_MS)
})
