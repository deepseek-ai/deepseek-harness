/** Build company-signed, notarized CUA applications using the existing macOS packaging credentials. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { execa } from 'execa'
import { create, extract } from 'tar'
import { loadDesktopPackageEnvironment } from '../../apps/desktop/scripts/desktop-package-environment.mjs'
import { resolveMacOSNotarizationEnvironment, resolveMacOSSigningEnvironment } from '../../apps/desktop/scripts/desktop-release-environment.mjs'
import { withMacOSSigningKeychain } from '../../apps/desktop/scripts/macos-signing-keychain.mjs'
import { withMacOSNotarizationProxy } from '../../apps/desktop/scripts/macos-notarization-proxy.ts'
import { resolveMacOSPackageSettings } from '../../apps/desktop/scripts/macos-package-settings.mjs'
import { notarizeMacOS } from '../../apps/desktop/scripts/notarize-macos.mjs'
import { verifyMacOSRuntimeCode } from '../../apps/desktop/scripts/verify-macos-signature.mjs'
import { CUA_APPLICATION, CUA_ARCHITECTURES, CUA_MANIFEST, readCuaApplication, sealCuaApplication, verifyCuaHelperPayload, type CuaHelperManifest } from './payload.ts'

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { out: { type: 'string' } }, allowPositionals: false })
  if (process.platform !== 'darwin' || !values.out) throw new Error('Usage on macOS: package.ts --out <new-output-directory>')
  const root = resolve(import.meta.dirname, '../..')
  const output = resolve(values.out)
  const environment = loadDesktopPackageEnvironment('darwin')
  const signing = resolveMacOSSigningEnvironment(environment)
  const notary = resolveMacOSNotarizationEnvironment(environment)
  const settings = resolveMacOSPackageSettings(environment)
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  mkdirSync(output, { recursive: false })
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-cua-package-'))
  const controller = new AbortController()
  const stop = (): void => { controller.abort() }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  const run = async (command: string, args: string[], env = environment): Promise<void> => {
    await execa(command, args, { cwd: root, env, extendEnv: false, stdio: 'inherit', cancelSignal: controller.signal, killDescendants: true })
  }
  const verify = async (application: string, architecture: 'arm64' | 'x64'): Promise<void> => {
    verifyMacOSRuntimeCode(application, signing)
    await run('/usr/bin/lipo', ['-verify_arch', architecture === 'x64' ? 'x86_64' : 'arm64', join(application, 'Contents/MacOS/dsh-cua-native')])
    await run('/usr/bin/xcrun', ['stapler', 'validate', application])
    await run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', application])
  }
  try {
    const payload = join(scratch, 'payload')
    const applications: CuaHelperManifest['applications'] = []
    await withMacOSSigningKeychain(environment, async (signingEnvironment) => {
      for (const architecture of CUA_ARCHITECTURES) {
        controller.signal.throwIfAborted()
        const directory = join(payload, 'native/bin', `darwin-${architecture}`)
        await run('/usr/bin/xcrun', ['python3', join(root, 'packages/experimental/cua-macos/native/build_app.py'),
          '--arch', architecture === 'x64' ? 'x86_64' : 'arm64', '--scratch-path', join(scratch, `swift-${architecture}`),
          '--output-directory', directory, '--identity', `Developer ID Application: ${signing.signingIdentity}`], signingEnvironment)
        const { application } = readCuaApplication(directory)
        await withMacOSNotarizationProxy(settings.notarizationProxy, () => notarizeMacOS({ appPath: application, ...notary }))
        await verify(application, architecture)
        applications.push({ architecture, bundle: sealCuaApplication(directory, application) })
      }
    })
    const manifest: CuaHelperManifest = { schemaVersion: 1, version, commit, teamId: signing.teamId, applications }
    writeFileSync(join(payload, CUA_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)
    verifyCuaHelperPayload(payload, { version, commit })
    const archive = join(output, 'cua-helper.tgz')
    await create({ cwd: payload, file: archive, gzip: true, portable: true }, [CUA_MANIFEST, 'native'])
    const extracted = join(scratch, 'extracted')
    mkdirSync(extracted)
    await extract({ cwd: extracted, file: archive, strict: true })
    verifyCuaHelperPayload(extracted, { version, commit })
    for (const { architecture, bundle } of applications) {
      const application = join(extracted, 'native/bin', `darwin-${architecture}`, bundle, CUA_APPLICATION)
      await verify(application, architecture)
    }
    writeFileSync(join(output, CUA_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)
    console.log(`CUA helper artifact: ${archive}`)
  } catch (error) {
    rmSync(join(output, 'cua-helper.tgz'), { force: true })
    throw error
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    rmSync(scratch, { recursive: true, force: true })
  }
}

await main()
