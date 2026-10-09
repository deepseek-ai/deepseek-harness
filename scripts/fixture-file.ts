/** File creation shared by repository scanner fixtures. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Write a text or JSON fixture, creating its containing directories.
 * @param root - Owning temporary fixture directory.
 * @param path - Path relative to that directory.
 * @param value - Literal text or JSON-serializable fixture value.
 */
export function writeFixtureFile(root: string, path: string, value: unknown): void {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, typeof value === 'string' ? value : `${JSON.stringify(value)}\n`)
}
