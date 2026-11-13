/** Real Loader, Session Controller, and JSONL create overlap with provider shutdown. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const fixture = new URL('../fixtures/source-controller-lifecycle/', import.meta.url)
const driver = fileURLToPath(new URL('driver.ts', fixture))
const root = new URL('../../../../../', import.meta.url)
const source = (path: string) => fileURLToPath(new URL(`packages/${path}/src/index.ts`, root))

it.each([
  ['new_once', 'before'], ['new_once', 'after'], ['new', 'before'], ['new', 'after'],
] as const)('drains a borrowed %s creation when its provider unloads %s persistence create', async (kind, phase) => {
  for (const disposition of ['keep', 'dispose'] as const) {
    await runLoaderSmoke({
      label: `Source Controller ${kind}/${phase}/${disposition}`,
      tempDirPrefix: 'dsh-source-controller-lifecycle-',
      mode: 'src',
      binScript: driver,
      libBinScript: driver,
      configPath: './cordis.yml',
      binArgs: ['./cordis.yml', kind, phase, disposition],
      tsconfigPath: fileURLToPath(new URL('tsconfig.base.json', root)),
      prepare: async (cwd) => {
        const entry = (path: string, config?: object, id?: string) => ({ name: source(path), config, id })
        await writeFile(join(cwd, 'cordis.yml'), JSON.stringify([
          entry('llm/llm'), entry('core/session'), entry('session/session-projection'), entry('core/agent'),
          entry('core/system-prompt'), entry('core/tools'), entry('core/tool-executor-native'),
          entry('session/session-persistence-jsonl', { root: './sessions', compression: 'none' }),
          entry('core/agent-loop'), entry('storage/storage'), entry('storage/storage-json', { root: './storage' }),
          entry('storage/storage-domain', { backend: 'json' }), entry('workspace/workspace'),
          entry('core/agent-default-model', { provider: 'lifecycle-fixture', model: 'deterministic' }),
          entry('typert/registry'), entry('api/remote-access'), entry('api/gateway'),
          entry('session-query/session-query-sqlite', { path: ':memory:', openAt: 'never' }),
          entry('attachment/attachment-local', { dshHome: join(cwd, '.dsh') }), entry('fs/fs-local', { cwd }),
          entry('interaction/commands'), entry('credentials/credentials-local', { dshHome: join(cwd, '.dsh'), watch: false }),
          entry('client/connection'), entry('client/file-upload'),
          entry('api/session-controller', { nativeOpen: false }, 'controller'),
          entry('schedule/schedule', {}, 'schedule'),
        ], null, 2))
      },
      inspect: async (cwd) => {
        const report: unknown = JSON.parse(await readFile(join(cwd, 'result.json'), 'utf8'))
        console.log(JSON.stringify({ kind, phase, disposition, report }))
        expect(report, 'the borrowed creation must reach a durable task receipt').toMatchObject({
          outcome: { status: 'fulfilled' }, persisted: true, inboxInsertions: 1, receipt: true,
        })
      },
    })
  }
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
