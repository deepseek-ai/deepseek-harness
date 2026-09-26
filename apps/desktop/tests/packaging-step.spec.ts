import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createPackagingRun, recordPackagingEvent } from '../scripts/packaging-run.mjs'
import { packagingStep } from '../scripts/packaging-step.mjs'

it('retains nested failures without credentials and includes the restored proxy in the final summary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'packaging-step-'))
  try {
    const run = createPackagingRun(root, { target: 'fixture' })
    const work = packagingStep(run.directory, 'notarization', async () => {
      throw new AggregateError([new Error('secret-sentinel'), new Error('outer', { cause: new Error('secret-sentinel') })], 'Apple refused')
    }, ['secret-sentinel'])
    await expect(work).rejects.toThrow('Apple refused')
    recordPackagingEvent(run.directory, { type: 'notarization-proxy', status: 'restored' })
    run.finish(false)
    const events = await readFile(join(run.directory, 'events.jsonl'), 'utf8')
    const summary = await readFile(join(run.directory, 'result.json'), 'utf8')
    expect(events).toContain('[REDACTED]')
    expect(events).toContain('outer')
    expect(events).not.toContain('secret-sentinel')
    expect(summary).not.toContain('secret-sentinel')
    expect(JSON.parse(summary)).toMatchObject({ success: false, proxy: 'restored', stages: [{ stage: 'notarization', success: false }] })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('preserves unrecorded callers and records successful return values without persisting them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'packaging-step-result-'))
  try {
    const run = createPackagingRun(root, {})
    expect(await packagingStep(undefined, 'plain', async () => 42)).toBe(42)
    expect(await packagingStep(run.directory, 'logged', async () => 'private-return-value')).toBe('private-return-value')
    run.finish(true)
    const events = await readFile(join(run.directory, 'events.jsonl'), 'utf8')
    expect(events).toContain('"success":true')
    expect(events).not.toContain('private-return-value')
  } finally { await rm(root, { recursive: true, force: true }) }
})
