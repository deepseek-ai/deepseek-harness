/** Real Git access probes that choose the transport of a self-hosted repository installation. */
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as subprocess from 'execa'
import { afterAll, beforeAll, expect, it, onTestFinished, vi } from 'vitest'
import { chooseGitTransport } from '../src/git-transport.ts'
import { parseInstallSpec } from '../src/install-spec.ts'
import { isolateGitCommandLineConfig } from './git-environment.ts'

vi.mock('execa', async (original) => {
  const module = await original<typeof import('execa')>()
  return { ...module, execa: vi.fn(module.execa) }
})

// These cases spawn real Git, so the host's command-line configuration group must not reach its children.
let restoreGitCommandLineConfig: () => void
beforeAll(() => { restoreGitCommandLineConfig = isolateGitCommandLineConfig() })
afterAll(() => { restoreGitCommandLineConfig() })

const SPEC = `git+https://git.example/team/sub/plugin.git#${'a'.repeat(40)}&path:/packages/a`
const SSH_SPEC = `git+ssh://git@git.example/team/sub/plugin.git#${'a'.repeat(40)}&path:/packages/a`

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-git-transport-'))
  // Retry Windows directory-busy errors after awaited probe cleanup.
  onTestFinished(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const config = join(dir, 'git.config')
  await writeFile(config, '')
  const env = { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' }
  const git = (...args: string[]) => subprocess.execa('git', args, { env })
  const repository = join(dir, 'plugin.git')
  await git('init', '--bare', repository)
  // ls-remote --exit-code needs a HEAD that names a commit.
  const work = join(dir, 'work')
  await git('init', work)
  await git('-C', work, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'init')
  await git('-C', work, 'push', repository, 'HEAD:refs/heads/main')
  await git('-C', repository, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  const controller = new AbortController()
  const tasks: Promise<unknown>[] = []
  // Registered after the directory removal, so it runs first: no probe outlives the directory it runs in.
  onTestFinished(async () => { controller.abort(); await Promise.allSettled(tasks) })
  const choose = (spec: string, timeoutMs = 5000) => {
    const task = chooseGitTransport(parseInstallSpec(spec), dir, { timeoutMs, signal: controller.signal, env })
    tasks.push(task)
    return task
  }
  return { dir, config, repository: pathToFileURL(repository).href, controller, choose }
}

/** An HTTP Git endpoint that answers every request with `handler`. */
async function server(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  const http = createServer(handler)
  onTestFinished(async () => {
    http.closeAllConnections()
    await new Promise<void>((resolve, reject) => { http.close((error) => { if (error) reject(error); else resolve() }) })
  })
  http.listen(0, '127.0.0.1')
  await once(http, 'listening')
  const address = http.address()
  if (address === null || typeof address === 'string') throw new Error('server did not bind a TCP port')
  return `http://127.0.0.1:${String(address.port)}/`
}

const unauthorized = (_request: IncomingMessage, response: ServerResponse): void => {
  response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fixture"' })
  response.end()
}

it('keeps the HTTPS spec when HTTPS can read the repository', async () => {
  const { config, repository, choose } = await fixture()
  await writeFile(config, `[url "${repository}"]\n insteadOf = https://git.example/team/sub/plugin.git\n insteadOf = ssh://git@git.example/team/sub/plugin.git\n`)
  expect(await choose(SPEC)).toBe(SPEC)
})

it('installs over SSH when HTTPS asks for credentials that SSH does not need', async () => {
  const { config, repository, choose } = await fixture()
  const http = await server(unauthorized)
  await writeFile(config, `[url "${http}"]\n insteadOf = https://git.example/\n insteadOf = http://git.example/\n[url "${repository}"]\n insteadOf = ssh://git@git.example/team/sub/plugin.git\n[http]\n proxy =\n`)
  expect(await choose(SPEC)).toBe(SSH_SPEC)
  // The fragment is copied as written, not as URL serialization would encode it.
  expect(await choose('git+https://git.example/team/sub/plugin.git#semver:<2 >1')).toBe('git+ssh://git@git.example/team/sub/plugin.git#semver:<2 >1')
  expect(await choose('git+http://git.example/team/sub/plugin.git')).toBe('git+ssh://git@git.example/team/sub/plugin.git')
})

it('keeps the HTTPS spec when neither transport can read the repository', async () => {
  const { config, choose } = await fixture()
  const http = await server(unauthorized)
  await writeFile(config, `[url "${http}"]\n insteadOf = https://git.example/\n[url "file:///nonexistent/plugin.git"]\n insteadOf = ssh://git@git.example/\n[http]\n proxy =\n`)
  expect(await choose(SPEC)).toBe(SPEC)
})

it('lets configured credential helpers answer the HTTPS probe', async () => {
  const { dir, config, repository, choose } = await fixture()
  const expected = `Basic ${Buffer.from('person:token').toString('base64')}`
  const http = await server((request, response) => {
    if (request.headers.authorization === expected) {
      // Any reply Git can parse as a ref advertisement is enough; a dumb-HTTP info/refs listing is the smallest.
      response.writeHead(200, { 'Content-Type': 'text/plain' })
      response.end(`${'b'.repeat(40)}\tHEAD\n`)
    } else unauthorized(request, response)
  })
  const helper = join(dir, 'credential-helper.cjs')
  await writeFile(helper, 'process.stdout.write("username=person\\npassword=token\\n")')
  await writeFile(config, `[url "${http}"]\n insteadOf = https://git.example/\n[url "${repository}"]\n insteadOf = ssh://git@git.example/team/sub/plugin.git\n[http]\n proxy =\n`)
  await subprocess.execa('git', ['config', '--file', config, 'credential.helper', `!"${process.execPath.replaceAll('\\', '/')}" "${helper.replaceAll('\\', '/')}"`])
  expect(await choose(SPEC)).toBe(SPEC)
})

it.each([
  '@acme/plugin',
  'github:acme/plugin',
  'https://gitlab.com/acme/plugin.git',
  'git+https://github.com/acme/plugin.git#main',
  'git+ssh://git@git.example/team/plugin.git',
  'git@git.example:team/plugin.git',
  'git+https://person:token@git.example/team/plugin.git',
  'git+https://git.example/team/plugin.git?ref=x',
])('leaves %s to pnpm without probing', async (spec) => {
  const { choose } = await fixture()
  const run = vi.mocked(subprocess.execa)
  run.mockClear()
  expect(await choose(spec)).toBe(spec)
  expect(run).not.toHaveBeenCalled()
})

it('ends an in-flight HTTPS probe on cancellation and keeps the spec', async () => {
  const { config, controller, choose } = await fixture()
  const requested = Promise.withResolvers<undefined>()
  // Never answers, so only cancellation ends the probe.
  const http = await server(() => { requested.resolve(undefined) })
  await writeFile(config, `[url "${http}"]\n insteadOf = https://git.example/\n[http]\n proxy =\n`)
  const run = vi.mocked(subprocess.execa)
  run.mockClear()
  const choosing = choose(SPEC, 60000)
  await requested.promise
  controller.abort()
  expect(await choosing).toBe(SPEC)
  expect(run).toHaveBeenCalledTimes(1)
  expect(run.mock.calls[0]?.[1]).toEqual(['-c', 'core.askPass=', 'ls-remote', '--exit-code', '--', 'https://git.example/team/sub/plugin.git', 'HEAD'])
})

it('does not probe SSH after cancellation', async () => {
  const { controller, choose } = await fixture()
  const run = vi.mocked(subprocess.execa)
  run.mockClear()
  controller.abort()
  expect(await choose(SPEC)).toBe(SPEC)
  expect(run).toHaveBeenCalledTimes(1)
})
