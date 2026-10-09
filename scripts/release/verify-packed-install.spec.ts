/** Packed-install npm cache ownership through the real offline verifier entry. */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const roots: string[] = []

afterEach(() => {
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true })
})

// The release verifier invokes POSIX npm directly, not the Windows npm.cmd shim.
describe.skipIf(process.platform === 'win32')('packed-install npm cache', () => {
  // The verifier starts npm, lifecycle scripts, and the installed entry serially.
  it.each(['success', 'install failure', 'entry failure'] as const)(
    'owns cache writes and removes them after %s',
    (outcome) => {
      const directory = mkdtempSync(join(tmpdir(), 'dsh-packed-cache-test-'))
      roots.push(directory)
      const source = join(directory, 'package')
      const packed = join(directory, 'packed')
      const ambient = join(directory, 'ambient-cache')
      const configured = join(directory, 'configured-cache')
      const temporary = join(directory, 'temporary')
      for (const path of [join(source, 'lib'), packed, ambient, configured, temporary]) mkdirSync(path, { recursive: true })
      writeFileSync(join(ambient, 'sentinel'), 'ambient cache must survive\n')
      writeFileSync(join(configured, 'sentinel'), 'configured cache must survive\n')
      const npmrc = join(directory, 'npmrc')
      writeFileSync(npmrc, `cache=${configured}\n`)
      const evidence = join(directory, 'evidence.json')
      const probe = `
const fs = require('node:fs')
const path = require('node:path')
const consumer = process.env.INIT_CWD || process.cwd()
const cache = path.join(consumer, '.npm-cache', '_cacache')
const files = fs.existsSync(cache) ? fs.readdirSync(cache, { recursive: true }).filter(name => fs.statSync(path.join(cache, name)).isFile()) : []
fs.writeFileSync(process.env.CACHE_EVIDENCE, JSON.stringify({ consumer, files }))
`
      writeFileSync(join(source, 'probe.cjs'), probe + (outcome === 'install failure' ? '\nprocess.exit(37)\n' : ''))
      writeFileSync(join(source, 'lib/bin.js'), outcome === 'entry failure' ? 'process.exit(37)\n' : 'console.log("0.0.1")\n')
      writeFileSync(join(source, 'package.json'), JSON.stringify({
        name: '@deepseek-ai/dsh',
        version: '0.0.1',
        scripts: { postinstall: 'node probe.cjs' },
      }))
      const archive = spawnSync('tar', ['-czf', join(packed, 'dsh.tgz'), '-C', directory, 'package'], { encoding: 'utf8', timeout: 30_000 })
      expect(archive.error).toBeUndefined()
      expect(archive.signal).toBeNull()
      expect(archive.status, archive.stderr).toBe(0)
      const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)))
      Object.assign(environment, {
        npm_config_cache: ambient,
        npm_config_userconfig: npmrc,
        npm_config_offline: 'true',
        npm_config_ignore_scripts: 'false',
        CACHE_EVIDENCE: evidence,
        TMPDIR: temporary,
        TMP: temporary,
        TEMP: temporary,
      })
      const result = spawnSync(process.execPath, [
        '--import', 'tsx', 'scripts/release/verify-packed-install.ts', '--family', 'dsh', '--from', packed,
      ], { cwd: root, env: environment, encoding: 'utf8', timeout: 120_000 })
      expect(result.error).toBeUndefined()
      expect(result.signal).toBeNull()
      expect(result.status, result.stdout + result.stderr).toBe(outcome === 'success' ? 0 : 1)
      const observation = JSON.parse(readFileSync(evidence, 'utf8')) as { consumer: string; files: string[] }
      expect(observation.files.length, 'npm must write tarball content into the consumer-private cache').toBeGreaterThan(0)
      expect(observation.consumer).toContain('dsh-packed-dsh-')
      expect(existsSync(observation.consumer), 'the verifier finally must remove its consumer and cache').toBe(false)
      expect(readdirSync(ambient)).toEqual(['sentinel'])
      expect(readFileSync(join(ambient, 'sentinel'), 'utf8')).toBe('ambient cache must survive\n')
      expect(readdirSync(configured)).toEqual(['sentinel'])
      expect(readFileSync(join(configured, 'sentinel'), 'utf8')).toBe('configured cache must survive\n')
    },
    180_000,
  )
})
