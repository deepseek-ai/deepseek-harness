import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  captureExpectedWorkspaceSnapshot,
  captureWorkspaceSnapshot,
  EMPTY_WORKSPACE_MARKER,
} from '../src/workspace.ts'

describe('workspace snapshots', () => {
  const roots: string[] = []

  async function root(): Promise<string> {
    const value = await mkdtemp(join(tmpdir(), 'dsh-workspace-snapshot-'))
    roots.push(value)
    return value
  }

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
  })

  it('captures readable text, binary bytes, links, and empty directories in path order', async () => {
    const directory = await root()
    await writeFile(join(directory, 'a.txt'), 'hello\n')
    await writeFile(join(directory, 'b.bin'), Buffer.from([0xff, 0x01]))
    await mkdir(join(directory, 'empty'))
    await symlink('a.txt', join(directory, 'link'))

    expect(await captureWorkspaceSnapshot(directory)).toEqual([
      { path: 'a.txt', kind: 'text', content: 'hello\n' },
      { path: 'b.bin', kind: 'binary', base64: '/wE=' },
      { path: 'empty', kind: 'empty-directory' },
      { path: 'link', kind: 'symlink', target: 'a.txt' },
    ])
  })

  it('keeps generic marker files but omits declared runtime roots and the expected-empty marker', async () => {
    const directory = await root()
    await mkdir(join(directory, '.dsh'))
    await writeFile(join(directory, '.dsh', 'runtime.json'), '{}')
    await writeFile(join(directory, EMPTY_WORKSPACE_MARKER), '')
    await writeFile(join(directory, 'visible.txt'), 'visible')

    expect(await captureWorkspaceSnapshot(directory, { ignoredRootEntries: ['.dsh'] })).toEqual([
      { path: '.empty', kind: 'text', content: '' },
      { path: 'visible.txt', kind: 'text', content: 'visible' },
    ])
    expect(await captureExpectedWorkspaceSnapshot(directory)).toEqual([
      { path: '.dsh/runtime.json', kind: 'text', content: '{}' },
      { path: 'visible.txt', kind: 'text', content: 'visible' },
    ])
  })

  it('uses nested expected markers for empty directories without hiding actual workspace files', async () => {
    const directory = await root()
    await mkdir(join(directory, 'locked'))
    await writeFile(join(directory, 'locked', EMPTY_WORKSPACE_MARKER), '')

    expect(await captureExpectedWorkspaceSnapshot(directory)).toEqual([
      { path: 'locked', kind: 'empty-directory' },
    ])
    expect(await captureWorkspaceSnapshot(directory)).toEqual([
      { path: 'locked/.empty', kind: 'text', content: '' },
    ])
  })

  it('treats NUL-bearing UTF-8 as binary workspace state', async () => {
    const directory = await root()
    await writeFile(join(directory, 'nul.bin'), Buffer.from([0x61, 0x00, 0x62]))
    expect(await captureWorkspaceSnapshot(directory)).toEqual([
      { path: 'nul.bin', kind: 'binary', base64: 'YQBi' },
    ])
  })
})
