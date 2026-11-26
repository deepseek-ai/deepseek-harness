import { existsSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, onTestFinished } from 'vitest'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import EnvironmentRegistry from '@deepseek-ai/dsh-environment'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import LocalSandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import * as SshEnvironment from '../src/index.ts'
import { loadDaemon } from '../src/bootstrap.ts'

const artifact = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-environment/daemon.js'))
const fake = fileURLToPath(new URL('fixtures/fake-openssh.ts', import.meta.url))

describe.skipIf(process.platform === 'win32' || !existsSync(artifact))('SSH bootstrap with standalone deployment artifact', () => {
  it('installs the built daemon, executes it outside the repository, and reuses its verified file', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'dsh-ssh-deploy-')))
    const owner = new Context()
    onTestFinished(async () => { await owner.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
    const key = randomBytes(32).toString('base64')
    const fingerprint = `SHA256:${createHash('sha256').update(Buffer.from(key, 'base64')).digest('base64').replace(/=+$/, '')}`
    const state = join(directory, 'state.json')
    await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'commonjs' }))
    await writeFile(state, JSON.stringify({ hostname: 'box.example', port: '22', userKnownHosts: join(directory, 'user_known_hosts'), keyType: 'ssh-ed25519', keyBase64: key }))
    await owner.plugin(LocalSubprocess)
    await owner.plugin(LocalSandbox, {})
    await owner.plugin(SandboxPolicy, { mode: 'danger-full-access' })
    await owner.plugin(EnvironmentRegistry)
    const daemon = join(directory, "remote destination's", 'daemon.js')
    const config = SshEnvironment.Config({
      host: 'box', handle: 'built-ssh', daemonPath: daemon, node: process.execPath,
      hostKeys: [fingerprint], knownHostsFile: join(directory, 'known_hosts'),
      ssh: [process.execPath, fake, 'ssh', state], sshKeygen: [process.execPath, fake, 'keygen', state],
    })
    const bundle = await loadDaemon()
    await mkdir(join(directory, "remote destination's"))
    // An older release that speaks an older protocol is replaced.
    const older = bundle.source.replace(`"version":"${bundle.version}","protocol":${bundle.protocol}`, `"version":"0.0.1","protocol":${bundle.protocol - 1}`)
    expect(older).not.toBe(bundle.source)
    await writeFile(daemon, older)
    const first = await owner.plugin(SshEnvironment, config)
    const print = owner.environments.define(async (node: string, env) => {
      return (await env.exec([node, '-e', 'process.stdout.write("bootstrapped")'])).stdout
    }, { result: z.string() })
    const execute = () => print(owner.environments.handle('built-ssh'), process.execPath, { signal: new AbortController().signal })
    await expect(execute()).resolves.toBe('bootstrapped')
    expect(await readFile(daemon, 'utf8')).toBe(bundle.source)
    const manifest = z.object({ version: z.string() }).parse(JSON.parse(await readFile(new URL('../../environment/package.json', import.meta.url), 'utf8')))
    expect(bundle.version).toBe(manifest.version)
    const installed = await stat(daemon)
    await first.dispose()
    await owner.plugin(SshEnvironment, config)
    await expect(execute()).resolves.toBe('bootstrapped')
    expect((await stat(daemon)).mtimeMs).toBe(installed.mtimeMs)
  })
})
