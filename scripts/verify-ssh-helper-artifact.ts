/** Unpack and run a release archive through the actual Loader-mounted SSH consumers. */
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { extract, list } from 'tar'
import { fileDigest, runtimeReportSchema, verifyPayload, type ArtifactManifest } from './ssh-helper/artifact.ts'
import { probeRestrictedWorker } from './ssh-helper/worker-probe.ts'
import { verifyNativePayload } from './ssh-helper/native.ts'

const root = resolve(import.meta.dirname, '..')
const fixtures = join(root, 'packages/ssh/ssh-helper-runtime/tests/fixtures')

async function directoryPermissions(directory: string, mode: number): Promise<void> {
  await chmod(directory, mode)
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await directoryPermissions(join(directory, entry.name), mode)
  }
}

async function makeReadonly(directory: string, manifest: ArtifactManifest): Promise<void> {
  for (const file of manifest.files) await chmod(join(directory, file.path), file.mode & ~0o222)
  await chmod(join(directory, 'manifest.json'), 0o444)
  await directoryPermissions(directory, 0o555)
}

/**
 * Reject links and escaping paths before extracting a helper's release archive.
 * @param archive - gzip tar file supplied by the build.
 * @param directory - empty extraction directory owned by the caller.
 * @returns the extracted payload root.
 */
export async function extractHelper(archive: string, directory: string): Promise<string> {
  const entries: { path: string; type: string }[] = []
  await list({ file: archive, onReadEntry: (entry) => { entries.push({ path: entry.path, type: entry.type }) } })
  const seen = new Set<string>()
  for (const entry of entries) {
    const path = entry.path.replace(/\/$/, '')
    if (!['File', 'Directory'].includes(entry.type) || path.split('/').some(part => part === '..' || part === '.' || part === '')
      || path.includes('\\') || !path.startsWith('dsh-ssh-helper') || (path !== 'dsh-ssh-helper' && !path.startsWith('dsh-ssh-helper/')) || seen.has(path)) {
      throw new Error(`Invalid SSH helper archive entry: ${entry.path} (${entry.type})`)
    }
    seen.add(path)
  }
  if (!seen.has('dsh-ssh-helper/manifest.json')) throw new Error('SSH helper archive has no manifest.json')
  await extract({ file: archive, cwd: directory, strict: true })
  return join(directory, 'dsh-ssh-helper')
}

/**
 * Run the isolated consumer process and await all output and process teardown.
 * @param config - generated Loader configuration.
 * @param report - output report path.
 * @param sandbox - expected confinement availability on this lane.
 * @param environment - isolated client environment, including any test-owned SSH wrapper.
 */
export async function runArtifactDriver(config: string, report: string, sandbox: string, environment: NodeJS.ProcessEnv): Promise<void> {
  const child = spawn(process.execPath, ['--import', 'tsx/esm', join(fixtures, 'driver.ts'), config, report, sandbox], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: environment,
  })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-32_768)
  })
  const force = setTimeout(() => { child.kill('SIGKILL') }, 120_000)
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => {
        if (code === 0 && signal === null) resolve()
        else reject(new Error(`SSH artifact consumer exited (${code ?? signal}):\n${output}`))
      })
    })
  } finally { clearTimeout(force) }
}

/**
 * Serialize the shared provider composition around a selected helper transport.
 * @param connection - concrete Loader connection row, direct fixture or OpenSSH.
 * @param workspace - target-side workspace path.
 * @returns YAML consumed by the normal application boot path.
 */
export function artifactComposition(connection: { id: string; name: string; config: object }, workspace: string): string {
  const rows = [
    { id: 'projections', name: '@deepseek-ai/dsh-session-projection' },
    { id: 'policy', name: '@deepseek-ai/dsh-sandbox-policy', config: { mode: 'workspace-write', workspaceRoot: workspace } },
    connection,
    { id: 'fs', name: '@deepseek-ai/dsh-fs-ssh' },
    { id: 'subprocess', name: '@deepseek-ai/dsh-subprocess-ssh' },
    { id: 'sandbox', name: '@deepseek-ai/dsh-sandbox-ssh' },
  ]
  return rows.map(row => `- ${JSON.stringify(row)}`).join('\n')
    + '\n- id: ptc\n  name: "@deepseek-ai/dsh-ptc-runtime-node"\n  inject: [ssh]\n  config:\n    launch: !!js ctx.ssh.ptcLaunch\n'
}

/**
 * Verify archive integrity and all core operations after relocation outside the checkout.
 * @param argv - verifier flags.
 */
export async function verifySshHelper(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: {
    archive: { type: 'string' }, sandbox: { type: 'string', default: 'required' },
    report: { type: 'string' },
    backend: { type: 'string' },
  } })
  if (values.archive === undefined || !['required', 'unavailable'].includes(values.sandbox)) throw new Error('Use --archive=<file> --sandbox=required|unavailable')
  if (values.backend !== undefined && !['bwrap', 'landlock-run', 'sandbox-exec'].includes(values.backend)) throw new Error('Unknown expected sandbox backend')
  if (values.backend === 'landlock-run' && process.platform !== 'linux') throw new Error('Landlock verification requires Linux')
  const archive = resolve(values.archive)
  const checksum = (await readFile(`${archive}.sha256`, 'utf8')).split(/\s/)[0]
  if (await fileDigest(archive) !== checksum) throw new Error('SSH helper archive checksum mismatch')
  const temporary = await realpath(await mkdtemp(join(homedir(), '.dsh-helper-check-')))
  try {
    const installed = await extractHelper(archive, temporary)
    const manifest = await verifyPayload(installed)
    const host = `node24-${process.platform === 'darwin' ? 'macos' : process.platform}-${process.arch}`
    if (manifest.target !== host) throw new Error(`Artifact ${manifest.target} cannot be validated on ${host}`)
    await verifyNativePayload(installed, manifest.target)
    await makeReadonly(installed, manifest)
    const workspace = join(temporary, 'workspace')
    const home = join(temporary, 'home')
    await mkdir(workspace); await mkdir(home)
    let path = '/usr/bin:/bin'
    if (values.backend === 'landlock-run') {
      const bin = join(temporary, 'bin')
      await mkdir(bin)
      await writeFile(join(bin, 'bwrap'), '#!/bin/sh\nexit 127\n')
      await chmod(join(bin, 'bwrap'), 0o755)
      path = `${bin}:${path}`
    }
    const executable = join(installed, 'dsh-ssh-helper')
    const helperHash = await fileDigest(executable)
    const environment = {
      HOME: home, PATH: process.env.PATH, DSH_HOME: join(home, 'dsh'),
      TSX_TSCONFIG_PATH: join(root, 'tsconfig.base.json'), DSH_TELEMETRY_DISABLED: '1',
      ...(values.backend === undefined ? {} : { DSH_EXPECT_SANDBOX_RUNNER: values.backend }),
    }
    const runs = await Promise.allSettled([0, 1].map(async (index) => {
      const cwd = join(workspace, String(index))
      await mkdir(cwd)
      const config = join(temporary, `cordis-${index}.yml`)
      const report = join(temporary, `report-${index}.json`)
      await writeFile(config, artifactComposition({ id: 'ssh', name: join(fixtures, 'direct-helper.ts'), config: {
        executable, helperHash, workspace: cwd, home, path,
      } }, cwd))
      await runArtifactDriver(config, report, values.sandbox, environment)
    }))
    const failures = runs.filter(result => result.status === 'rejected').map((result): unknown => result.reason)
    if (failures.length > 0) throw new AggregateError(failures, 'Concurrent SSH artifact consumers failed')
    if (process.platform === 'darwin') await probeRestrictedWorker(executable, workspace, home, await realpath(root), await realpath(process.execPath))
    const evidence = { manifest, runtime: runtimeReportSchema.parse(JSON.parse(await readFile(join(temporary, 'report-0.json'), 'utf8'))),
      restrictedWorker: process.platform === 'darwin', expectedBackend: values.backend ?? null,
      readonlyInstall: true, concurrentColdStarts: 2 }
    if (values.report !== undefined) {
      const destination = resolve(values.report)
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, `${JSON.stringify(evidence, null, 2)}\n`)
    }
    console.log(`SSH helper ${manifest.target}: ${JSON.stringify(evidence.runtime)}`)
  } finally {
    await directoryPermissions(temporary, 0o755)
    await rm(temporary, { recursive: true, force: true })
  }
}

if (import.meta.main) await verifySshHelper(process.argv.slice(2))
