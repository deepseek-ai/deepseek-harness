/** Explicit current-account migration and storage inspection under the signing-stage lock. */
import { parseArgs } from 'node:util'
import { loadDesktopPackageEnvironment } from './desktop-package-environment.mjs'
import { prepareWindowsSignatureCacheDirectory, resolveWindowsSignatureCacheDirectory } from './windows-signature-cache-directory.mjs'
import { maintainSignatureCache, migrateSignatureCache } from './windows-signature-cache.mjs'
import { withWindowsSigningStage } from './windows-signing-stage.mjs'

const { values } = parseArgs({ options: {
  from: { type: 'string' }, usage: { type: 'boolean' }, clear: { type: 'boolean' }, directory: { type: 'string' },
} })
if ([values.from !== undefined, values.usage === true, values.clear === true].filter(Boolean).length !== 1) {
  throw new Error('Specify exactly one of --from <old-cache>, --usage or --clear')
}
const environment = values.directory === undefined ? loadDesktopPackageEnvironment('win32')
  : { DSH_DESKTOP_WINDOWS_SIGNATURE_CACHE_DIR: values.directory }
const root = resolveWindowsSignatureCacheDirectory(environment)
const record = event => process.stdout.write(`${JSON.stringify(event)}\n`)
await withWindowsSigningStage({ stage: values.from !== undefined ? 'cache-migration' : 'cache-maintenance', record }, async () => {
  await prepareWindowsSignatureCacheDirectory(root)
  if (values.from !== undefined) {
    const source = resolveWindowsSignatureCacheDirectory({ DSH_DESKTOP_WINDOWS_SIGNATURE_CACHE_DIR: values.from })
    await prepareWindowsSignatureCacheDirectory(source, true)
    record({ type: 'signature-cache-migration-summary', ...await migrateSignatureCache({ source, root, record }) })
    return
  }
  record({ type: values.clear ? 'signature-cache-cleared' : 'signature-cache-usage', root,
    ...await maintainSignatureCache(root, values.clear) })
})
