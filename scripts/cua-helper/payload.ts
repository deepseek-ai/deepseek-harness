/** Integrity and source binding for notarized Computer Use applications consumed by npm packaging. */
import { createHash } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

/** Architectures carried by each published macOS provider package. */
export const CUA_ARCHITECTURES = ['arm64', 'x64'] as const
/** Native application name shared with the provider receipt. */
export const CUA_APPLICATION = 'DSH Computer Use.app'
/** Completion record written only after both applications pass distribution checks. */
export const CUA_MANIFEST = 'cua-helper.json'
const Digest = z.string().regex(/^[a-f0-9]{64}$/u)
const Manifest = z.object({
  schemaVersion: z.literal(1), version: z.string().min(1), commit: z.string().regex(/^[a-f0-9]{40}$/u),
  teamId: z.string().regex(/^[A-Z0-9]{10}$/u),
  applications: z.array(z.object({ architecture: z.enum(CUA_ARCHITECTURES), bundle: Digest }).strict()).length(2),
}).strict()
/** Verified build identity and application generations. */
export type CuaHelperManifest = z.infer<typeof Manifest>

/**
 * Hash application-relative file names, bytes and executable bits, matching build_app.py.
 * @param application - Real application directory; links and special files are rejected.
 * @returns SHA-256 of the complete application, including its notarization ticket.
 */
export function cuaApplicationDigest(application: string): string {
  const root = lstatSync(application)
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('CUA application must be a real directory')
  const files: string[] = []
  const visit = (directory: string): void => {
    for (const name of readdirSync(join(application, directory))) {
      const path = directory ? `${directory}/${name}` : name
      const stat = lstatSync(join(application, path))
      if (stat.isDirectory()) visit(path)
      else if (stat.isFile()) files.push(path)
      else throw new Error(`CUA application contains a link or special file: ${path}`)
    }
  }
  visit('')
  const digest = createHash('sha256')
  for (const path of files.sort()) {
    const file = join(application, path)
    digest.update(`${path}\0`).update(createHash('sha256').update(readFileSync(file)).digest())
      .update(Buffer.from([(lstatSync(file).mode & 0o111) === 0 ? 0 : 1]))
  }
  return digest.digest('hex')
}

/**
 * Select the complete signed application and validate its immutable receipt.
 * @param directory - One architecture's native/bin directory.
 * @returns Selected application path and its content digest.
 */
export function readCuaApplication(directory: string): { application: string; bundle: string } {
  if (!lstatSync(directory).isDirectory() || !lstatSync(join(directory, 'current.json')).isFile()) throw new Error('CUA receipt requires regular files and directories')
  const { bundle } = z.object({ bundle: Digest }).strict().parse(JSON.parse(readFileSync(join(directory, 'current.json'), 'utf8')))
  if (!lstatSync(join(directory, bundle)).isDirectory()) throw new Error('CUA generation must be a real directory')
  const application = join(directory, bundle, CUA_APPLICATION)
  for (const path of ['Contents/Info.plist', 'Contents/MacOS/dsh-cua-native', 'Contents/Resources/DSHComputerUse.icns', 'Contents/_CodeSignature/CodeResources']) {
    if (!lstatSync(join(application, path)).isFile()) throw new Error(`CUA application omits ${path}`)
  }
  if ((lstatSync(join(application, 'Contents/MacOS/dsh-cua-native')).mode & 0o111) === 0) throw new Error('CUA helper is not executable')
  if (cuaApplicationDigest(application) !== bundle) throw new Error('CUA application digest does not match current.json')
  if (readdirSync(directory).sort().join(',') !== [bundle, 'current.json'].sort().join(',')) throw new Error('CUA release contains unselected application generations')
  return { application, bundle }
}

/**
 * Reselect a build after notarization has added its ticket, before distribution.
 * @param directory - Fresh, build-owned architecture directory.
 * @param application - Application just notarized and verified by the producer.
 * @returns Final content digest; old build receipts are replaced.
 */
export function sealCuaApplication(directory: string, application: string): string {
  const bundle = cuaApplicationDigest(application)
  const destination = join(directory, bundle, CUA_APPLICATION)
  if (destination !== application) {
    mkdirSync(join(directory, bundle))
    renameSync(application, destination)
    for (const name of readdirSync(directory)) {
      if (name !== bundle && name !== 'current.json') rmSync(join(directory, name), { recursive: true, force: true })
    }
  }
  writeFileSync(join(directory, 'current.json'), `${JSON.stringify({ bundle })}\n`)
  readCuaApplication(directory)
  return bundle
}

/**
 * Verify the producer record and every final application before copying or packing.
 * @param root - Extracted helper artifact containing native/bin and cua-helper.json.
 * @param expected - Source commit and product version of the consuming checkout.
 * @returns Validated producer metadata.
 */
export function verifyCuaHelperPayload(root: string, expected: { version: string; commit: string }): CuaHelperManifest {
  const manifest = Manifest.parse(JSON.parse(readFileSync(join(root, CUA_MANIFEST), 'utf8')))
  if (manifest.version !== expected.version || manifest.commit !== expected.commit) throw new Error('CUA artifact does not match the release source and version')
  if (new Set(manifest.applications.map(entry => entry.architecture)).size !== 2) throw new Error('CUA artifact must contain arm64 and x64')
  const bin = join(root, 'native/bin')
  if (readdirSync(bin).sort().join(',') !== 'darwin-arm64,darwin-x64') throw new Error('CUA artifact has unexpected architecture directories')
  for (const entry of manifest.applications) {
    const { bundle } = readCuaApplication(join(bin, `darwin-${entry.architecture}`))
    if (bundle !== entry.bundle) throw new Error('CUA application differs from the producer manifest')
  }
  return manifest
}

/**
 * Stage verified native applications for the provider's ordinary pnpm pack command.
 * @param root - Extracted helper artifact.
 * @param packageRoot - Provider package to receive native/bin.
 * @param expected - Source identity required by the release.
 */
export function stageCuaHelperPayload(root: string, packageRoot: string, expected: { version: string; commit: string }): void {
  verifyCuaHelperPayload(root, expected)
  const destination = join(packageRoot, 'native/bin')
  if (existsSync(destination)) throw new Error('CUA staging requires an empty native/bin; use a clean release checkout')
  cpSync(join(root, 'native/bin'), destination, { recursive: true })
  cpSync(join(root, CUA_MANIFEST), join(packageRoot, CUA_MANIFEST))
}
