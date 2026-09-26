import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { macOSCachePolicy } from '../scripts/macos-cache-policy.ts'

vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), spawnSync: vi.fn() }))
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs, readFileSync: (...args: Parameters<typeof fs.readFileSync>) => args[0] === '/usr/bin/codesign' ? Buffer.from('codesign-tool') : args[0] === 'candidate' ? Buffer.from(header, 'hex') : fs.readFileSync(...args) }
})
const identity = { signingIdentity: 'Example (TEAM123456)', teamId: 'TEAM123456' }
const expectedDetails = 'Authority=Developer ID Application: Example (TEAM123456)\nTeamIdentifier=TEAM123456\nTimestamp=today\nCodeDirectory v=20500 flags=0x10000(runtime)\nIdentifier=com.example.file\n'
let header = 'cffaedfe'
let details = expectedDetails
let certificate = 'leaf-certificate'
let entitlements = ''
let rejectVerify = false
beforeEach(() => {
  header = 'cffaedfe'; details = expectedDetails; certificate = 'leaf-certificate'; entitlements = ''; rejectVerify = false
  vi.mocked(spawnSync).mockImplementation((command, args, options) => {
    const argv = args as string[]
    if (command === '/usr/bin/plutil') {
      const input = (options as { input: string }).input
      return { pid: 1, output: [], status: 0, signal: null, stdout: JSON.stringify(input.includes('allow-jit') ? { 'com.apple.security.cs.allow-jit': true } : {}), stderr: '' }
    }
    const extraction = argv.find(arg => arg.startsWith('--extract-certificates='))
    if (extraction) writeFileSync(`${extraction.slice('--extract-certificates='.length)}0`, certificate)
    return { pid: 1, output: [], status: rejectVerify && argv.includes('--verify') ? 1 : 0, signal: null, stdout: entitlements, stderr: details }
  })
})
afterEach(() => { vi.resetAllMocks() })
it('accepts only a signature matching the resolved policy', () => {
  const signer = macOSCachePolicy('probe')('com.example.file', identity)
  expect(() => { signer.verify('candidate') }).not.toThrow()
})
it.each(['certificate', 'identifier', 'team', 'authority', 'timestamp', 'runtime', 'entitlements', 'strict', 'universal'])('rejects mismatched %s', (field) => {
  const signer = macOSCachePolicy('probe')('com.example.file', identity)
  if (field === 'certificate') certificate = 'another-certificate'
  if (field === 'identifier') details = details.replace('com.example.file', 'com.other.file')
  if (field === 'team') details = details.replace('TeamIdentifier=TEAM123456', 'TeamIdentifier=OTHER12345')
  if (field === 'authority') details = details.replace('Authority=Developer', 'Authority=Other')
  if (field === 'timestamp') details = details.replace('Timestamp=today', '')
  if (field === 'runtime') details = details.replace('flags=0x10000(runtime)', 'flags=0x0(none)')
  if (field === 'entitlements') entitlements = '<key>com.apple.security.cs.allow-jit</key>'
  if (field === 'strict') rejectVerify = true
  if (field === 'universal') header = 'cafebabe'
  expect(() => { signer.verify('candidate') }).toThrow()
})
it('includes certificate, identifier and entitlement contents in the cache policy', () => {
  const create = macOSCachePolicy('probe')
  const original = create('com.example.file', identity).policy
  expect(create('com.other.file', identity).policy).not.toBe(original)
  expect(create('com.example.file', identity, join(import.meta.dirname, '../scripts/jit-entitlements.plist')).policy).not.toBe(original)
  certificate = 'renewed-certificate'
  expect(macOSCachePolicy('probe')('com.example.file', identity).policy).not.toBe(original)
})
