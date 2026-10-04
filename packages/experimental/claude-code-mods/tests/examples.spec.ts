/**
 * The example mods' own `claude plugin test` files, run as this package's
 * spec so the coverage lane, which inventories `*.spec.ts` only, sees them.
 * Each file's outermost `describe` names the example directory the test kit
 * loads. The imports are computed so the Host typecheck project keeps the
 * published tests out of its file list.
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

for (const example of ['token-weather', 'blast-radius', 'replay-theater']) {
  await import(pathToFileURL(resolve(import.meta.dirname, '../examples', example, 'tests', `${example}.test.ts`)).href)
}
