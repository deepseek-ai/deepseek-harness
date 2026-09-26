import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createPackagingRun, packagingOutputRedactor } from '../scripts/packaging-run.mjs'

const environment = Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => !/KEY|SECRET|TOKEN|PASSWORD|^NODE_OPTIONS$/iu.test(name)))

describe('packaging run records', () => {
  it('redacts credential values across every byte split', () => {
    const secret = 'test-口令-!secret'
    const bytes = Buffer.from(`before ${secret} after`)
    for (let split = 0; split <= bytes.length; split++) {
      let output = ''
      const redactor = packagingOutputRedactor([secret], (text) => { output += text })
      redactor.write(bytes.subarray(0, split))
      redactor.write(bytes.subarray(split))
      redactor.end()
      expect(output).toBe('before [REDACTED] after')
    }
  })

  it('retains redacted output and prevents a later stage after a failed child', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-package-record-'))
    try {
      const run = createPackagingRun(root, { target: 'fixture' })
      await expect(run.run('failure', process.execPath, ['-e', "process.stdout.write(process.env.TEST_SECRET_KEY);process.stderr.write('fixture failure');process.exitCode=1"], {
        cwd: root, env: { ...environment, TEST_SECRET_KEY: 'test-secret-value' },
      })).rejects.toThrow('failure failed')
      await expect(run.run('not-started', process.execPath, ['--version'], { cwd: root, env: environment })).rejects.toThrow('run is blocked')
      run.finish(false)
      expect(await readFile(join(run.directory, 'stdout.log'), 'utf8')).toBe('[REDACTED]')
      expect(await readFile(join(run.directory, 'stderr.log'), 'utf8')).toBe('fixture failure')
      const events = await readFile(join(run.directory, 'events.jsonl'), 'utf8')
      expect(events).toContain('stage-end')
      expect(events).not.toContain('not-started')
      expect(JSON.parse(await readFile(join(run.directory, 'result.json'), 'utf8'))).toMatchObject({ success: false })
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('kills the stage and its descendant on a fatal marker before either exits voluntarily', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-package-tree-'))
    try {
      const run = createPackagingRun(root, {})
      await expect(run.run('fatal', process.execPath, [resolve(import.meta.dirname, 'fixtures/packaging-failure.mjs')], {
        cwd: root, env: environment,
      })).rejects.toThrow('fatal failed')
      const descendant = JSON.parse(await readFile(join(run.directory, 'descendant.json'), 'utf8')) as { pid: number }
      // Linux can retain a dead descendant as a zombie until its new parent reaps it.
      await expect.poll(async () => {
        try {
          if (process.platform === 'linux') {
            const status = await readFile(`/proc/${descendant.pid}/status`, 'utf8')
            return /^State:\s+[ZXx]\b/m.test(status)
          }
          process.kill(descendant.pid, 0)
          return false
        } catch (error) {
          if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return true
          throw error
        }
      }, { timeout: 5_000 }).toBe(true)
      const events = (await readFile(join(run.directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { type: string; fatalObserved?: boolean; terminationError?: boolean })
      expect(events.at(-1)).toMatchObject({ type: 'stage-end', fatalObserved: true, terminationError: false })
      run.finish(false)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('fails closed when the output journal cannot be written', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-package-log-failure-'))
    try {
      const run = createPackagingRun(root, {})
      await rm(join(run.directory, 'stdout.log'))
      await mkdir(join(run.directory, 'stdout.log'))
      await expect(run.run('output', process.execPath, ['-e', "process.stdout.write('fixture');setInterval(()=>{},1000)"], {
        cwd: root, env: environment,
      })).rejects.toThrow('output failed')
      run.finish(false)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('records successful stages without creating a release completion record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-package-success-'))
    try {
      const run = createPackagingRun(root, {})
      await run.run('version', process.execPath, ['--version'], { cwd: root, env: environment })
      run.finish(true)
      expect(JSON.parse(await readFile(join(run.directory, 'result.json'), 'utf8'))).toMatchObject({ success: true })
      expect(await readFile(join(run.directory, 'events.jsonl'), 'utf8')).toContain('stage-spawn')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('records a stage deadline separately from child exit and refuses subsequent stages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-package-deadline-'))
    try {
      const run = createPackagingRun(root, {})
      await expect(run.run('deadline', process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        cwd: root, env: environment, timeoutMs: 50,
      })).rejects.toThrow('deadline failed')
      const events = (await readFile(join(run.directory, 'events.jsonl'), 'utf8')).trim().split('\n')
        .map(line => JSON.parse(line) as { type: string; childPid?: number })
      expect(events.at(-1)).toMatchObject({ type: 'stage-end', timedOut: true, fatalObserved: true, terminationError: false })
      expect(() => process.kill(events.find(row => row.type === 'stage-spawn')!.childPid!, 0)).toThrow()
      await expect(run.run('later', process.execPath, ['--version'], { cwd: root, env: environment })).rejects.toThrow('blocked')
      run.finish(false)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})

it('allows parallel Mac stages, attributes their output, and refuses finish until both settle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-parallel-log-'))
  try {
    const run = createPackagingRun(root, { target: 'mac-fixture' }, { parallel: true, secrets: ['removed-p12-password'] })
    const script = "process.stdout.write(process.argv[1]+' removed-p12-password')"
    const first = run.run('app', process.execPath, ['-e', script, 'app'], { cwd: root, env: environment })
    const second = run.run('dmg', process.execPath, ['-e', script, 'dmg'], { cwd: root, env: environment })
    const settled = Promise.allSettled([first, second])
    try { expect(() => { run.finish(true) }).toThrow('active run') } finally { await settled }
    const results = await settled
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'fulfilled'])
    run.finish(true)
    const log = await readFile(join(run.directory, 'events.jsonl'), 'utf8')
    const events = log.trim().split('\n').map(line => JSON.parse(line) as { type: string; stage: string; text?: string })
    expect(events.filter(event => event.type === 'stage-start' || event.type === 'stage-end').slice(0, 2).map(event => event.type))
      .toEqual(['stage-start', 'stage-start'])
    expect(events.filter(event => event.type === 'output').map(event => event.stage).sort()).toEqual(['app', 'dmg'])
    expect(log).not.toContain('removed-p12-password')
    expect(events.filter(event => event.type === 'output').every(event => event.text?.includes('[REDACTED]'))).toBe(true)
    const summary = JSON.parse(await readFile(join(run.directory, 'result.json'), 'utf8')) as { stages: unknown[]; elapsedMs: number }
    expect(summary).toMatchObject({ success: true, proxy: 'not-used' })
    expect(typeof summary.elapsedMs).toBe('number')
    expect(summary.stages).toHaveLength(2)
  } finally { await rm(root, { recursive: true, force: true }) }
})
