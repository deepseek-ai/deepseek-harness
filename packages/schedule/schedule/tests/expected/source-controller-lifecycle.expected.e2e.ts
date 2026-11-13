/** Real Loader, Session Controller, and JSONL create overlap with provider shutdown. */
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import {
  LOADER_SMOKE_TEST_TIMEOUT_MS, resolveExampleLaunch, resolveExampleMode, runLoaderSmoke,
  type ExampleMode, type LoaderSmokeOptions,
} from '@deepseek-ai/dsh-loader-smoke'

const fixture = new URL('../fixtures/source-controller-lifecycle/', import.meta.url)
const driver = fileURLToPath(new URL('driver.ts', fixture))
const root = new URL('../../../../../', import.meta.url)
const scheduleProvider = fileURLToPath(new URL('../source/schedule-provider.ts', fixture))
const resolverModules = fileURLToPath(new URL('../../node_modules', import.meta.url))
const scenarios = [
  ['new_once', 'before', 'keep'], ['new_once', 'before', 'dispose'],
  ['new_once', 'after', 'keep'], ['new_once', 'after', 'dispose'],
  ['new', 'before', 'keep'], ['new', 'before', 'dispose'],
  ['new', 'after', 'keep'], ['new', 'after', 'dispose'],
] as const

function smokeOptions(
  [kind, phase, disposition]: (typeof scenarios)[number], mode: ExampleMode,
): LoaderSmokeOptions {
  return {
    label: `Source Controller ${kind}/${phase}/${disposition}`,
    tempDirPrefix: 'dsh-source-controller-lifecycle-',
    mode,
    binScript: driver,
    libBinScript: driver,
    configPath: './cordis.yml',
    binArgs: ['./cordis.yml', kind, phase, disposition, mode],
    tsconfigPath: fileURLToPath(new URL('tsconfig.base.json', root)),
    prepare: async (cwd) => {
      const entry = (name: string, config?: object, id?: string) => ({ name: `@deepseek-ai/dsh-${name}`, config, id })
      await writeFile(join(cwd, 'cordis.yml'), JSON.stringify([
        entry('llm'), entry('session'), entry('session-projection'), entry('agent'),
        entry('system-prompt'), entry('tools'), entry('tool-executor-native'),
        entry('session-persistence-jsonl', { root: './sessions', compression: 'none' }),
        entry('agent-loop'), entry('storage'), entry('storage-json', { root: './storage' }),
        entry('storage-domain', { backend: 'json' }), entry('workspace'),
        entry('agent-default-model', { provider: 'lifecycle-fixture', model: 'deterministic' }),
        entry('typert-registry'), entry('api-remote-access'), entry('api-gateway'),
        entry('session-query-sqlite', { path: ':memory:', openAt: 'never' }),
        entry('attachment-local', { dshHome: join(cwd, '.dsh') }), entry('fs-local', { cwd }),
        entry('commands'), entry('credentials-local', { dshHome: join(cwd, '.dsh'), watch: false }),
        entry('client-connection'), entry('client-file-upload'),
        entry('api-session-controller', { nativeOpen: false }, 'controller'),
        { name: scheduleProvider, id: 'schedule' },
      ], null, 2))
      await symlink(resolverModules, join(cwd, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    },
    inspect: async (cwd) => {
      const report: unknown = JSON.parse(await readFile(join(cwd, 'result.json'), 'utf8'))
      console.log(JSON.stringify({ kind, phase, disposition, report }))
      expect(report, 'the borrowed creation must reach a durable task receipt').toMatchObject({
        launch: { mode }, outcome: { status: 'fulfilled' }, persisted: true, inboxInsertions: 1, receipt: true,
      })
    },
  }
}

it.each(['src', 'lib'] as const)('selects %s launch and package resolution for the actual lifecycle fixture', async (mode) => {
  const options = smokeOptions(scenarios[0], mode)
  const launch = resolveExampleLaunch({
    srcBin: options.binScript, libBin: options.libBinScript, configArgs: options.binArgs,
    ...(options.mode === undefined ? {} : { mode: options.mode }), tsconfigPath: options.tsconfigPath,
  })
  expect(launch.command).toBe(process.execPath)
  expect(launch.args).toEqual(mode === 'src'
    ? ['--import', expect.any(String), driver, ...options.binArgs!]
    : [driver, ...options.binArgs!])
  expect(launch.env.TSX_TSCONFIG_PATH).toBe(mode === 'src' ? options.tsconfigPath : undefined)
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-source-controller-launch-'))
  try {
    await options.prepare?.(cwd)
    const entries: { name: string }[] = JSON.parse(await readFile(join(cwd, 'cordis.yml'), 'utf8'))
    expect(entries.map(entry => entry.name)).toContain('@deepseek-ai/dsh-api-session-controller')
    expect(entries.map(entry => entry.name)).toContain(scheduleProvider)
    for (const { name } of entries) {
      if (name !== scheduleProvider) expect(name).toMatch(/^@deepseek-ai\/dsh-[a-z0-9-]+$/u)
    }
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

it.each(scenarios)(
  'delivers borrowed %s creation at %s persistence with provider %s',
  async (kind, phase, disposition) => {
    await runLoaderSmoke(smokeOptions([kind, phase, disposition], resolveExampleMode()))
  },
  LOADER_SMOKE_TEST_TIMEOUT_MS,
)
