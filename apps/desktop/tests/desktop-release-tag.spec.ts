import { describe, expect, it } from 'vitest'
import { desktopReleaseTag, tagDesktopRelease } from '../scripts/desktop-release-tag.ts'

const COMMIT = '0'.repeat(40)
const OTHER = '1'.repeat(40)
const VERSION = '0.1.6-alpha.2'

function recorder(responses: Record<string, string | Error>): {
  readonly run: (command: string, args: readonly string[]) => string
  readonly calls: string[][]
} {
  const calls: string[][] = []
  return {
    calls,
    run: (command, args) => {
      calls.push([command, ...args])
      const response = responses[args[0] ?? '']
      if (response instanceof Error) throw response
      return response ?? ''
    },
  }
}

describe('desktop release tag', () => {
  it('names a tag distinct from the npm family tags', () => {
    expect(desktopReleaseTag(VERSION)).toBe(`desktop-v${VERSION}`)
  })

  it('creates and pushes a tag for the packaged commit', () => {
    const { run, calls } = recorder({ tag: '' })
    expect(tagDesktopRelease({ version: VERSION, commit: COMMIT, repositoryRoot: '.', run }))
      .toEqual({ tag: `desktop-v${VERSION}`, status: 'created' })
    expect(calls).toEqual([
      ['git', 'tag', '--list', `desktop-v${VERSION}`],
      ['git', 'tag', `desktop-v${VERSION}`, COMMIT],
      ['git', 'push', 'origin', `desktop-v${VERSION}`],
    ])
  })

  it('pushes an existing tag that already names the uploaded commit', () => {
    const { run, calls } = recorder({ tag: `desktop-v${VERSION}`, 'rev-list': COMMIT })
    expect(tagDesktopRelease({ version: VERSION, commit: COMMIT, repositoryRoot: '.', run }))
      .toEqual({ tag: `desktop-v${VERSION}`, status: 'present' })
    expect(calls.at(-1)).toEqual(['git', 'push', 'origin', `desktop-v${VERSION}`])
  })

  it('refuses to move a tag that names another commit', () => {
    const { run, calls } = recorder({ tag: `desktop-v${VERSION}`, 'rev-list': OTHER })
    const result = tagDesktopRelease({ version: VERSION, commit: COMMIT, repositoryRoot: '.', run })
    expect(result.status).toBe('failed')
    expect(result.detail).toMatch(new RegExp(`already names ${OTHER}`, 'u'))
    expect(calls.some(call => call.includes('push'))).toBe(false)
  })

  it('reports a git failure instead of throwing, because the release is already public', () => {
    const { run } = recorder({ tag: new Error('git unavailable') })
    expect(tagDesktopRelease({ version: VERSION, commit: COMMIT, repositoryRoot: '.', run }))
      .toMatchObject({ status: 'failed', detail: 'git unavailable' })
  })

  it('recovers a failed push without repeating the tag that already exists', () => {
    // `git tag` would fail with "already exists" and short-circuit a combined command, leaving the push undone.
    const { run } = recorder({ tag: '', push: new Error('remote rejected') })
    expect(tagDesktopRelease({ version: VERSION, commit: COMMIT, repositoryRoot: '.', run }))
      .toMatchObject({ status: 'failed', recovery: [`git push origin desktop-v${VERSION}`] })
  })

  it('recovers a failed tag by creating it before pushing', () => {
    const { run } = recorder({ tag: new Error('cannot write ref') })
    expect(tagDesktopRelease({ version: VERSION, commit: COMMIT, repositoryRoot: '.', run }))
      .toMatchObject({ recovery: [`git tag desktop-v${VERSION} ${COMMIT}`, `git push origin desktop-v${VERSION}`] })
  })

  it('pushes to a named remote', () => {
    const { run, calls } = recorder({ tag: '' })
    tagDesktopRelease({ version: VERSION, commit: COMMIT, repositoryRoot: '.', remote: 'upstream', run })
    expect(calls.at(-1)).toEqual(['git', 'push', 'upstream', `desktop-v${VERSION}`])
  })
})
