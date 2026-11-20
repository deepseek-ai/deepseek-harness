import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  WEB_SNAPSHOT_SERIAL_FILES,
  WEB_SNAPSHOT_SLICE_COUNTS,
  ownsWebSnapshotSerialFiles,
  parseWebSnapshotShard,
  sliceOfTest,
  sliceProjectName,
  webSnapshotProjects,
} from './web-snapshot-projects.ts'

describe('web snapshot test slices', () => {
  it('assigns tests to slices round-robin by depth-first index', () => {
    expect(Array.from({ length: 7 }, (_, index) => sliceOfTest(index, 3))).toEqual([1, 2, 3, 1, 2, 3, 1])
  })

  it('names one project per slice by file stem', () => {
    expect(sliceProjectName('apps/web/tests/document-preview.e2e.ts', 2)).toBe('web-slice:document-preview:2')
  })

  // The slice setup file checks at runtime that each slice receives a test.
  it('plans only existing, non-serial files, each with at least two slices', () => {
    const plans = Object.entries(WEB_SNAPSHOT_SLICE_COUNTS)

    expect(plans.length).toBeGreaterThan(0)
    for (const [file, count] of plans) {
      expect(existsSync(file), file).toBe(true)
      expect(WEB_SNAPSHOT_SERIAL_FILES, file).not.toContain(file)
      expect(Number.isSafeInteger(count) && count >= 2, file).toBe(true)
    }
  })

  it('runs each sliced file only in its slice projects', () => {
    const projects = webSnapshotProjects(['apps/web/tests/**/*.e2e.ts'], ['**/node_modules/**'])
    const main = projects.find(project => project.test.name === 'web')

    for (const [file, count] of Object.entries(WEB_SNAPSHOT_SLICE_COUNTS)) {
      expect(main?.test.exclude, file).toContain(file)
      const slices = projects.filter(project => project.test.include.includes(file)).map(project => project.test.name)
      expect(slices, file).toEqual(Array.from({ length: count }, (_, index) => sliceProjectName(file, index + 1)))
    }
  })
})

describe('web snapshot shards', () => {
  it('parses an in-range shard', () => {
    expect(parseWebSnapshotShard('1/2')).toEqual({ index: 1, count: 2 })
    expect(parseWebSnapshotShard('2/2')).toEqual({ index: 2, count: 2 })
  })

  it.each(['3/2', '0/2', 'a/b'])('rejects shard %s', (raw) => {
    expect(() => parseWebSnapshotShard(raw)).toThrow(
      `DSH_WEB_SNAPSHOT_SHARD must be <index>/<count> with 1 <= index <= count, got ${JSON.stringify(raw)}.`,
    )
  })

  it('runs the whole pool and the serial files when unset', () => {
    expect(parseWebSnapshotShard(undefined)).toBeUndefined()
    expect(parseWebSnapshotShard('')).toBeUndefined()
    expect(ownsWebSnapshotSerialFiles(undefined)).toBe(true)
  })

  it('runs the serial files only in the last shard', () => {
    expect(ownsWebSnapshotSerialFiles({ index: 1, count: 2 })).toBe(false)
    expect(ownsWebSnapshotSerialFiles({ index: 2, count: 2 })).toBe(true)
  })
})

describe('web perf inventory', () => {
  it('collects only the perf files, without the browser lane projects or sequencer', async () => {
    // A runtime URL keeps the root Vitest configs outside the scripts type program.
    const perfConfigUrl = pathToFileURL(resolve(import.meta.dirname, '../vitest.web.perf.config.ts')).href
    const { default: webPerfConfig } = await import(perfConfigUrl) as { default: { test?: Record<string, unknown> } }
    expect(webPerfConfig.test).not.toHaveProperty('projects')
    expect(webPerfConfig.test).not.toHaveProperty('sequence')
    expect(webPerfConfig.test?.include).toEqual([
      'apps/web/tests/**/*.perf.ts',
      'packages/client/ui-conversation/tests/**/*.perf.client.ts',
    ])
  })
})
