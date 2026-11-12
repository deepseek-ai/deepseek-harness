/** Historical metadata caching without opening or migrating Sessions. @module */
import { Context } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { generationLogPath, toHeaderLine } from '../src/format.ts'
import { JsonlReader } from '../src/reader.ts'
import { meta } from '../../session-persistence/tests/contract.ts'

const probe = vi.hoisted(() => ({ path: '', opens: 0 }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, open(...args: Parameters<typeof fs.open>) {
    if (args[0] === probe.path) probe.opens++
    return fs.open(...args)
  } }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-legacy-metadata-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const header = { ...meta('cached-header'), delegationDepth: 0 }
  const path = generationLogPath(root, header.cwd, header.id, header.version, 'none')
  await mkdir(dirname(path), { recursive: true })
  probe.path = path
  probe.opens = 0
  return { path, header, reader: new JsonlReader(ctx, { root, compression: 'none' }) }
}

it('reuses unchanged legacy headers and detaches each returned header from its cache', async () => {
  const { path, header, reader } = await fixture()
  await writeFile(path, JSON.stringify(toHeaderLine(header)) + '\n')
  const first = await reader.list()
  expect(first).toHaveLength(1)
  expect(probe.opens).toBe(1)
  Object.assign(first[0]!.header, { cwd: '/changed-by-reader' })
  expect((await reader.list())[0]?.header).toEqual(header)
  expect(probe.opens).toBe(1)

  const replacement = { ...header, createdAt: 123456789 }
  await writeFile(path, JSON.stringify(toHeaderLine(replacement)) + '\n')
  expect((await reader.list())[0]?.header).toEqual(replacement)
  expect(probe.opens).toBe(2)
})

it('reuses an unreadable header result until the physical artifact changes', async () => {
  const { path, header, reader } = await fixture()
  await writeFile(path, 'invalid\n')
  expect(await reader.list()).toEqual([])
  expect(await reader.list()).toEqual([])
  expect(probe.opens).toBe(1)

  await writeFile(path, JSON.stringify(toHeaderLine(header)) + '\n')
  expect((await reader.list())[0]?.header).toEqual(header)
  expect(probe.opens).toBe(2)
})
