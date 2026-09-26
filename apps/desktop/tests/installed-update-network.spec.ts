import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { createInstalledUpdateRun } from '../scripts/installed-update-qualification.ts'
import { prepareInstalledUpdateNetwork } from '../scripts/prepare-installed-update-network.ts'
import { installedUpdateFileHash } from '../scripts/installed-update-signature.mjs'

async function fixture(body: (manifest: string, executable: string, receipt: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-network-plan-试验-'))
  try {
    const run = await createInstalledUpdateRun(root, ['0.1.6-nightly.20260914.1', '0.1.6-nightly.20260914.2'],
      { version: '0.1.5-rc.2', commit: 'a'.repeat(40), dirtyFiles: [] })
    const executable = join(root, `${run.productName}.exe`)
    await writeFile(executable, 'inert app fixture, never executed')
    const directory = join(run.root, run.versions[0], 'verification/check-fixture')
    await mkdir(directory, { recursive: true })
    const receipt = join(directory, 'result.json')
    await writeFile(receipt, JSON.stringify({ schemaVersion: 1, runId: run.id, version: run.versions[0], passed: true,
      contents: { appId: run.appId, version: run.versions[0] }, applicationSignature: {
        valid: true, timestamped: true, updaterVerificationInvoked: true, sha512: await installedUpdateFileHash(executable),
      } }))
    await body(join(run.root, 'run.json'), executable, receipt)
  } finally { await rm(root, { recursive: true, force: true }) }
}

describe('installed update network plan', () => {
  it('binds an exclusive local plan to verified original application bytes without network changes', async () => {
    await fixture(async (manifest, executable, receipt) => {
      const plan = await prepareInstalledUpdateNetwork(manifest, executable, receipt)
      expect(JSON.parse(await readFile(plan, 'utf8'))).toMatchObject({ executable: await realpath(executable),
        sha512Hex: Buffer.from(await installedUpdateFileHash(executable), 'base64').toString('hex').toUpperCase(), networkChanged: false })
      await expect(prepareInstalledUpdateNetwork(manifest, executable, receipt)).rejects.toMatchObject({ code: 'EEXIST' })
    })
  })

  it.each(['failed-receipt', 'wrong-run', 'wrong-version', 'invalid-signature', 'changed-file', 'renamed-file', 'outside-receipt'])(
    'rejects %s before creating a fault plan', async (failure) => {
      await fixture(async (manifest, executable, receipt) => {
        const data = JSON.parse(await readFile(receipt, 'utf8')) as {
          passed: boolean
          runId: string
          version: string
          applicationSignature: { valid: boolean }
        }
        if (failure === 'failed-receipt') data.passed = false
        if (failure === 'wrong-run') data.runId = 'b'.repeat(24)
        if (failure === 'wrong-version') data.version = '0.1.6-nightly.20260914.2'
        if (failure === 'invalid-signature') data.applicationSignature.valid = false
        if (failure === 'changed-file') await writeFile(executable, 'changed')
        if (failure === 'renamed-file') executable = join(executable, '../ordinary-app.exe')
        if (failure === 'outside-receipt') receipt = join(receipt, '../outside.json')
        await writeFile(receipt, JSON.stringify(data))
        await expect(prepareInstalledUpdateNetwork(manifest, executable, receipt)).rejects.toThrow()
        expect(await readdir(join(manifest, '..'))).not.toContain('network-fault')
      })
    })
})

describe.runIf(process.platform === 'win32')('operator firewall script with all firewall cmdlets substituted', () => {
  it.each(['block', 'creation-failure', 'existing', 'foreign', 'declined', 'changed', 'changed-during-confirmation',
    'restore', 'restore-absent', 'restore-failure', 'restore-declined', 'status'])(
    'records %s without touching host firewall state', async (scenario) => {
      await fixture(async (manifest, executable, receipt) => {
        const plan = await prepareInstalledUpdateNetwork(manifest, executable, receipt)
        if (scenario === 'changed') await writeFile(executable, 'changed after plan')
        if (scenario === 'restore') await rm(executable)
        const environment = Object.fromEntries(Object.entries(process.env)
          .filter(([name]) => !/KEY|SECRET|TOKEN|PASSWORD|^PSModulePath$|^NODE_OPTIONS$/iu.test(name)))
        const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
          resolve(import.meta.dirname, 'fixtures/installed-update-network.ps1'), '-Script',
          resolve(import.meta.dirname, '../scripts/installed-update-network.ps1'), '-Plan', plan, '-Case', scenario],
        { env: environment, encoding: 'utf8', windowsHide: true, timeout: 20_000 })
        const result = JSON.parse(stdout.trim().split(/\r?\n/u).at(-1)!) as {
          failure: string | null
          created: number
          removed: number
          remaining: number
        }
        expect(result.created, JSON.stringify(result)).toBe(['block', 'creation-failure'].includes(scenario) ? 1 : 0)
        expect(result.removed).toBe(['restore', 'restore-failure'].includes(scenario) ? 1 : 0)
        expect(result.failure === null).toBe(['block', 'restore', 'restore-absent', 'status'].includes(scenario))
        expect(result.remaining).toBe(['block', 'existing', 'foreign', 'restore-failure', 'restore-declined', 'status'].includes(scenario) ? 1 : 0)
        const records = join(plan, '../records')
        const entries = await readdir(records)
        expect(entries).toHaveLength(1)
        const lines = (await readFile(join(records, entries[0]!, 'events.jsonl'), 'utf8')).trim().split('\n')
        expect(JSON.parse(lines.at(-1)!)).toMatchObject({ stage: 'finished', data: { success: result.failure === null } })
        if (scenario === 'creation-failure') expect(lines.some(line => line.includes('removing-rule'))).toBe(false)
      })
    })
})
