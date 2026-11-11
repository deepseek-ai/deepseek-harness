import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const library = resolve(import.meta.dirname, 'ci-verified-download.sh')
const url = 'https://downloads.invalid/payload.deb'
const payload = Buffer.from('verified payload\n')
const payloadSha256 = createHash('sha256').update(payload).digest('hex')

// Records each invocation, then copies FAKE_CURL_SOURCE to the --output path
// or fails as curl does for an HTTP error when no source is configured.
const fakeCurl = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_CURL_LOG"
output=''
while (( $# > 0 )); do
  if [[ "$1" == --output ]]; then output="$2"; shift; fi
  shift
done
if [[ -z "\${FAKE_CURL_SOURCE:-}" ]]; then
  echo 'curl: (22) The requested URL returned error: 503' >&2
  exit 22
fi
cp "$FAKE_CURL_SOURCE" "$output"
`

interface Fixture {
  readonly root: string
  readonly cacheDir: string
  readonly cacheFile: string
  readonly curlLog: string
  readonly env: NodeJS.ProcessEnv
}

const fixtureRoots: string[] = []

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createFixture(served?: Buffer): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ci-verified-download-'))
  fixtureRoots.push(root)
  const bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'curl'), fakeCurl)
  chmodSync(join(bin, 'curl'), 0o755)
  const curlLog = join(root, 'curl.log')
  writeFileSync(curlLog, '')
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: bin + delimiter + (process.env.PATH ?? ''), FAKE_CURL_LOG: curlLog }
  delete env.FAKE_CURL_SOURCE
  if (served !== undefined) {
    const source = join(root, 'served.deb')
    writeFileSync(source, served)
    env.FAKE_CURL_SOURCE = source
  }
  const cacheDir = join(root, 'cache', 'bubblewrap')
  return { root, cacheDir, cacheFile: join(cacheDir, 'payload.deb'), curlLog, env }
}

function acquire(fixture: Fixture): { status: number | null; signal: NodeJS.Signals | null; stderr: string } {
  const result = spawnSync(
    'bash',
    ['-c', 'set -euo pipefail; source "$1"; acquire_verified_archive "$2" "$3" "$4"', 'acquire', library, url, payloadSha256, fixture.cacheFile],
    { encoding: 'utf8', env: fixture.env, timeout: 30_000 },
  )
  return { status: result.status, signal: result.signal, stderr: result.stderr }
}

function curlCalls(fixture: Fixture): string[] {
  return readFileSync(fixture.curlLog, 'utf8').split('\n').filter(line => line !== '')
}

function seedCache(fixture: Fixture, content: Buffer): void {
  mkdirSync(fixture.cacheDir, { recursive: true })
  writeFileSync(fixture.cacheFile, content)
}

// The library targets Linux CI runners and needs bash with sha256sum.
describe.skipIf(process.platform === 'win32')('acquire_verified_archive', () => {
  it('uses a verified cached archive without contacting the download host', () => {
    const fixture = createFixture()
    seedCache(fixture, payload)

    const result = acquire(fixture)

    expect(result.signal).toBeNull()
    expect(result.status).toBe(0)
    expect(curlCalls(fixture)).toEqual([])
    expect(readFileSync(fixture.cacheFile)).toEqual(payload)
  })

  it('fails with the URL when the download fails and no cached archive exists', () => {
    const fixture = createFixture()

    const result = acquire(fixture)

    expect(result.signal).toBeNull()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`Failed to download ${url} and no verified cached copy exists at ${fixture.cacheFile}`)
    expect(curlCalls(fixture)).toHaveLength(1)
    expect(readdirSync(fixture.cacheDir)).toEqual([])
  })

  it('bounds every download attempt and the retry window', () => {
    const fixture = createFixture(payload)

    expect(acquire(fixture).status).toBe(0)

    const [call] = curlCalls(fixture)
    expect(call).toMatch(/--connect-timeout \d+ /u)
    expect(call).toMatch(/--max-time \d+ /u)
    expect(call).toMatch(/--retry-max-time \d+ /u)
    expect(call).toContain(url)
  })

  it('replaces a cached archive whose digest does not match with a verified download', () => {
    const fixture = createFixture(payload)
    seedCache(fixture, Buffer.from('corrupted payload\n'))

    const result = acquire(fixture)

    expect(result.signal).toBeNull()
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('SHA-256 mismatch')
    expect(curlCalls(fixture)).toHaveLength(1)
    expect(readdirSync(fixture.cacheDir)).toEqual(['payload.deb'])
    expect(readFileSync(fixture.cacheFile)).toEqual(payload)
  })

  it('rejects a downloaded archive whose digest does not match without caching it', () => {
    const fixture = createFixture(Buffer.from('tampered payload\n'))

    const result = acquire(fixture)

    expect(result.signal).toBeNull()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`Downloaded ${url} does not have SHA-256 ${payloadSha256}`)
    expect(existsSync(fixture.cacheFile)).toBe(false)
    expect(readdirSync(fixture.cacheDir)).toEqual([])
  })
})
