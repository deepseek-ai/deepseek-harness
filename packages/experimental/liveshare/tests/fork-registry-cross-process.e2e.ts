/**
 * Two real OS processes writing one fork registry file.
 *
 * One DSH home can be served by several Host processes, and the registry keeps its children, its
 * logical operations, and its withdrawals in that one file. A process that rewrites the file from the
 * snapshot it read earlier drops whatever the other process committed in between, which loses a
 * withdrawal it can no longer enforce or a served request it forks a second time. Each case here
 * starts two child processes that both read the file, lets them write in a stated order, and asserts
 * on the file they both finished with. Keyless, and both writers are real `node` processes running the
 * registry source through tsx rather than two objects in this process.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { ForkRegistry } from '../src/host/fork-registry.ts'

const SOURCE = pathToFileURL(fileURLToPath(new URL('../src/host/fork-registry.ts', import.meta.url))).href
const REPOSITORY = fileURLToPath(new URL('../../../../', import.meta.url))
const TSCONFIG = join(REPOSITORY, 'tsconfig.base.json')

const SHARE = 'share-first'
const REVOKED_AT = '2026-09-12T01:00:00.000Z'
const VIEWER = { providerId: 'feishu', tenantId: 'tenant-a', subjectId: 'ou_viewer' }

/**
 * The writer each case starts: it reads the registry, reports `loaded`, waits for one line on stdin,
 * applies the change its role names, reports `written`, and exits. Reading before the signal is what
 * makes the two processes' snapshots overlap, which is the interleaving the registry has to survive.
 */
const WRITER_SOURCE = `
import { ForkRegistry } from ${JSON.stringify(SOURCE)}

const [file, role] = process.argv.slice(2)
const registry = new ForkRegistry(file)
process.stdout.write('loaded\\n')
await new Promise((resolve) => { process.stdin.once('data', resolve) })

const record = async (childSessionId, shareId, operationKey) => {
  await registry.record({
    childSessionId,
    shareId,
    sourceSessionId: 'session-source',
    boundary: 3,
    creator: ${JSON.stringify(VIEWER)},
    createdAt: '2026-09-12T00:00:00.000Z',
  })
  await registry.recordOperation({
    key: operationKey,
    childSessionId,
    boundary: 3,
    ready: true,
    status: 200,
    body: { result: { ok: true } },
  })
}

if (role === 'record-first') await record('child-first', 'share-first', 'operation-first')
if (role === 'record-second') await record('child-second', 'share-second', 'operation-second')
if (role === 'record-close') await record('child-close', 'share-second', 'operation-close')
if (role === 'revoke') await registry.revokeShare('share-first', ${JSON.stringify(REVOKED_AT)})
process.stdout.write('written\\n')
`

const directories: string[] = []
const writers: ChildProcessWithoutNullStreams[] = []

afterEach(async () => {
  for (const writer of writers.splice(0)) writer.kill('SIGKILL')
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

afterAll(async () => {
  for (const directory of scriptDirectories.splice(0)) await rm(directory, { recursive: true, force: true })
})

/** One registry document as the file holds it. */
interface RegistryDocument {
  readonly forks?: readonly { readonly childSessionId?: unknown; readonly revokedAt?: unknown }[]
  readonly operations?: readonly { readonly key?: unknown }[]
}

/** One spawned writer: its stdout lines in order, its exit code, and its stderr for a failure report. */
interface Writer {
  readonly process: ChildProcessWithoutNullStreams
  /** Release the writer to apply its change; closing its stdin lets the process exit. */
  readonly go: () => void
  readonly nextLine: () => Promise<string>
  readonly exited: Promise<number | null>
}

const scriptDirectories: string[] = []
let script: Promise<string> | undefined

/**
 * The writer script, written once into a temporary directory. It is a real module file so the child
 * runs the registry the same way any other process does, rather than through an inline `-e` program.
 * @returns Path of the script file.
 */
async function writerScript(): Promise<string> {
  script ??= (async (): Promise<string> => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-fork-registry-writer-'))
    scriptDirectories.push(directory)
    const path = join(directory, 'writer.mts')
    await writeFile(path, WRITER_SOURCE)
    return path
  })()
  return await script
}

/** One temporary directory holding the registry both writers share. */
async function directory(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), 'dsh-fork-registry-2proc-'))
  directories.push(created)
  return created
}

/** Start one child process against `file`, holding the registry unmodified until it is signalled. */
async function start(file: string, role: string): Promise<Writer> {
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx/esm'), await writerScript(), file, role], {
    cwd: REPOSITORY,
    // The child imports the registry source, whose workspace imports resolve through this tsconfig's
    // paths; tsx would otherwise look for one beside the temporary script.
    env: { ...process.env, TSX_TSCONFIG_PATH: TSCONFIG },
  })
  writers.push(child)
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  const exited = new Promise<number | null>((resolve) => { child.once('exit', (code) => { resolve(code) }) })
  const queue: string[] = []
  const waiting: ((line: string) => void)[] = []
  createInterface({ input: child.stdout }).on('line', (line: string) => {
    const resolve = waiting.shift()
    if (resolve === undefined) queue.push(line)
    else resolve(line)
  })
  return {
    process: child,
    // The writer waits on its own stdin, which stays open until this end closes it; an open pipe would
    // otherwise keep the child alive after its change and hold this test past its timeout.
    go: () => { child.stdin.end('go\n') },
    nextLine: async (): Promise<string> => {
      const queued = queue.shift()
      if (queued !== undefined) return queued
      return await new Promise<string>((resolve, reject) => {
        waiting.push(resolve)
        void exited.then((code) => {
          reject(new Error(`writer ${role} exited with ${String(code)} before reporting: ${stderr}`))
        })
      })
    },
    exited,
  }
}

/** Wait for one writer to apply its change, reporting its stderr when it failed instead. */
async function wrote(writer: Writer): Promise<void> {
  expect(await writer.nextLine()).toBe('written')
  expect(await writer.exited).toBe(0)
}

/** The child session ids the document holds. */
function childrenOf(document: RegistryDocument): string[] {
  return (document.forks ?? []).map(entry => String(entry.childSessionId))
}

/** The operation keys the document holds. */
function operationsOf(document: RegistryDocument): string[] {
  return (document.operations ?? []).map(entry => String(entry.key))
}

/** Parse the registry file both writers finished with. */
async function documentOf(file: string): Promise<RegistryDocument> {
  return JSON.parse(await readFile(file, 'utf8')) as RegistryDocument
}

describe('fork registry across two processes', () => {
  it('keeps a record and an operation from each process that wrote from its own read', { timeout: 30_000 }, async () => {
    const file = join(await directory(), 'forks.json')
    const first = await start(file, 'record-first')
    const second = await start(file, 'record-second')
    expect(await first.nextLine()).toBe('loaded')
    expect(await second.nextLine()).toBe('loaded')

    // Both snapshots are empty, so a writer that replaces the file from its snapshot drops the other.
    first.go()
    second.go()
    await wrote(first)
    await wrote(second)

    const document = await documentOf(file)
    expect(childrenOf(document).sort()).toEqual(['child-first', 'child-second'])
    expect(operationsOf(document).sort()).toEqual(['operation-first', 'operation-second'])
  })

  it('keeps a withdrawal written by one process while the other records a child from its earlier read', { timeout: 30_000 }, async () => {
    const file = join(await directory(), 'forks.json')
    const seeded = new ForkRegistry(file)
    await seeded.record({
      childSessionId: 'child-source',
      shareId: SHARE,
      sourceSessionId: 'session-source',
      boundary: 3,
      creator: VIEWER,
      createdAt: '2026-09-12T00:00:00.000Z',
    })
    const revoker = await start(file, 'revoke')
    const recorder = await start(file, 'record-close')
    expect(await revoker.nextLine()).toBe('loaded')
    expect(await recorder.nextLine()).toBe('loaded')

    // The withdrawal commits first; the recorder's snapshot still reads that share as live.
    revoker.go()
    await wrote(revoker)
    recorder.go()
    await wrote(recorder)

    const document = await documentOf(file)
    expect(childrenOf(document).sort()).toEqual(['child-close', 'child-source'])
    expect(document.forks?.find(entry => entry.childSessionId === 'child-source')?.revokedAt).toBe(REVOKED_AT)
    expect(operationsOf(document)).toEqual(['operation-close'])
  })
})
