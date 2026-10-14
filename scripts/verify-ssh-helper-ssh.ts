/** Real OpenSSH acceptance against a glibc 2.28 container with no installed Node. */
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { fileDigest, runtimeReportSchema, verifyPayload } from './ssh-helper/artifact.ts'
import { artifactComposition, extractHelper, runArtifactDriver } from './verify-ssh-helper-artifact.ts'

const run = promisify(execFile)
const root = resolve(import.meta.dirname, '..')

async function docker(...args: string[]): Promise<string> {
  return (await run('docker', args, { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 })).stdout.trim()
}

async function sshdReady(container: string): Promise<void> {
  const logs = spawn('docker', ['logs', '--follow', container], { stdio: ['ignore', 'pipe', 'pipe'] })
  let text = ''
  const ready = Promise.withResolvers<void>()
  const closed = new Promise<void>((resolve) => { logs.once('close', () => { resolve(); ready.reject(new Error(`sshd exited before readiness: ${text}`)) }) })
  const read = (chunk: Buffer): void => {
    text = (text + chunk.toString()).slice(-8192)
    if (text.includes('Server listening on')) ready.resolve()
  }
  logs.stdout.on('data', read); logs.stderr.on('data', read)
  logs.once('error', (error) => { ready.reject(error) })
  const deadline = setTimeout(() => { ready.reject(new Error(`sshd readiness timed out: ${text}`)) }, 30_000)
  try { await ready.promise }
  finally { clearTimeout(deadline); logs.kill('SIGTERM'); await closed }
}

/**
 * Install only a validated release into an isolated SSH server and exercise production providers.
 * @param argv - archive and optional report flags.
 */
export async function verifySshTransport(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { archive: { type: 'string' }, report: { type: 'string' } } })
  if (values.archive === undefined) throw new Error('Use --archive=<Linux helper archive>')
  const archive = resolve(values.archive)
  assert.equal(await fileDigest(archive), (await readFile(`${archive}.sha256`, 'utf8')).split(/\s/)[0], 'Archive checksum')
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-helper-ssh-'))
  const image = `dsh-helper-test:${randomUUID()}`
  let imageBuilt = false
  let container: string | undefined
  try {
    const installed = await extractHelper(archive, temporary)
    const manifest = await verifyPayload(installed)
    if (!manifest.target.includes('-linux-')) throw new Error('OpenSSH container acceptance requires a Linux artifact')
    const platform = manifest.target.endsWith('-arm64') ? 'linux/arm64' : 'linux/amd64'
    await docker('build', '--platform', platform, '--tag', image, join(root, 'packages/ssh/ssh-helper-runtime/tests/fixtures/sshd'))
    imageBuilt = true
    const identity = join(temporary, 'identity')
    await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', identity])
    container = await docker('run', '--detach', '--platform', platform, '--publish', '127.0.0.1::22',
      '--mount', `type=bind,src=${installed},dst=/opt/dsh-helper,readonly`,
      '--mount', `type=bind,src=${identity}.pub,dst=/fixture-key.pub,readonly`, image)
    await sshdReady(container)
    const published = await docker('port', container, '22/tcp')
    const port = /^127\.0\.0\.1:(\d+)$/.exec(published)?.[1]
    if (port === undefined) throw new Error(`Unexpected Docker port mapping: ${published}`)
    const publicKey = await docker('exec', container, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub')
    const knownHosts = join(temporary, 'known_hosts')
    await writeFile(knownHosts, `[127.0.0.1]:${port} ${publicKey}\n`, { mode: 0o600 })
    const sshConfig = join(temporary, 'ssh_config')
    await writeFile(sshConfig, `Host artifact\n  HostName 127.0.0.1\n  Port ${port}\n  User dsh\n  IdentityFile "${identity}"\n  IdentitiesOnly yes\n  UserKnownHostsFile "${knownHosts}"\n  GlobalKnownHostsFile /dev/null\n`, { mode: 0o600 })
    const bin = join(temporary, 'bin')
    await mkdir(bin)
    const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
    await writeFile(join(bin, 'ssh'), `#!/bin/sh\nexec /usr/bin/ssh -F ${quote(sshConfig)} "$@"\n`)
    await chmod(join(bin, 'ssh'), 0o755)
    const workspace = '/home/dsh/workspace'
    const config = join(temporary, 'cordis.yml')
    await writeFile(config, artifactComposition({ id: 'ssh', name: '@deepseek-ai/dsh-ssh', config: {
      host: 'artifact', launch: { kind: 'executable' }, helper: '/opt/dsh-helper/dsh-ssh-helper',
      helperHash: await fileDigest(join(installed, 'dsh-ssh-helper')), workspace,
    } }, workspace))
    const home = join(temporary, 'client-home')
    await mkdir(home)
    const report = join(temporary, 'report.json')
    await runArtifactDriver(config, report, 'portable', {
      HOME: home, PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, DSH_HOME: join(home, 'dsh'),
      TSX_TSCONFIG_PATH: join(root, 'tsconfig.base.json'), DSH_TELEMETRY_DISABLED: '1', DSH_VERIFY_NO_NODE: '1',
    })
    const evidence = { manifest, runtime: runtimeReportSchema.parse(JSON.parse(await readFile(report, 'utf8'))), glibc: await docker('exec', container, 'getconf', 'GNU_LIBC_VERSION') }
    assert.equal(evidence.glibc, 'glibc 2.28')
    if (values.report !== undefined) {
      const destination = resolve(values.report)
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, `${JSON.stringify(evidence, null, 2)}\n`)
    }
    console.log(`SSH helper real SSH ${manifest.target}: ${JSON.stringify(evidence.runtime)}`)
  } catch (error) {
    if (container === undefined) throw error
    const logs = await run('docker', ['logs', container], { maxBuffer: 1024 * 1024 })
    throw new Error(`SSH container diagnostics:\n${logs.stdout}\n${logs.stderr}`, { cause: error })
  } finally {
    try { if (container !== undefined) await docker('rm', '--force', container) }
    finally {
      try { if (imageBuilt) await docker('image', 'rm', image) }
      finally { await rm(temporary, { recursive: true, force: true }) }
    }
  }
}

if (import.meta.main) await verifySshTransport(process.argv.slice(2))
