/** Stand-in for the default output directory that proves a spec's providers never sweep it. */
import { access, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, expect } from 'vitest'

/**
 * Place an expired leftover in the store's own naming format under `home`'s default output directory, and require it
 * to survive every test in the calling spec. The spec must mock `dshHomePath` to resolve under `home`.
 * @param home - temporary directory standing in for `$DSH_HOME`; removed after the spec.
 */
export function expectDefaultOutputsUntouched(home: string): void {
  const leftover = join(home, 'office-kit', 'outputs', `session-${'0'.repeat(24)}`, '00000000-0000-4000-8000-000000000000')
  beforeAll(async () => {
    await mkdir(leftover, { recursive: true })
    await writeFile(join(leftover, 'sentinel.pdf'), '')
    const expired = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    await utimes(leftover, expired, expired)
  })
  afterAll(async () => {
    try { await expect(access(join(leftover, 'sentinel.pdf'))).resolves.toBeUndefined() }
    finally { await rm(home, { recursive: true, force: true }) }
  })
}
