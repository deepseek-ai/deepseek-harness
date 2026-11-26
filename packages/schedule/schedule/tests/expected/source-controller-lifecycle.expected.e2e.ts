/** Real Loader, Session Controller, and JSONL create overlap with provider shutdown. */
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { z } from 'zod'
import {
  LOADER_SMOKE_TEST_TIMEOUT_MS, resolveExampleLaunch, resolveExampleMode, runLoaderSmoke,
  type ExampleMode, type LoaderSmokeOptions,
} from '@deepseek-ai/dsh-loader-smoke'

const entriesSchema = z.array(z.looseObject({ name: z.string() }))

it('source controller entries schema rejects missing or non-string names', () => {
  const entry = { name: '@deepseek-ai/dsh-api-session-controller', id: 'controller' }
  expect(entriesSchema.parse(JSON.parse(JSON.stringify([entry])))).toEqual([entry])
  for (const json of ['[{}]', '[{"name":1}]']) {
    expect(() => entriesSchema.parse(JSON.parse(json)), json).toThrow(z.ZodError)
  }
})

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
) {
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
        entry('system-prompt'), entry('tools'), entry('tool-registry-native'),
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
      const taskRecord = {
        kind: 'at', title: 'Inspect build', prompt: 'Inspect the reported build.',
        scheduledAt: '2099-01-01T00:00:00.000Z',
      }
      expect(report).toMatchObject({
        launch: { mode }, visibleAtGate: phase === 'after',
        originalProviderUid: expect.any(Number) as number, reservedSessionId: expect.any(String) as string,
        providerClosed: disposition === 'dispose', creationAttempts: 1,
        task: { status: 'active', record: taskRecord },
      })
      if (disposition === 'keep') {
        expect(report, 'the borrowed creation must reach a durable task receipt').toMatchObject({
          launch: { mode }, outcome: { status: 'fulfilled' }, persisted: true, inboxInsertions: 1, receipt: true,
        })
        expect(report).toMatchObject({ liveAgent: true, userMessages: 1, receiptCount: 1 })
        return
      }
      const emptyDestination = {
        persisted: false, liveAgent: false, inboxInsertions: 0, userMessages: 0,
        receipt: false, receiptCount: 0, logsAfter: [],
      }
      expect(report, 'provider withdrawal rejects creation without a successful delivery').toMatchObject({
        ...emptyDestination,
        outcome: {
          status: 'rejected',
          error: {
            name: 'RemoteError', code: 'gateway/internal',
            message: expect.stringContaining('failed to create session: Error: cannot create effect on inactive context') as string,
          },
        },
        task: { status: 'active', record: taskRecord, target: { kind } },
        pendingDelivery: kind === 'new' ? { targetSessionId: expect.any(String) as string } : null,
        recovery: {
          beforeRetry: emptyDestination,
          outcome: { status: 'fulfilled' },
          persisted: true, liveAgent: true, inboxInsertions: 1, userMessages: 1,
          receipt: true, receiptCount: 1, creationAttempts: 2,
          pendingDelivery: null, replacementProviderUid: expect.any(Number) as number,
          userTexts: [expect.stringContaining('source_input_json: "Inspect the replacement build."')],
          task: {
            status: 'active', record: taskRecord,
            target: { kind: kind === 'new_once' ? 'session' : 'new' },
            lastDelivery: { targetSessionId: expect.any(String) as string },
          },
          fifoEdited: { title: 'Edited after failed creation' },
          fifoDeleted: { deleted: true },
        },
      })
      expect(report).toMatchObject({
        recovery: { userTexts: [expect.not.stringContaining('Inspect the completed build.')] },
      })
    },
  } satisfies LoaderSmokeOptions
}

it.each(['src', 'lib'] as const)('selects %s launch and package resolution for the actual lifecycle fixture', async (mode) => {
  const options = smokeOptions(scenarios[0], mode)
  const launch = resolveExampleLaunch({
    srcBin: options.binScript, libBin: options.libBinScript, configArgs: options.binArgs,
    ...(options.mode === undefined ? {} : { mode: options.mode }), tsconfigPath: options.tsconfigPath,
  })
  expect(launch.command).toBe(process.execPath)
  expect(launch.args).toEqual(mode === 'src'
    ? ['--import', expect.any(String), driver, ...options.binArgs]
    : [driver, ...options.binArgs])
  expect(launch.env.TSX_TSCONFIG_PATH).toBe(mode === 'src' ? options.tsconfigPath : undefined)
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-source-controller-launch-'))
  try {
    await options.prepare?.(cwd)
    const entries = entriesSchema.parse(
      JSON.parse(await readFile(join(cwd, 'cordis.yml'), 'utf8')),
    )
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
  'settles borrowed %s creation at %s persistence with provider %s',
  async (kind, phase, disposition) => {
    await runLoaderSmoke(smokeOptions([kind, phase, disposition], resolveExampleMode()))
  },
  LOADER_SMOKE_TEST_TIMEOUT_MS,
)
