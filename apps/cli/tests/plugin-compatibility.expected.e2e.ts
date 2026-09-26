/** Published CLI acceptance for actual pnpm installation, restart checks, and explicit exemptions. */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { expect, it, onTestFinished } from 'vitest'

const bin = fileURLToPath(new URL('../lib/bin.js', import.meta.url))
const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version

it('refuses incompatible installation and startup until an exact risk exemption is granted', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-compatibility-cli-'))
  onTestFinished(() => { rmSync(home, { recursive: true, force: true }) })
  const profile = join(home, 'profiles', 'compatibility')
  const source = join(home, 'fixture-plugin')
  mkdirSync(profile, { recursive: true })
  mkdirSync(source)
  const profileFile = join(profile, 'package.json')
  const initial = { name: 'compatibility-profile', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }
  writeFileSync(profileFile, JSON.stringify(initial))
  writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  writeFileSync(join(source, 'package.json'), JSON.stringify({
    name: 'compatibility-fixture', version: '1.0.0', type: 'module',
    peerDependencies: { '@deepseek-ai/dsh': '999.0.0' }, dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  writeFileSync(join(source, 'cordis.patch.yml'), '- insert:\n    - id: compatibility-fixture\n      name: ./index.mjs\n')
  writeFileSync(join(source, 'index.mjs'), 'process.stdout.write("PLUGIN_IMPORTED\\n"); export function apply() { process.stdout.write("PLUGIN_STARTED\\n") }\n')
  const run = async (args: string[]) => {
    const result = await execa(process.execPath, [bin, ...args], {
      cwd: home, env: { ...process.env, DSH_HOME: home }, extendEnv: false, reject: false, timeout: 60_000,
    })
    expect(result.timedOut).toBe(false)
    expect(result.signal).toBeUndefined()
    return result
  }
  const plugin = (args: string[]) => run(['plugin', '--profile', 'compatibility', ...args])
  const refused = await plugin(['add', source, '--offline', '--ignore-scripts'])
  expect(refused.exitCode).toBe(1)
  expect(refused.stderr).toContain('crashes or data loss')
  expect(JSON.parse(readFileSync(profileFile, 'utf8'))).toEqual(initial)
  expect(existsSync(join(profile, 'compatibility.json'))).toBe(false)
  // The named package is checked before installation, so a refused one never lands on disk.
  expect(refused.stderr).toContain('nothing was installed')
  expect(existsSync(join(profile, 'node_modules', 'compatibility-fixture'))).toBe(false)

  // A package installed outside DSH still goes through the independent startup check.
  cpSync(source, join(profile, 'node_modules', 'compatibility-fixture'), { recursive: true })
  writeFileSync(profileFile, JSON.stringify({ ...initial,
    dependencies: { 'compatibility-fixture': `file:${source}` }, dsh: { profile: { bundles: ['compatibility-fixture'] } },
  }))
  const deniedStartup = await run(['--profile', 'compatibility'])
  expect(deniedStartup.stdout).not.toContain('PLUGIN_IMPORTED')
  expect(deniedStartup.stderr).toContain('incompatible')
  const missingConsent = await plugin(['allow-version', 'compatibility-fixture@1.0.0', '--dsh-version', version])
  expect(missingConsent.exitCode).toBe(1)
  const granted = await plugin(['allow-version', 'compatibility-fixture@1.0.0', '--dsh-version', version, '--accept-risk'])
  expect(granted.exitCode).toBe(0)
  expect(granted.stderr).toContain('break the application or corrupt data')
  // The exemption is profile metadata of its own; the dependency manifest and bundle list stay untouched.
  expect(JSON.parse(readFileSync(join(profile, 'compatibility.json'), 'utf8'))).toEqual({ 'compatibility-fixture@1.0.0': [version] })
  expect(JSON.parse(readFileSync(profileFile, 'utf8'))).not.toHaveProperty('dsh.profile.versionExemptions')
  expect((await plugin(['add', source, '--offline', '--ignore-scripts'])).exitCode).toBe(0)
  const admittedStartup = await run(['--profile', 'compatibility'])
  expect(admittedStartup.exitCode).toBe(0)
  expect(admittedStartup.stdout).toContain('PLUGIN_STARTED')
  expect((await plugin(['revoke-version', 'compatibility-fixture@1.0.0', '--dsh-version', version])).exitCode).toBe(0)
  expect((await run(['--profile', 'compatibility'])).stdout).not.toContain('PLUGIN_IMPORTED')
})
