/** Internal builder child; requires its live parent's version-scoped packaging record and never publishes. */
import { readFile, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readInstalledUpdateRun } from './installed-update-qualification.ts'
import { assertInstalledUpdateSigningClear } from './installed-update-packaging.ts'
import { createInstalledUpdateBuilderConfig } from './installed-update-builder.ts'
import { packagingOutputRedactor } from './packaging-run.mjs'

try {
  const [manifest, version, ...extra] = process.argv.slice(2)
  if (!manifest || !version || extra.length !== 0) throw new Error('invalid worker arguments')
  const run = await readInstalledUpdateRun(manifest)
  const record = await realpath(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR ?? '')
  if (dirname(record) !== await realpath(join(run.root, version, 'packaging'))) throw new Error('wrong packaging record directory')
  const metadata = JSON.parse(await readFile(join(record, 'run.json'), 'utf8'))
  if (metadata.mode !== 'operator-authorized-single-version' || metadata.id !== run.id
    || metadata.version !== version || metadata.pid !== process.ppid) throw new Error('worker is not owned by the authorized parent')
  await assertInstalledUpdateSigningClear()
  const config = await createInstalledUpdateBuilderConfig(manifest, version, process.env)
  const { build, Platform, Arch } = await import('electron-builder')
  await build({ projectDir: join(import.meta.dirname, '..'), config,
    targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64), publish: 'never' })
} catch (error) {
  const redactor = packagingOutputRedactor(Object.entries(process.env)
    .filter(([name]) => /KEY|SECRET|TOKEN|PASSWORD/iu.test(name)).map(([, value]) => value ?? ''), text => process.stderr.write(text))
  redactor.write(Buffer.from(error instanceof Error ? `${error.stack ?? error.message}\n` : 'installed update: builder worker failed\n'))
  redactor.end()
  process.exitCode = 1
}
