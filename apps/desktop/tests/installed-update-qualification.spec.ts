import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { collectInstalledUpdateJournals, createInstalledUpdateRun, inspectInstalledUpdateJournals } from '../scripts/installed-update-qualification.ts'
import { DesktopUpdateJournal } from '../src/update-journal.ts'

const versions = ['0.1.6-alpha.1.20260916.1', '0.1.6-alpha.1.20260916.2'] as const
const source = { version: '0.1.6-alpha.1', commit: 'a'.repeat(40), dirtyFiles: [' M apps/desktop/example.ts'] }
interface CollectionReport {
  readonly evidence: unknown
  readonly files: readonly { path: string; sha256: string; bytes: number }[]
}

async function fixture<T>(body: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-installed-update-'))
  try { return await body(directory) }
  finally { await rm(directory, { recursive: true, force: true }) }
}

function failedDownload(journal: DesktopUpdateJournal): void {
  journal.action('workspace-ready')
  journal.action('download-requested')
  journal.state({ phase: 'downloading', version: versions[1], percent: 1 })
  journal.state({ phase: 'error', version: versions[1], failedOperation: 'download', message: 'ERR_CONNECTION_RESET secret' })
}

function completeRetry(journal: DesktopUpdateJournal): void {
  journal.action('download-requested')
  journal.state({ phase: 'ready', version: versions[1] })
  journal.action('install-confirmed')
  journal.action('quit-requested')
}

describe('installed-update qualification materials', () => {
  it('allocates independent test-only namespaces and does not produce packages or overwrite an earlier manifest', async () => {
    await fixture(async (directory) => {
      const [first, next] = await Promise.all([createInstalledUpdateRun(directory, versions, source),
        createInstalledUpdateRun(directory, versions, source)])
      expect(first.root).not.toBe(next.root)
      expect(first.appId).not.toBe(next.appId)
      expect(first.feedKey).not.toBe(next.feedKey)
      expect(first.origin).toBe('https://download-test.deepseek.com')
      expect(first.environment).toBe('test')
      expect(first.feedKey).toBe(`dsh-desk/feeds/qualification/${first.id}/win-x64/nightly.yml`)
      expect(JSON.parse(await readFile(join(first.root, 'run.json'), 'utf8'))).toEqual(first)
      expect(await readdir(first.root)).toEqual(['run.json'])
    })
  })

  it.each([['1.0.0', '1.0.1'], [versions[1], versions[0]], [versions[0], versions[0]],
    ['garbage', versions[1]], ['0.1.6-nightly.abc', versions[1]], ['0.1.6-nightly.01', versions[1]]])(
    'rejects unusable version pair %s to %s before allocating material', async (old, next) => {
      await fixture(async (directory) => {
        await expect(createInstalledUpdateRun(directory, [old, next], source)).rejects.toThrow('increasing')
        expect(await readdir(directory)).toEqual([])
      })
    },
  )

  it.each(['alpha.1', 'beta.2', 'rc.3', 'test'])('accepts dated %s versions', async (prefix) => {
    await fixture(async (directory) => {
      const pair = [`0.1.6-${prefix}.20260916.1`, `0.1.6-${prefix}.20260916.2`] as const
      const run = await createInstalledUpdateRun(directory, pair, source)
      expect(run.versions).toEqual(pair)
    })
  })

  it('rejects an invalid source commit before allocating material', async () => {
    await fixture(async (directory) => {
      await expect(createInstalledUpdateRun(directory, versions, { ...source, commit: 'unknown' })).rejects.toThrow('Git commit')
      expect(await readdir(directory)).toEqual([])
    })
  })

  it('reads real journal output while keeping observed flow separate from installation and data acceptance', async () => {
    await fixture(async (directory) => {
      const original = new DesktopUpdateJournal(directory, versions[0])
      failedDownload(original)
      completeRetry(original)
      const successor = new DesktopUpdateJournal(directory, versions[1])
      successor.action('workspace-ready')
      const before = await readFile(original.path, 'utf8')
      const result = await inspectInstalledUpdateJournals(directory, versions)
      expect(result.recordedFlow).toBe('complete')
      expect(result.missing).toEqual([])
      expect(Object.keys(result.milestones)).toHaveLength(10)
      expect(result.operatorVerificationRequired).toContain('test-data-preserved')
      expect(result.operatorVerificationRequired).toContain('installer-completion-and-installed-path')
      expect(JSON.stringify(result)).not.toContain('secret')
      expect(await readFile(original.path, 'utf8')).toBe(before)
    })
  })

  it('does not join original-process fragments or count a successor startup by itself', async () => {
    await fixture(async (directory) => {
      failedDownload(new DesktopUpdateJournal(directory, versions[0]))
      completeRetry(new DesktopUpdateJournal(directory, versions[0]))
      new DesktopUpdateJournal(directory, versions[1]).action('workspace-ready')
      const result = await inspectInstalledUpdateJournals(directory, versions)
      expect(result.recordedFlow).toBe('incomplete')
      expect(result.missing).toContain('manual-retry')
      expect(result.missing).toContain('successor-workspace')
    })
  })

  it('requires a fresh retry and readiness after a later failure', async () => {
    await fixture(async (directory) => {
      const journal = new DesktopUpdateJournal(directory, versions[0])
      failedDownload(journal)
      journal.action('download-requested')
      journal.state({ phase: 'ready', version: versions[1] })
      journal.state({ phase: 'error', failedOperation: 'install', version: versions[1] })
      journal.action('install-confirmed')
      journal.action('quit-requested')
      new DesktopUpdateJournal(directory, versions[1]).action('workspace-ready')
      expect((await inspectInstalledUpdateJournals(directory, versions)).missing).toContain('download-ready')
    })
  })

  it('reports absent evidence as incomplete', async () => {
    await fixture(async (directory) => {
      const result = await inspectInstalledUpdateJournals(directory, versions)
      expect(result.recordedFlow).toBe('incomplete')
      expect(result.missing).toHaveLength(10)
    })
  })

  it('distinguishes a connection failure from an interrupted transfer with recorded progress', async () => {
    await fixture(async (directory) => {
      const journal = new DesktopUpdateJournal(directory, versions[0])
      journal.action('workspace-ready')
      journal.action('download-requested')
      journal.state({ phase: 'downloading', version: versions[1], percent: 0 })
      journal.state({ phase: 'error', failedOperation: 'download', version: versions[1] })
      completeRetry(journal)
      new DesktopUpdateJournal(directory, versions[1]).action('workspace-ready')
      expect((await inspectInstalledUpdateJournals(directory, versions)).missing).toContain('transfer-started')
    })
  })

  it.each(['partial', 'unknown-fields', 'wrong-sequence', 'mixed-version', 'invalid-json', 'unknown-phase', 'mixed-pid', 'raw-error', 'raw-operation', 'action-phase'])(
    'refuses %s evidence without printing raw input', async (variant) => {
      await fixture(async (directory) => {
        const journal = new DesktopUpdateJournal(directory, versions[0])
        const initial = await readFile(journal.path, 'utf8')
        const row = { ...JSON.parse(initial) as Record<string, unknown>, sequence: 1, event: 'state', phase: 'idle' }
        if (variant === 'unknown-fields') Object.assign(row, { secret: 'private-value' })
        if (variant === 'wrong-sequence') row.sequence = 9
        if (variant === 'mixed-version') Object.assign(row, { version: versions[1] })
        if (variant === 'unknown-phase') row.phase = 'unknown'
        if (variant === 'mixed-pid') Object.assign(row, { pid: 999999 })
        if (variant === 'raw-error') Object.assign(row, { errorCode: 'private-value' })
        if (variant === 'raw-operation') Object.assign(row, { failedOperation: 'private-value' })
        if (variant === 'action-phase') Object.assign(row, { event: 'download-requested', phase: 'private-value' })
        const next = variant === 'invalid-json' ? 'private-value' : JSON.stringify(row)
        await writeFile(journal.path, initial + next + (variant === 'partial' ? '' : '\n'))
        await expect(inspectInstalledUpdateJournals(directory, versions)).rejects.not.toThrow('private-value')
      })
    },
  )

  it('does not accept an already-running successor as evidence of a later restart', async () => {
    await fixture(async (directory) => {
      const journal = new DesktopUpdateJournal(directory, versions[0])
      failedDownload(journal)
      completeRetry(journal)
      const rows = ['started', 'workspace-ready'].map((event, sequence) => JSON.stringify({ schemaVersion: 1,
        pid: 123, sequence, time: '2000-01-01T00:00:00.000Z', version: versions[1], event }))
      await writeFile(join(directory, `1-${randomUUID()}.jsonl`), `${rows.join('\n')}\n`)
      expect((await inspectInstalledUpdateJournals(directory, versions)).missing).toContain('successor-started')
    })
  })

  it('collects exact validated journal bytes in independent snapshots without copying other files or declaring acceptance', async () => {
    await fixture(async (directory) => {
      const run = await createInstalledUpdateRun(directory, versions, source)
      const journals = join(directory, 'dsh-update-qualification', run.id, 'journals')
      const original = new DesktopUpdateJournal(journals, versions[0])
      failedDownload(original)
      await writeFile(join(journals, '.env'), 'private-value')
      const first = await collectInstalledUpdateJournals(join(run.root, 'run.json'), journals)
      const firstReport = JSON.parse(await readFile(join(first, 'report.json'), 'utf8')) as CollectionReport
      expect(firstReport).toMatchObject({ runId: run.id, operatorAcceptance: 'pending', evidence: { recordedFlow: 'incomplete' } })
      expect(await inspectInstalledUpdateJournals(join(first, 'journals'), versions)).toEqual(firstReport.evidence)
      completeRetry(original)
      new DesktopUpdateJournal(journals, versions[1]).action('workspace-ready')
      const second = await collectInstalledUpdateJournals(join(run.root, 'run.json'), journals)
      expect(second).not.toBe(first)
      const report = JSON.parse(await readFile(join(second, 'report.json'), 'utf8')) as CollectionReport
      expect(report).toMatchObject({ operatorAcceptance: 'pending', evidence: { recordedFlow: 'complete', filesRead: 2 } })
      expect(await inspectInstalledUpdateJournals(join(second, 'journals'), versions)).toEqual(report.evidence)
      expect(await readdir(join(second, 'journals'))).toEqual((await readdir(journals)).filter(file => file.endsWith('.jsonl')))
      for (const file of report.files) {
        const bytes = await readFile(join(second, file.path))
        expect(bytes.length).toBe(file.bytes)
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256)
        expect(bytes.toString()).not.toContain('secret')
      }
      expect(JSON.parse(await readFile(join(first, 'report.json'), 'utf8'))).toEqual(firstReport)
      expect(await readFile(join(journals, '.env'), 'utf8')).toBe('private-value')
    })
  })

  it('rejects invalid or wrong-run journals before allocating a collection', async () => {
    await fixture(async (directory) => {
      const run = await createInstalledUpdateRun(directory, versions, source)
      const manifest = join(run.root, 'run.json')
      await expect(collectInstalledUpdateJournals(manifest, directory)).rejects.toThrow('matching installed-app')
      const journals = join(directory, 'dsh-update-qualification', run.id, 'journals')
      await mkdir(journals, { recursive: true })
      await writeFile(join(journals, `1-${randomUUID()}.jsonl`), 'private-value\n')
      await expect(collectInstalledUpdateJournals(manifest, journals)).rejects.not.toThrow('private-value')
      expect(await readdir(run.root)).toEqual(['run.json'])
    })
  })

  it.each(['file', 'snapshot'])('rejects an oversized %s before collecting bytes', async (variant) => {
    await fixture(async (directory) => {
      const run = await createInstalledUpdateRun(directory, versions, source)
      const journals = join(directory, 'dsh-update-qualification', run.id, 'journals')
      await mkdir(journals, { recursive: true })
      const record = JSON.stringify({ schemaVersion: 1, sequence: 0, pid: 1, time: '2026-09-14T00:00:00.000Z',
        version: versions[0], event: 'started' })
      const text = record + ' '.repeat((variant === 'file' ? 11 : 9) * 1024 * 1024) + '\n'
      for (let index = 0; index < (variant === 'file' ? 1 : 6); index++) {
        await writeFile(join(journals, `${index}-${randomUUID()}.jsonl`), text)
      }
      await expect(collectInstalledUpdateJournals(join(run.root, 'run.json'), journals)).rejects.toThrow('limit')
      expect(await readdir(run.root)).toEqual(['run.json'])
    })
  })

  it('runs the documented source CLI and retains an incomplete report instead of claiming operator acceptance', async () => {
    await fixture(async (directory) => {
      const run = await createInstalledUpdateRun(directory, versions, source)
      const journals = join(directory, 'dsh-update-qualification', run.id, 'journals')
      new DesktopUpdateJournal(journals, versions[0]).action('workspace-ready')
      // This test owns the documented source-script entry, not a built application or Cordis profile.
      const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'apps/desktop/scripts/prepare-installed-update.ts',
        'collect', join(run.root, 'run.json'), journals], { cwd: resolve(import.meta.dirname, '../../..'), windowsHide: true,
        env: Object.fromEntries(Object.entries(process.env)
          .filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD|^NODE_OPTIONS$|^NODE_PATH$/iu.test(key))) })
      const output = JSON.parse(result.stdout) as { collection: string; operatorAcceptance: string }
      expect(output.operatorAcceptance).toBe('pending')
      expect(JSON.parse(await readFile(join(output.collection, 'report.json'), 'utf8'))).toMatchObject({
        evidence: { recordedFlow: 'incomplete', filesRead: 1 }, operatorAcceptance: 'pending',
      })
    })
  })
})
