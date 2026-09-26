/** Prepare one operator-owned firewall fault for an installed, independently verified qualification executable. */
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { readInstalledUpdateRun } from './installed-update-qualification.ts'
import { installedUpdateFileHash } from './installed-update-signature.mjs'

/**
 * Bind a local recovery plan to the version 1 executable hash from retained package verification.
 * @param manifest Original qualification run.json.
 * @param executable Absolute installed test application path, not the extracted verification payload.
 * @param receipt Successful version 1 package verification result.json.
 * @returns Exclusively created plan path; no credentials, subprocess, or firewall operation is involved.
 */
export async function prepareInstalledUpdateNetwork(manifest: string, executable: string, receipt: string): Promise<string> {
  const run = await readInstalledUpdateRun(manifest)
  const receiptRelative = relative(join(run.root, run.versions[0], 'verification'), resolve(receipt)).replaceAll('\\', '/')
  if (!/^check-[^/]+\/result\.json$/u.test(receiptRelative)) throw new Error('installed update: version 1 verification receipt is required')
  const result = JSON.parse(await readFile(receipt, 'utf8')) as {
    schemaVersion?: unknown
    runId?: unknown
    version?: unknown
    passed?: unknown
    applicationSignature?: { sha512?: unknown; valid?: unknown; timestamped?: unknown; updaterVerificationInvoked?: unknown }
    contents?: { appId?: unknown; version?: unknown }
  }
  const signature = result.applicationSignature
  if (result.schemaVersion !== 1 || result.runId !== run.id || result.version !== run.versions[0] || result.passed !== true
    || result.contents?.appId !== run.appId || result.contents.version !== run.versions[0]
    || signature?.valid !== true || signature.timestamped !== true || signature.updaterVerificationInvoked !== true
    || typeof signature.sha512 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/u.test(signature.sha512)) {
    throw new Error('installed update: successful identity and signature verification is required')
  }
  if (!isAbsolute(executable) || basename(executable) !== `${run.productName}.exe`
    || !(await lstat(executable)).isFile()) {
    throw new Error('installed update: installed test executable path or bytes do not match verification')
  }
  const installed = await realpath(executable)
  const insideRun = relative(await realpath(run.root), installed)
  if ((!insideRun.startsWith(`..${sep}`) && !isAbsolute(insideRun))
    || await installedUpdateFileHash(installed) !== signature.sha512) {
    throw new Error('installed update: installed test executable path or bytes do not match verification')
  }
  const directory = join(run.root, 'network-fault')
  await mkdir(directory)
  const path = join(directory, 'plan.json')
  await writeFile(path, `${JSON.stringify({ schemaVersion: 1, runId: run.id, executable: installed,
    sha512Hex: Buffer.from(signature.sha512, 'base64').toString('hex').toUpperCase(),
    ruleName: `DSH-Update-Qualification-${run.id}`, manifest: resolve(manifest), receipt: resolve(receipt),
    receiptSha512: await installedUpdateFileHash(receipt), networkChanged: false }, null, 2)}\n`, { flag: 'wx', flush: true })
  return path
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const [manifest, executable, receipt, ...extra] = process.argv.slice(2)
  if (!manifest || !executable || !receipt || extra.length) {
    console.error('usage: prepare-installed-update-network.ts <run.json> <installed-test.exe> <verification/result.json>')
    process.exitCode = 1
  } else prepareInstalledUpdateNetwork(manifest, executable, receipt).then(path => console.log(path)).catch(() => {
    console.error('installed update: network plan preparation failed; no network changes were made')
    process.exitCode = 1
  })
}
