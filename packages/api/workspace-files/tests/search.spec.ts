/** The `search` endpoint: matching, filters, ignore files, caps, failures, cancellation, and links. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { mountSearchSubprocess } from './search-harness.ts'
import type { WorkspaceFileSearchRequest, WorkspaceFileSearchResult } from '../src/index.ts'
import { failureOf, openWorkspace, signal, type Caps, type Harness } from './harness.ts'

let harness: Harness
let workspace: string

beforeEach(async () => {
  harness = await openWorkspace('dsh-workspace-files-search-')
  await mountSearchSubprocess(harness)
  workspace = harness.workspace
})

afterEach(async () => {
  vi.restoreAllMocks()
  await harness.ctx.fiber.dispose()
  await harness.dispose()
})

/** Create empty files, and their parent directories, at workspace-relative paths. */
async function files(...paths: string[]): Promise<void> {
  for (const path of paths) {
    await mkdir(dirname(join(workspace, path)), { recursive: true })
    await writeFile(join(workspace, path), '', 'utf8')
  }
}

/** Write one text file at a workspace-relative path. */
async function text(path: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(join(workspace, path)), { recursive: true })
  await writeFile(join(workspace, path), content)
}

const search = (
  query: string,
  options: Partial<Omit<WorkspaceFileSearchRequest, 'query'>> = {},
  caps?: Caps,
  abort: AbortSignal = signal(),
): Promise<WorkspaceFileSearchResult> =>
  harness.endpoint(caps).search(harness.scope, {
    query,
    excludedPaths: options.excludedPaths ?? [],
    includeHidden: options.includeHidden ?? false,
    respectGitignore: options.respectGitignore ?? false,
  }, abort)

const pathsOf = (result: WorkspaceFileSearchResult): string[] => result.matches.map(match => match.path)

describe('workspaceFiles.search — matching', () => {
  it('matches entry names case-insensitively, shallower levels first, with each type', async () => {
    await files('src/deep/Button.tsx', 'BUTTON.md', 'notes.txt')
    await files('src/button-group/a', 'src/button-group/b')
    await mkdir(join(workspace, 'empty-button'))
    const result = await search('  button ')
    expect(result).toEqual({
      matches: [
        { path: 'BUTTON.md', type: 'file' },
        { path: 'src/button-group', type: 'directory' },
        { path: 'src/deep/Button.tsx', type: 'file' },
      ],
      truncated: false,
      incomplete: false,
    })
  })

  it('matches workspace-relative paths case-insensitively when the query holds a slash', async () => {
    await files('src/app/main.ts', 'lib/src/app.ts', 'other/main.ts')
    const result = await search('SRC/APP')
    expect(pathsOf(result)).toEqual(['src/app', 'lib/src/app.ts', 'src/app/main.ts'])
  })

  it('refuses a blank query as a bad request', async () => {
    const failure = await failureOf(search('  \t '))
    expect(failure.code).toBe('gateway/bad-request')
  })

  it('reports a missing workspace root as not found and a file root as not a directory', async () => {
    await files('root-file')
    const service = harness.endpoint()
    const request = { query: 'a', excludedPaths: [], includeHidden: false, respectGitignore: false }
    const missing = await failureOf(service.search({ ...harness.scope, workspaceRoot: join(workspace, 'gone') }, request, signal()))
    expect(missing.code).toBe('workspace-file/not-found')
    const file = await failureOf(service.search({ ...harness.scope, workspaceRoot: join(workspace, 'root-file') }, request, signal()))
    expect(file).toMatchObject({ code: 'workspace-file/not-directory', details: { kind: 'file' } })
  })
})

describe('workspaceFiles.search — exclusions and hidden entries', () => {
  it('excludes a name at every depth without entering it', async () => {
    await files('node_modules/pkg/index.ts', 'app/node_modules/dep/index.ts', 'app/index.ts')
    const result = await search('index', { excludedPaths: ['node_modules'] })
    expect(pathsOf(result)).toEqual(['app/index.ts'])
  })

  it('excludes one exact relative path without entering it', async () => {
    await files('a/b/target.txt', 'c/a/b/target.txt', 'a/target.txt')
    const result = await search('target', { excludedPaths: ['a/b'] })
    expect(pathsOf(result)).toEqual(['a/target.txt', 'c/a/b/target.txt'])
    expect(pathsOf(await search('b', { excludedPaths: ['a/b'] }))).toEqual(['c/a/b'])
  })

  it('leaves hidden entries out and unentered unless they are included', async () => {
    await files('.env', '.config/env.ts', 'env.md')
    expect(pathsOf(await search('env'))).toEqual(['env.md'])
    expect(pathsOf(await search('env', { includeHidden: true }))).toEqual(['.env', 'env.md', '.config/env.ts'])
  })
})

describe('workspaceFiles.search — ignore files', () => {
  beforeEach(async () => {
    await text('.gitignore', '*.log\n!keep.log\nbuild/\n')
    await text('sub/.gitignore', 'secret.txt\n!sub-keep.log\n')
    await text('.git/info/exclude', 'excluded.txt\n')
    await files(
      'debug.log', 'keep.log', 'secret.txt', 'excluded.txt',
      'sub/secret.txt', 'sub/sub-keep.log', 'sub/other.log',
      'other/secret.txt', 'out/build/target.txt', 'tools/build',
    )
  })

  it('applies nested .gitignore files to their own subtree, with negation and directory-only patterns', async () => {
    const result = await search('.', { respectGitignore: true })
    expect(pathsOf(result)).toEqual(['keep.log', 'secret.txt', 'other/secret.txt', 'sub/sub-keep.log'])
    expect(result.incomplete).toBe(false)
    expect(pathsOf(await search('build', { respectGitignore: true }))).toEqual(['tools/build'])
    expect(pathsOf(await search('target', { respectGitignore: true }))).toEqual([])
  })

  it('applies the root .git/info/exclude', async () => {
    expect(pathsOf(await search('excluded', { respectGitignore: true }))).toEqual([])
  })

  it('applies no ignore file when ignore files are not respected', async () => {
    const result = await search('.', {})
    expect(pathsOf(result)).toEqual([
      'debug.log', 'excluded.txt', 'keep.log', 'secret.txt',
      'other/secret.txt', 'sub/other.log', 'sub/secret.txt', 'sub/sub-keep.log', 'out/build/target.txt',
    ])
  })
})
