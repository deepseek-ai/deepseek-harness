/** Built Desktop Host acceptance; run after the repository build, without provider credentials. */

import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopHostProcess } from '../src/host-process.ts'
import { desktopClientMetadata } from '../src/client-metadata.ts'
import { connectDesktopWelcome, type DesktopWelcomeBackend } from '../src/welcome-backend.ts'
import { authenticateWebHost } from '../src/web-document.ts'
import { builtHost, prepareDesktopHome, repository } from './harness.ts'

afterEach(() => { vi.unstubAllEnvs() })

async function mockPlatform() {
  let origin = ''
  let init: Record<string, string> = {}
  let failExchange = false
  const server = createServer((req, res) => {
    // The real Host composition identifies every Platform request with the five client headers.
    const expected = {
      'x-client-bundle-id': '', 'x-client-platform': process.platform === 'win32' ? 'desktop-win' : 'desktop-mac',
      'x-client-version': '1.2.3', 'x-client-locale': 'en_US',
      'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
    }
    for (const [name, value] of Object.entries(expected)) {
      if (req.headers[name] !== value) { res.writeHead(400).end(); return }
    }
    if (req.headers.cookie !== 'test_gate=synthetic') { res.writeHead(403).end(); return }
    if (req.url === '/auth-api/v0/users/logout' && req.method === 'POST') {
      if (req.headers['x-dsh-auth-token'] !== 'dsh_mock_composition_test') { res.writeHead(401).end(); return }
      res.writeHead(503).end()
      return
    }
    req.setEncoding('utf8')
    let body = ''
    req.on('data', (chunk: string) => { body += chunk })
    req.on('end', () => {
      const input = JSON.parse(body) as Record<string, string>
      let value: unknown
      if (req.url?.endsWith('auth_init')) {
        init = input
        if (input.locale !== 'en_US') { res.writeHead(400).end(); return }
        value = { authorize_url: `${origin}/dsh/authorize?authorize_id=test`, expires_in: 600, authorize_id: 'test' }
      } else if (req.url?.endsWith('auth_cancel')) {
        const challenge = createHash('sha256').update(input.code_verifier ?? '').digest('base64url')
        if (input.authorize_id !== 'test' || challenge !== init.code_challenge) { res.writeHead(400).end(); return }
        value = null
      } else {
        if (failExchange) { res.writeHead(503).end(); return }
        const challenge = createHash('sha256').update(input.code_verifier ?? '').digest('base64url')
        if (challenge !== init.code_challenge || input.redirect_uri !== init.redirect_uri) {
          res.writeHead(400).end()
          return
        }
        value = { user: null, token: 'dsh_mock_composition_test', authorized_url: `${origin}/dsh/authorized?result=test&locale=zh_CN` }
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ code: 0, data: { biz_code: 0, biz_data: value } }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing mock listener')
  origin = `http://127.0.0.1:${String(address.port)}`
  return {
    origin,
    failExchange: (value: boolean) => { failExchange = value },
    callback: () => `${init.redirect_uri}?code=test&state=${init.state}`,
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() }),
  }
}

describe.skipIf(!existsSync(builtHost))('built Desktop welcome flow', () => {
  it('persists explicit API keys and browser account login independently across Host restarts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-welcome-'))
    let host: DesktopHostProcess | undefined
    const platform = await mockPlatform()
    try {
      const { home, project, paths } = await prepareDesktopHome(root)
      cpSync(join(repository, 'packages/skill/skill-office/assets'), join(root, 'runtime/office-skills'), { recursive: true })
      const nodeBin = join(root, 'runtime/primary-runtime/dependencies/node/bin')
      mkdirSync(nodeBin, { recursive: true })
      cpSync(process.execPath, join(nodeBin, process.platform === 'win32' ? 'node.exe' : 'node'))
      writeFileSync(join(paths.profile, 'cordis.patch.yml'), `- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n- id: deepseek-account\n  config:\n${process.platform === 'linux' ? '    desktopPlatform: darwin\n' : ''}    platformOrigin: ${platform.origin}\n    allowLoopbackHttp: true\n    requestHeaders:\n      Cookie: test_gate=synthetic\n`)
      let backend: DesktopWelcomeBackend
      let hostOrigin = ''
      const restart = async (): Promise<void> => {
        await host?.stop()
        host = new DesktopHostProcess(process.execPath, project, paths.profile, undefined,
          process.env, undefined, join(root, 'runtime', 'primary-runtime'))
        const { url } = await host.start()
        hostOrigin = new URL(url).origin
        backend = connectDesktopWelcome(url, await authenticateWebHost(url))
      }
      const status = async () => backend.read()
      const fingerprint = (): string => createHash('sha256')
        .update(readFileSync(join(home, '.credentials.yaml'))).digest('hex')
      await restart()
      expect(await status()).toMatchObject({ hasApiKey: false, localePreference: null })
      const before = fingerprint()
      await host!.stop()
      writeFileSync(join(paths.profile, 'cordis.patch.yml'),
        readFileSync(join(paths.profile, 'cordis.patch.yml'), 'utf8') + '- id: locale\n  config:\n    preference: zh\n')
      await restart()
      expect(await status()).toMatchObject({ hasApiKey: false, localePreference: 'zh' })
      expect(fingerprint()).toBe(before)
      expect(await backend!.save('sk-local-onboarding-test')).toEqual({ ok: true })
      expect(await status()).toMatchObject({ hasApiKey: true, localePreference: 'zh' })
      await restart()
      expect(await status()).toMatchObject({ hasApiKey: true })
      await backend!.account.start(desktopClientMetadata('en'))
      await expect.poll(async () => (await backend!.account.state()).attempt?.phase).toBe('waiting-browser')
      expect(new URL(platform.callback()).origin).toBe(hostOrigin)
      platform.failExchange(true)
      const failed = await fetch(platform.callback(), { redirect: 'manual' })
      expect(failed.status).toBe(204)
      expect(await backend!.account.state()).toMatchObject({ status: 'signed-out', attempt: { phase: 'failed' } })
      expect(await status()).toMatchObject({ hasApiKey: true, loggedIn: false })
      platform.failExchange(false)
      await backend!.account.start(desktopClientMetadata('en'))
      await expect.poll(async () => (await backend!.account.state()).attempt?.phase).toBe('waiting-browser')
      const response = await fetch(platform.callback(), { redirect: 'manual' })
      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toBe(`${platform.origin}/dsh/authorized?result=test&locale=zh_CN&login_source=desktop`)
      expect(await status()).toMatchObject({ hasApiKey: true, loggedIn: true })
      await restart()
      expect(await status()).toMatchObject({ hasApiKey: true, loggedIn: true })
      // A failed remote logout must not block local sign-out through the real Host composition.
      await backend!.account.signOut(desktopClientMetadata('en'))
      expect(await status()).toMatchObject({ hasApiKey: true, loggedIn: false })
      await backend!.account.start(desktopClientMetadata('en'))
      await expect.poll(async () => (await backend!.account.state()).attempt?.phase).toBe('waiting-browser')
      const waiting = await backend!.account.state()
      const late = platform.callback()
      await backend!.account.cancel(waiting.attempt!.id)
      expect((await fetch(late, { redirect: 'manual' })).status).not.toBe(302)
      expect(await status()).toMatchObject({ loggedIn: false })
      // A handle left open after acknowledged teardown must not fail the update handoff.
      vi.stubEnv('NODE_OPTIONS', `--import=data:text/javascript,${encodeURIComponent(
        "process.on('message', message => { if (message?.type === 'shutdown') setInterval(() => {}, 1000) })")}`)
      await restart()
      await host!.stop(true)
    } finally {
      await host?.stop()
      await platform.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
