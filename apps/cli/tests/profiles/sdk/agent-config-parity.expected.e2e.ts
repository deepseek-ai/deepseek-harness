/**
 * Static comparison of the agent-plane plugin rows of the shipped SDK profile and each Desktop agent preset, read from
 * `dsh --dump-config` without booting. It covers rows whose model effect a default turn does not show, such as the
 * plan mode section. Only rows a Desktop preset declares are compared; the remaining rows are the Desktop host plane.
 * Record differences in parity-exceptions.ts.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { expect, it, type TestContext } from 'vitest'
import { parseEntryYaml } from '@deepseek-ai/cordis-plugin-include'
import { profileEnvironment } from './fixtures/profile-environment.ts'
import { assertParity, compareEntries, type ParityDifference, type ParityMode } from './parity.ts'

const repo = fileURLToPath(new URL('../../../../../', import.meta.url))
const ptcOverlay = join(repo, 'apps/cli/config/examples/ptc.yml')
const PRESET = '@deepseek-ai/dsh-agent-preset'
const GROUP = 'cordis:group'

interface Row { id?: string; name?: string; disabled?: unknown; config?: unknown }

/** Leaf rows by id; group rows contribute their members, and an absent `disabled` reads as `false`. */
function leaves(rows: readonly Row[], into = new Map<string, unknown>()): Map<string, unknown> {
  for (const row of rows) {
    if (row.name === GROUP && Array.isArray(row.config)) leaves(row.config as Row[], into)
    else if (row.id !== undefined) into.set(row.id, { name: row.name, disabled: row.disabled ?? false, config: row.config })
  }
  return into
}

function presetRows(rows: readonly Row[], mode: ParityMode): Map<string, unknown> {
  const preset = rows.find(row => row.name === PRESET && (row.config as { id?: string } | undefined)?.id === mode)
  if (preset === undefined) throw new Error(`Desktop profile has no ${mode} agent preset`)
  return leaves((preset.config as { plugins: Row[] }).plugins)
}

/**
 * The SDK rows with the ids a preset declares. A preset `persona` row and the SDK `system-prompt.personaPrefix`
 * render the same persona section, so the SDK prefix compares as that row.
 */
function sdkRows(rows: readonly Row[], ids: Iterable<string>): Map<string, unknown> {
  const all = leaves(rows)
  const prefix = (all.get('system-prompt') as { config?: { personaPrefix?: unknown } } | undefined)?.config?.personaPrefix
  if (prefix !== undefined) all.set('persona', { name: '@deepseek-ai/dsh-persona', disabled: false, config: { prefix } })
  return new Map([...ids].filter(id => all.has(id)).map(id => [id, all.get(id)]))
}

async function fixture(test: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'sdk-desktop-config-'))
  test.onTestFinished(() => rm(root, { recursive: true, force: true }))
  const env = profileEnvironment(root, 'http://127.0.0.1:9')
  /** Desktop composes the Web template's bundles, and the dump leaves `!!js` unevaluated, so `web` dumps Desktop's rows. */
  async function dump(profile: 'sdk' | 'web', patches: object[] = [], overlays: string[] = []): Promise<Row[]> {
    const home = await mkdtemp(join(root, `${profile}-`))
    const patch = join(home, 'mutation.patch.yml')
    await writeFile(patch, JSON.stringify(patches))
    const result = await execa(process.execPath, [join(repo, 'apps/cli/lib/bin.js'), '--profile', profile, '--dump-config',
      ...[...overlays, patch].flatMap(file => ['--patch', file])], {
      cwd: home, env: { ...env, DSH_HOME: home }, extendEnv: false, cancelSignal: test.signal,
    })
    return parseEntryYaml(result.stdout) as Row[]
  }
  return async (mode: ParityMode, sdkPatches: object[] = []): Promise<ParityDifference[]> => {
    const desktop = presetRows(await dump('web'), mode)
    const sdk = sdkRows(await dump('sdk', sdkPatches, mode === 'ptc' ? [ptcOverlay] : []), desktop.keys())
    return compareEntries('config', 'config', sdk, desktop)
  }
}

it.for(['standard', 'ptc'] as const)('compares the SDK agent rows with the Desktop %s preset', async (mode, test) => {
  const differences = await fixture(test)
  assertParity(mode, ['config'], await differences(mode))
})

it.for(['standard', 'ptc'] as const)('detects a one-sided agent row change in %s', async (mode, test) => {
  const differences = await fixture(test)
  const changed = await differences(mode, [{ id: 'tool-todo', config: { allowParallelInProgress: false } }])
  expect(() => { assertParity(mode, ['config'], changed) }).toThrow('config tool-todo:/config/allowParallelInProgress (differs)')
})
