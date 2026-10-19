/** Native backend checks for explicit directory grants and their denial cases. */
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'

function quote(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`
}

async function run(provider: LocalSandboxProvider, command: string, policy: SandboxPolicy) {
  const confined = await provider.confine(['bash', '-c', command], policy)
  const result = spawnSync(confined.argv[0]!, confined.argv.slice(1), { encoding: 'utf8', timeout: 30_000 })
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  return { ...result, denialSignatures: confined.denialSignatures }
}

/**
 * Check a native backend's explicit grant outside its temporary-directory grant.
 * @param provider - selected native sandbox backend.
 * @param directory - fixture allocator whose caller owns cleanup.
 * @returns completion after checking allowed, unrelated, and read-only writes.
 */
export async function checkExtraWrites(provider: LocalSandboxProvider, directory: (base: string) => Promise<string>): Promise<void> {
  const workspaceRoot = realpathSync.native(await directory(homedir()))
  const extra = realpathSync.native(await directory(homedir()))
  const outside = realpathSync.native(await directory(homedir()))
  const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot, additionalWritableRoots: [extra] }
  const allowed = join(extra, 'allowed.txt')
  const result = await run(provider, `printf allowed > ${quote(allowed)}`, policy)
  expect(result.status, result.stderr).toBe(0)
  expect(readFileSync(allowed, 'utf8')).toBe('allowed')
  const denied = join(outside, 'denied.txt')
  const rejected = await run(provider, `printf denied > ${quote(denied)}`, policy)
  expect(rejected.status).not.toBe(0)
  expect(rejected.denialSignatures.some(text => rejected.stderr.toLowerCase().includes(text))).toBe(true)
  expect(existsSync(denied)).toBe(false)
  const readOnly = join(extra, 'read-only.txt')
  expect((await run(provider, `printf denied > ${quote(readOnly)}`, { ...policy, mode: 'read-only' })).status).not.toBe(0)
  expect(existsSync(readOnly)).toBe(false)
}

/**
 * Check that a confined command cannot redirect a later grant by replacing its directory.
 * @param provider - selected native sandbox backend.
 * @param directory - fixture allocator whose caller owns cleanup.
 * @returns completion after verifying replacement is rejected before an outside write.
 */
export async function checkRedirectedRoot(provider: LocalSandboxProvider, directory: (base: string) => Promise<string>): Promise<void> {
  const workspaceRoot = realpathSync.native(await directory(homedir()))
  const outside = realpathSync.native(await directory(homedir()))
  const extra = join(workspaceRoot, 'extra')
  mkdirSync(extra)
  const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot, additionalWritableRoots: [extra] }
  const replaced = await run(provider, `rmdir ${quote(extra)} && ln -s ${quote(outside)} ${quote(extra)}`, policy)
  const target = join(outside, 'escape.txt')
  if (replaced.status === 0) {
    expect(lstatSync(extra).isSymbolicLink()).toBe(true)
    await expect(run(provider, `printf denied > ${quote(target)}`, policy)).rejects.toMatchObject({ code: 'SANDBOX_INVALID_ROOT' })
  } else {
    // bwrap protects the bind mount itself, before the next-call path check.
    expect(lstatSync(extra).isDirectory()).toBe(true)
    expect(lstatSync(extra).isSymbolicLink()).toBe(false)
    expect((await run(provider, `printf allowed > ${quote(join(extra, 'still-granted.txt'))}`, policy)).status).toBe(0)
    const denied = await run(provider, `printf denied > ${quote(target)}`, policy)
    expect(denied.status).not.toBe(0)
    expect(denied.denialSignatures.some(text => denied.stderr.toLowerCase().includes(text))).toBe(true)
  }
  expect(existsSync(target)).toBe(false)
}
