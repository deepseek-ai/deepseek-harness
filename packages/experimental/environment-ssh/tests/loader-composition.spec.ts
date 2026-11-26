import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import EnvironmentRegistry from '@deepseek-ai/dsh-environment'
import LocalSandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as SshTransport from '../src/index.ts'
import { SshHostKeyUntrustedError } from '../src/index.ts'
import * as Bootstrap from '../src/bootstrap.ts'

const node = process.execPath
const fake = fileURLToPath(new URL('fixtures/fake-openssh.ts', import.meta.url))
const sourceEntry = fileURLToPath(new URL('../../environment/src/daemon-entry.ts', import.meta.url))
const metadata = { version: 'test-source', protocol: 3, node: '^24.22.3 || >=26.13.1' }
const source = `// dsh-environment-daemon ${JSON.stringify(metadata)}\nawait import(${JSON.stringify(pathToFileURL(sourceEntry).href)})\n`
const bundle = { source, ...metadata, digest: createHash('sha256').update(source).digest('hex') }
beforeEach(() => { vi.spyOn(Bootstrap, 'loadDaemon').mockResolvedValue(bundle) })
const keyBase64 = randomBytes(32).toString('base64')
const fingerprint = `SHA256:${createHash('sha256').update(Buffer.from(keyBase64, 'base64')).digest('base64').replace(/=+$/, '')}`
let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  vi.restoreAllMocks()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
}, 30_000)

interface Setup {
  readonly state?: Record<string, unknown>
  readonly config?: Record<string, unknown>
  readonly userKnownHosts?: string
}

async function boot(setup: Setup = {}): Promise<{ ctx: Context; knownHosts: string }> {
  root ??= await realpath(await mkdtemp(join(tmpdir(), 'dsh-rx-ssh-')))
  const statePath = join(root, 'state.json')
  const userKnownHosts = join(root, 'user_known_hosts')
  const knownHosts = join(root, 'dsh', 'known_hosts')
  await writeFile(statePath, JSON.stringify({ hostname: 'box.example', port: '22', userKnownHosts, keyType: 'ssh-ed25519', keyBase64, ...setup.state }))
  if (setup.userKnownHosts !== undefined) await writeFile(userKnownHosts, setup.userKnownHosts)
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
    ['@deepseek-ai/dsh-sandbox-local', LocalSandbox],
    ['@deepseek-ai/dsh-sandbox-policy', SandboxPolicyService],
    ['@deepseek-ai/dsh-environment', EnvironmentRegistry],
    ['@deepseek-ai/dsh-environment-ssh', SshTransport],
  ])
  const transport = {
    handle: 'box', host: 'box', daemonPath: join(root, "remote directory's", 'daemon.mjs'), node, knownHostsFile: knownHosts,
    ssh: [node, fake, 'ssh', statePath], sshKeygen: [node, fake, 'keygen', statePath],
    ...setup.config,
  }
  const lines = [...modules.keys()].flatMap(name => [
    `- name: 'cordis:${name}'`,
    ...name === '@deepseek-ai/dsh-sandbox-policy' ? ['  config:', '    mode: danger-full-access'] : [],
    ...name === '@deepseek-ai/dsh-environment-ssh' ? ['  config:', `    ${JSON.stringify(transport)}`] : [],
  ])
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, lines.join('\n') + '\n')
  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  for (const [specifier, plugin] of modules) context.loader.builtins[specifier] = plugin
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  return { ctx: context, knownHosts }
}

const daemonPid = (ctx: Context, confirm?: () => Promise<boolean>) => ctx.environments.define(
  async (nodePath: string, env) => (await env.exec([nodePath, '-e', 'process.stdout.write(String(process.ppid))'])).stdout,
  { result: z.string() },
)(ctx.environments.handle('box'), node, { signal: new AbortController().signal, ...confirm === undefined ? {} : { confirm } })

describe('SSH transport through real Loader composition', () => {
  it('reuses a direct SSH execution process and starts a fresh one after the host reconnects', async () => {
    const config = { hostKeys: [fingerprint] }
    const { ctx, knownHosts } = await boot({ config })
    const processId = await daemonPid(ctx)
    expect(await readFile(join(root!, "remote directory's", 'daemon.mjs'), 'utf8')).toBe(source)
    expect(await daemonPid(ctx)).toBe(processId)
    expect(await readFile(knownHosts, 'utf8')).toBe(`box.example ssh-ed25519 ${keyBase64}\n`)
    await context!.fiber.dispose()
    context = undefined
    expect(() => process.kill(Number(processId), 0)).toThrow()
    const again = await boot({ config })
    expect(await daemonPid(again.ctx)).not.toBe(processId)
  })

  it('derives a provider handle and admits an explicit display name', async () => {
    const { ctx } = await boot({ config: { handle: undefined, displayName: 'Build host' } })
    expect(ctx.environments.list()).toEqual([{ handle: 'ssh-box', displayName: 'Build host' }])
  })

  it('asks a person to trust an unknown host key and records it only when they agree', async () => {
    const { ctx, knownHosts } = await boot()
    const untrusted = daemonPid(ctx)
    await expect(untrusted).rejects.toBeInstanceOf(SshHostKeyUntrustedError)
    await expect(untrusted).rejects.toThrow(`SSH host key of box.example is not trusted. After verifying it on the host, add its fingerprint to hostKeys:\nED25519 ${fingerprint}`)
    const questions: unknown[] = []
    const declined = daemonPid(ctx, async (...question) => { questions.push(...question); return false })
    await expect(declined).rejects.toBeInstanceOf(SshHostKeyUntrustedError)
    expect(existsSync(knownHosts)).toBe(false)
    await expect(daemonPid(ctx, async () => true)).resolves.toMatch(/^\d+$/)
    expect(questions).toEqual([{
      hostname: 'box.example',
      port: 22,
      keys: [{ type: 'ED25519', fingerprint }],
      detail: `Trust the SSH host key of box.example? Compare with \`ssh-keygen -lf\` of the host's /etc/ssh/ssh_host_*_key.pub:\nED25519 ${fingerprint}`,
    }])
    expect(await readFile(knownHosts, 'utf8')).toBe(`box.example ssh-ed25519 ${keyBase64}\n`)
  })

  it('uses keys the user already trusts without fetching, under the alias OpenSSH records and a home-relative file', async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-rx-ssh-')))
    vi.stubEnv('HOME', root)
    try {
      const { ctx } = await boot({
        state: { port: '2222', alias: 'box-alias', unreachable: true, userKnownHosts: '~/user_known_hosts' },
        userKnownHosts: `box-alias ssh-ed25519 ${keyBase64}\n`,
      })
      await expect(daemonPid(ctx)).resolves.toMatch(/^\d+$/)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('records scanned keys under the bracketed host and port name', async () => {
    const { ctx, knownHosts } = await boot({ state: { port: '2222' }, config: { hostKeys: [fingerprint] } })
    await expect(daemonPid(ctx)).resolves.toMatch(/^\d+$/)
    expect(await readFile(knownHosts, 'utf8')).toBe(`[box.example]:2222 ssh-ed25519 ${keyBase64}\n`)
  })

  it('falls back to the destination name and port 22 and records keys in the DSH state directory by default', async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-rx-ssh-home-')))
    const home = root
    vi.stubEnv('DSH_HOME', home)
    try {
      root = undefined
      const { ctx } = await boot({ state: { minimalConfig: true, hostname: 'box' }, config: { hostKeys: [fingerprint], knownHostsFile: undefined } })
      await expect(daemonPid(ctx)).resolves.toMatch(/^\d+$/)
      expect(await readFile(join(home, 'state', 'environment-ssh', 'known_hosts'), 'utf8')).toBe(`box ssh-ed25519 ${keyBase64}\n`)
    } finally {
      vi.unstubAllEnvs()
      await rm(home, { recursive: true, force: true })
    }
  })

  it('leaves a changed host key to the strict check, which refuses the connection before any run', async () => {
    const { ctx } = await boot({ userKnownHosts: `box.example ssh-ed25519 ${randomBytes(32).toString('base64')}\n` })
    const refused = daemonPid(ctx, async () => true)
    await expect(refused).rejects.toThrow('REMOTE HOST IDENTIFICATION HAS CHANGED')
    await expect(refused).rejects.toEqual(expect.objectContaining({ code: 'ENVIRONMENT_SSH_BOOTSTRAP_FAILED' }))
  })

  it('reports OpenSSH configuration, scanning, fingerprint and output-size failures', async () => {
    for (const [state, config, message] of [
      [{ failConfig: true }, {}, 'ssh -G box failed: ssh: Could not resolve hostname box'],
      [{ unreachable: true }, {}, 'ssh could not fetch the host key of box: ssh: connect to host box.example port 22: Connection refused'],
      [{ keygenFails: true }, {}, 'ssh-keygen could not fingerprint a key of box.example: (stdin) is not a public key file.'],
      [{ configPadding: 100 }, { maxOutputBytes: 1024 }, 'printed more than 1024 bytes'],
    ] as const) {
      if (context !== undefined) await context.fiber.dispose()
      if (root !== undefined) await rm(root, { recursive: true, force: true })
      root = undefined
      const { ctx } = await boot({ state, config })
      await expect(daemonPid(ctx)).rejects.toThrow(message)
    }
  })

  it('reports missing local and remote prerequisites before admitting a run', async () => {
    for (const config of [
      { ssh: ['/nonexistent/ssh'], code: 'ENVIRONMENT_SSH_DEPENDENCY_MISSING' },
      { sshKeygen: ['/nonexistent/ssh-keygen'], code: 'ENVIRONMENT_SSH_DEPENDENCY_MISSING' },
      { node: '/nonexistent/remote-node', code: 'ENVIRONMENT_SSH_NODE_NOT_FOUND' },
    ]) {
      const { code, ...settings } = config
      if (context !== undefined) await context.fiber.dispose()
      const { ctx } = await boot({ config: { ...settings, hostKeys: [fingerprint] } })
      await expect(daemonPid(ctx)).rejects.toMatchObject({ code })
    }
  })

  it('refuses invalid configuration at load', async () => {
    const owner = new Context()
    const base = {
      handle: 'box', host: 'box', daemonPath: '/opt/daemon.js', node: 'node', hostKeys: [],
      ssh: ['ssh'], sshKeygen: ['ssh-keygen'], killGraceMs: 1, maxOutputBytes: 1,
    }
    expect(() => { SshTransport.apply(owner, { ...base, daemonPath: 'daemon.js' }) }).toThrow('daemonPath must be an absolute path on the destination')
    expect(() => { SshTransport.apply(owner, { ...base, host: '-oProxyCommand=x' }) }).toThrow('host must not start with a dash')
    expect(() => { SshTransport.apply(owner, { ...base, ssh: ['ssh', '-o', 'StrictHostKeyChecking=no'] }) }).toThrow('tool prefixes must not contain options')
    expect(() => { SshTransport.apply(owner, { ...base, knownHostsFile: 'known_hosts' }) }).toThrow('knownHostsFile must be an absolute path')
    await owner.fiber.dispose()
  })
})
