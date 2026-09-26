/** Verify signed installer bytes and extract their payload without running any installer or signing operation. */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { readInstalledUpdateRun } from './installed-update-qualification.ts'
import { planInstalledUpdateDistribution } from './installed-update-distribution.ts'
import { installedUpdateFileHash, verifyInstalledUpdateSignature } from './installed-update-signature.mjs'
import { resolveWindowsUpdatePublisher } from './windows-sign.mjs'
import { verifyInstalledUpdatePackageContent } from './installed-update-package-content.ts'
import { recordPackagingEvent } from './packaging-run.mjs'

/**
 * Reject nonrelative archive names and link entries before extraction into a new directory.
 * @param listing The pinned 7-Zip's UTF-8 technical listing, with archive headers suppressed.
 * @returns Number of relative archive entries; rejects empty or unsafe listings.
 */
export function validateInstalledUpdateArchivePaths(listing: string): number {
  const paths = [...listing.matchAll(/^Path = (.+)\r?$/gmu)].map(match => match[1]!.replace(/\r$/u, '').replaceAll('\\', '/'))
  if (paths.length === 0 || /^(?:Symbolic Link|Hard Link|Reparse Point) = .+/mu.test(listing)
    || /^Attributes = .*\blrwx/mu.test(listing)) throw new Error('installed update: archive links or missing entries are not accepted')
  const seen = new Set<string>()
  for (const path of paths) {
    if (seen.has(path.toLowerCase())) throw new Error('installed update: archive contains duplicate Windows paths')
    seen.add(path.toLowerCase())
    if (/[\x00-\x1f:*?"<>|]/u.test(path) || path.split('/').some(part => part === '' || part === '.' || part === '..'
      || /[. ]$/u.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(part))) {
      throw new Error('installed update: archive contains an unsafe path')
    }
  }
  return paths.length
}

/**
 * Produce retained signature, extraction, and content evidence for one final installer.
 * @param manifest Original test run.
 * @param version One exact run version.
 * @param certificate Trusted public certificate; no .env or PIN is read.
 * @param archiveTool Reviewed local 7-Zip executable, never an executable extracted from this installer.
 * @returns Result path; failure retains partial records and never reports a passed package.
 */
export async function verifyInstalledUpdatePackage(
  manifest: string, version: string, certificate: string, archiveTool: string,
): Promise<string> {
  const run = await readInstalledUpdateRun(manifest)
  if (!run.versions.includes(version)) throw new Error('installed update: verification version is outside the run')
  const parent = join(run.root, version, 'verification')
  await mkdir(parent, { recursive: true })
  const record = await mkdtemp(join(parent, 'check-'))
  const result: Record<string, unknown> = { schemaVersion: 1, runId: run.id, version, passed: false,
    installerExecuted: false, published: false, manualChecks: ['installer-registration', 'startup', 'upgrade', 'data-retention'] }
  const stage = (name: string): void => { result.stage = name; recordPackagingEvent(record, { type: 'verification-stage', stage: name }) }
  console.log(`INSTALLED_UPDATE_VERIFICATION_RECORD ${record}`)
  try {
    stage('local-file-plan')
    const plan = await planInstalledUpdateDistribution(manifest, version)
    const installer = plan.binaries[0]!.path
    const publisher = resolveWindowsUpdatePublisher(certificate)
    const toolHash = await installedUpdateFileHash(archiveTool)
    const certificateSha512 = await installedUpdateFileHash(certificate)
    const manifestSha512 = await installedUpdateFileHash(manifest)
    await writeFile(join(record, 'inputs.json'), `${JSON.stringify({ manifestSha512, distribution: plan,
      certificate, certificateSha512, archiveTool, toolHash })}\n`, { flag: 'wx', flush: true })
    await mkdir(join(record, 'installer-signature'))
    stage('installer-signature')
    result.installerSignature = await verifyInstalledUpdateSignature(installer, publisher, join(record, 'installer-signature'))
    const environment = Object.fromEntries(Object.entries(process.env)
      .filter(([name]) => !/KEY|SECRET|TOKEN|PASSWORD|^NODE_OPTIONS$|^NODE_PATH$/iu.test(name)))
    const execute = (args: string[]) => promisify(execFile)(archiveTool, args, {
      env: environment, cwd: record, windowsHide: true, encoding: 'utf8' as const, timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
    })
    stage('archive-paths')
    const listing = await execute(['l', '-slt', '-ba', '-sccUTF-8', '--', installer])
    await writeFile(join(record, 'archive-list.txt'), listing.stdout, { flag: 'wx', flush: true })
    result.archiveEntries = validateInstalledUpdateArchivePaths(listing.stdout)
    const payload = join(record, 'payload')
    await mkdir(payload)
    stage('extraction')
    const extraction = await execute(['x', '-y', '-bd', '-bso0', '-bsp0', `-o${payload}`, '--', installer])
    await writeFile(join(record, 'extraction.log'), `${extraction.stdout}\n${extraction.stderr}`, { flag: 'wx', flush: true })
    stage('payload-content')
    const contents = await verifyInstalledUpdatePackageContent(manifest, version, payload, publisher)
    result.contents = contents
    await mkdir(join(record, 'application-signature'))
    stage('application-signature')
    result.applicationSignature = await verifyInstalledUpdateSignature(join(payload, `${run.productName}.exe`),
      publisher, join(record, 'application-signature'))
    const runtimeSignatures: object[] = []
    result.runtimeSignatures = runtimeSignatures
    for (const [index, path] of contents.resignedExecutables.entries()) {
      stage(`runtime-signature-${index}`)
      const directory = join(record, `runtime-signature-${index}`)
      await mkdir(directory)
      runtimeSignatures.push({ path, ...await verifyInstalledUpdateSignature(path, publisher, directory) })
    }
    stage('unchanged-inputs')
    if (await installedUpdateFileHash(installer) !== plan.binaries[0]!.sha512
      || await installedUpdateFileHash(archiveTool) !== toolHash || await installedUpdateFileHash(certificate) !== certificateSha512
      || await installedUpdateFileHash(manifest) !== manifestSha512
      || JSON.stringify(await planInstalledUpdateDistribution(manifest, version)) !== JSON.stringify(plan)) {
      throw new Error('installed update: verification input changed')
    }
    stage('complete')
    result.passed = true
    return join(record, 'result.json')
  } catch (error) {
    result.failure = error instanceof Error ? error.message : 'verification failed'
    throw error
  } finally {
    await writeFile(join(record, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', flush: true })
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const [manifest, version, certificate, archiveTool, ...extra] = process.argv.slice(2)
  if (!manifest || !version || !certificate || !archiveTool || extra.length !== 0) {
    console.error('usage: verify-installed-update-package.ts <run.json> <version> <public.cer> <reviewed-7za.exe>')
    process.exitCode = 1
  } else {
    verifyInstalledUpdatePackage(manifest, version, certificate, archiveTool).then(path => console.log(path)).catch(() => {
      console.error('installed update: package verification failed; inspect the retained record. No installer was executed.')
      process.exitCode = 1
    })
  }
}
