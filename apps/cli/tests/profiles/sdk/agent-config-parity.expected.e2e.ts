/**
 * Static comparison of the plugin rows of the shipped SDK profile with the Desktop standard composition, read from
 * `dsh --dump-config` without booting. It covers rows whose model effect a default turn does not show, such as the
 * plan mode section. An SDK row compares with the standard agent preset row of the same id, or else with the Desktop
 * host row of that id; an enabled SDK row with neither is SDK-only. Desktop host rows the SDK lacks are not compared.
 * Record differences in parity-exceptions.ts.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { expect, it, type TestContext } from 'vitest'
import { parseEntryYaml, stringifyEntryYaml } from '@deepseek-ai/cordis-plugin-include'
import { profileEnvironment } from './fixtures/profile-environment.ts'
import { assertParity, compareEntries, type ParityDifference } from './parity.ts'

const repo = fileURLToPath(new URL('../../../../../', import.meta.url))
const PRESET = '@deepseek-ai/dsh-agent-preset'
const GROUP = 'cordis:group'

interface Row { id?: string; name?: string; disabled?: unknown; config?: unknown }

/** Replace each unevaluated `!!js` node with `!!js <source>`, so a differing expression reports at its own field. */
function literal(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(literal)
  if (value === null || typeof value !== 'object') return value
  const entries = Object.entries(value)
  if (entries.length === 1 && entries[0]![0] === '__jsExpr') return `!!js ${String(entries[0]![1])}`
  return Object.fromEntries(entries.map(([key, item]) => [key, literal(item)]))
}

/**
 * Combine the `disabled` of an enclosing group with a member's own. A disabled group disables every member; an
 * expression on the group is recorded beside the member's value, since either one disables it.
 * @param group - the enclosing groups' combined value; `false` outside any group.
 * @param row - the member's own value, `false` when absent.
 * @returns `true`, the member's value, or both conditions.
 */
function combineDisabled(group: unknown, row: unknown): unknown {
  if (group === false || row === true) return row
  if (group === true || row === false) return group
  return { group, row }
}

/**
 * Leaf rows by id; group rows contribute their members with the group's `disabled` combined into each, and an absent
 * `disabled` reads as `false`.
 */
function leaves(rows: readonly Row[], into = new Map<string, unknown>(), group: unknown = false): Map<string, unknown> {
  for (const row of rows) {
    const disabled = combineDisabled(group, row.disabled ?? false)
    if (row.name === GROUP && Array.isArray(row.config)) leaves(row.config as Row[], into, disabled)
    else if (row.id !== undefined) into.set(row.id, literal({ name: row.name, disabled, config: row.config }))
  }
  return into
}

function standardPreset(rows: readonly Row[]): Row & { config: { plugins: Row[] } } {
  const preset = rows.find(row => row.name === PRESET && (row.config as { id?: string } | undefined)?.id === 'standard')
  if (preset === undefined) throw new Error('Desktop profile has no standard agent preset')
  return preset as Row & { config: { plugins: Row[] } }
}

function presetRows(rows: readonly Row[]): Map<string, unknown> {
  return leaves(standardPreset(rows).config.plugins)
}

/**
 * The SDK rows by id. A preset `persona` row and the SDK `system-prompt.personaPrefix` render the same persona section,
 * so the SDK prefix also compares as that row.
 */
function sdkRows(rows: readonly Row[]): Map<string, unknown> {
  const all = leaves(rows)
  const prefix = (all.get('system-prompt') as { config?: { personaPrefix?: unknown } } | undefined)?.config?.personaPrefix
  if (prefix !== undefined) all.set('persona', { name: '@deepseek-ai/dsh-persona', disabled: false, config: { prefix } })
  return all
}

/**
 * Pair each SDK row with the Desktop row it is compared against: the standard preset row of its id, else the Desktop
 * host row of its id. A disabled SDK row with neither counterpart is absent on both sides.
 * @param sdk - SDK rows by id.
 * @param web - the Desktop (`web`) composition rows.
 * @returns the SDK and Desktop sides of one entry table each.
 */
function pairRows(sdk: ReadonlyMap<string, unknown>, web: readonly Row[]): [Map<string, unknown>, Map<string, unknown>] {
  const preset = presetRows(web)
  const host = leaves(web)
  const desktop = new Map(preset)
  const compared = new Map<string, unknown>()
  for (const id of preset.keys()) if (sdk.has(id)) compared.set(id, sdk.get(id))
  for (const [id, row] of sdk) {
    if (preset.has(id)) continue
    if (host.has(id)) {
      compared.set(id, row)
      desktop.set(id, host.get(id))
    } else if ((row as { disabled: unknown }).disabled !== true) compared.set(id, row)
  }
  return [compared, desktop]
}

async function fixture(test: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'sdk-desktop-config-'))
  test.onTestFinished(() => rm(root, { recursive: true, force: true }))
  const env = profileEnvironment(root, 'http://127.0.0.1:9')
  /** Desktop composes the Web template's bundles, and the dump leaves `!!js` unevaluated, so `web` dumps Desktop's rows. */
  async function dump(profile: 'sdk' | 'web', patches: readonly Row[] | readonly object[] = []): Promise<Row[]> {
    const home = await mkdtemp(join(root, `${profile}-`))
    const patch = join(home, 'mutation.patch.yml')
    await writeFile(patch, stringifyEntryYaml(patches))
    const result = await execa(process.execPath, [join(repo, 'apps/cli/lib/bin.js'), '--profile', profile, '--dump-config',
      '--patch', patch], {
      cwd: home, env: { ...env, DSH_HOME: home }, extendEnv: false, cancelSignal: test.signal,
    })
    return parseEntryYaml(result.stdout) as Row[]
  }
  /**
   * @param sdkPatches - overlay rows for the SDK side.
   * @param editDesktop - rewrites the Desktop rows before comparison, expressed as a profile patch so Loader semantics apply.
   */
  return async (sdkPatches: object[] = [], editDesktop?: (rows: readonly Row[]) => Row[]): Promise<ParityDifference[]> => {
    const web = await dump('web')
    const desktop = editDesktop === undefined ? web : await dump('web', editDesktop(web))
    const [sdk, desktopRows] = pairRows(sdkRows(await dump('sdk', sdkPatches)), desktop)
    return compareEntries('config', 'config', sdk, desktopRows)
  }
}

it('compares the SDK rows with the Desktop standard composition', async (test) => {
  const differences = await fixture(test)
  assertParity(['config'], await differences())
})

it('detects a one-sided agent row change', async (test) => {
  const differences = await fixture(test)
  const changed = await differences([{ id: 'tool-todo', config: { allowParallelInProgress: false } }])
  expect(() => { assertParity(['config'], changed) }).toThrow('config tool-todo:/config/allowParallelInProgress (differs)')
})

it('reads the members of a disabled preset group as disabled', async (test) => {
  const differences = await fixture(test)
  const changed = await differences([], (rows) => {
    const preset = structuredClone(standardPreset(rows))
    const planning = preset.config.plugins.find(row => row.id === 'planning')
    if (planning === undefined) throw new Error('Desktop standard preset has no planning group')
    planning.disabled = true
    return [preset]
  })
  expect(() => { assertParity(['config'], changed) }).toThrow('config plan-mode:/disabled (differs)')
})

it('detects SDK rows outside the preset: a host row change and an SDK-only row', async (test) => {
  const differences = await fixture(test)
  const changed = await differences([
    { id: 'repeat-tool-reminder', config: { thresholds: [3, 5, 9], exclude: ['todo_write', 'team_task_update', 'update_goal'], restartCountAfter: ['wait_agent', 'job_output', 'ask_user_question'], argumentsPreviewChars: 500 } },
    { insert: [{ id: 'parity-sdk-only', name: '@deepseek-ai/dsh-tool-present' }] },
  ])
  expect(() => { assertParity(['config'], changed) }).toThrow('config repeat-tool-reminder:/config/thresholds/2 (differs)')
  expect(() => { assertParity(['config'], changed) }).toThrow('config parity-sdk-only (sdk only)')
})
