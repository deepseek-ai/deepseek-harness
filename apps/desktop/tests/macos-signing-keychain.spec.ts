import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { withMacOSSigningKeychain } from '../scripts/macos-signing-keychain.mjs'

const environment = { CSC_LINK: '/signing.p12', CSC_KEY_PASSWORD: 'export-secret', DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'Example (TEAMID1234)' }
const USER_KEYCHAINS = ['/Users/example/Library/Keychains/login.keychain-db', '/Library/Keychains/System.keychain']
const keychainListOutput = `${USER_KEYCHAINS.map(path => `    "${path}"`).join('\n')}\n`
const runKeychainList = () => keychainListOutput

describe('temporary macOS signing identity', () => {
  it('scopes signing to the imported identity and removes credentials before invoking the build', async () => {
    const run = vi.fn<(command: string, args: string[]) => string>(runKeychainList)
    let keychain = ''
    await withMacOSSigningKeychain(environment, async (env) => {
      keychain = env.CSC_KEYCHAIN!
      expect(existsSync(dirname(keychain))).toBe(true)
      expect(env.CSC_LINK).toBeUndefined()
      expect(env.CSC_KEY_PASSWORD).toBeUndefined()
      expect(run.mock.calls.some(([command, args]) => command === '/usr/bin/codesign' && args.includes(keychain))).toBe(true)
      expect(run.mock.calls.at(-1)?.[1]).toContain('--verify')
    }, run)
    expect(run.mock.calls.at(-1)?.[1]).toEqual(['delete-keychain', keychain])
    expect(existsSync(dirname(keychain))).toBe(false)
    expect(environment.CSC_KEY_PASSWORD).toBe('export-secret')
    const create = run.mock.calls.find(([, args]) => args[0] === 'create-keychain')![1]
    const partition = run.mock.calls.find(([, args]) => args[0] === 'set-key-partition-list')![1]
    expect(partition[partition.indexOf('-k') + 1]).toBe(create[2])
    expect(create[2]).not.toBe(environment.CSC_KEY_PASSWORD)
    const searchListCalls = run.mock.calls.map(([, args]) => args).filter(args => args[0] === 'list-keychains')
    expect(searchListCalls).toEqual([
      ['list-keychains', '-d', 'user'],
      ['list-keychains', '-d', 'user', '-s', keychain, ...USER_KEYCHAINS],
      ['list-keychains', '-d', 'user', '-s', ...USER_KEYCHAINS],
    ])
    expect(run.mock.calls.findIndex(([, args]) => args[0] === 'list-keychains')).toBeLessThan(run.mock.calls.findIndex(([, args]) => args[0] === '--force'))
  })

  it.each(['import', '--force', 'build'])('cleans up and prevents subsequent work after %s fails', async (stage) => {
    const action = vi.fn(async () => { if (stage === 'build') throw Error('build failure') })
    const run = vi.fn<(command: string, args: string[]) => string>((_command, args) => {
      if (args[0] === stage) throw Error('tool failure')
      return keychainListOutput
    })
    await expect(withMacOSSigningKeychain(environment, action, run)).rejects.toThrow(/failure/u)
    const keychain = run.mock.calls[0]![1].at(-1)!
    expect(run.mock.calls.at(-1)?.[1]).toEqual(['delete-keychain', keychain])
    expect(existsSync(dirname(keychain))).toBe(false)
    expect(action).toHaveBeenCalledTimes(stage === 'build' ? 1 : 0)
  })

  it('allocates distinct keychains for overlapping invocations', async () => {
    const paths: string[] = []
    let release!: () => void
    const bothReady = new Promise<void>((resolve) => { release = resolve })
    const action = async (env: NodeJS.ProcessEnv) => {
      paths.push(env.CSC_KEYCHAIN!)
      if (paths.length === 2) release()
      await bothReady
      expect(paths.every(path => existsSync(dirname(path)))).toBe(true)
    }
    await Promise.all([
      withMacOSSigningKeychain(environment, action, runKeychainList),
      withMacOSSigningKeychain(environment, action, runKeychainList),
    ])
    expect(new Set(paths).size).toBe(2)
    expect(paths.every(path => !existsSync(dirname(path)))).toBe(true)
  })
})
