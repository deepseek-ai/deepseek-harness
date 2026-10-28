/** Per-test executable identity for the shared native protocol fixture. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
export { startFixtureHost } from '../../../../snapshots/session/cua-native/fixture-host.mjs'

/**
 * Copy the native fixture with an identity unique to the caller's temporary directory.
 * @param root - Existing test-owned temporary directory.
 * @returns Executable path for the provider configuration.
 */
export async function installNativeFixture(root: string): Promise<string> {
  const helperPath = join(root, 'native-helper.mjs')
  const source = await readFile(new URL('../../../../snapshots/session/cua-native/workspace/native-helper.mjs', import.meta.url), 'utf8')
  await writeFile(helperPath, `${source}\n// Fixture directory: ${JSON.stringify(root)}\n`, { mode: 0o700 })
  return helperPath
}
