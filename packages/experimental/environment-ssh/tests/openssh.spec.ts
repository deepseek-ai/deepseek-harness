import { describe, expect, it } from 'vitest'
import { describeEnd, remoteCommand, shellQuote, sshOptionQuote } from '../src/openssh.ts'

describe('OpenSSH quoting', () => {
  it('single-quotes shell words, including embedded single quotes', () => {
    expect(shellQuote('/opt/it\'s here/daemon.js')).toBe('\'/opt/it\'\\\'\'s here/daemon.js\'')
  })

  it('double-quotes option paths and refuses paths containing double quotes', () => {
    expect(sshOptionQuote('/home/me/known hosts')).toBe('"/home/me/known hosts"')
    expect(() => sshOptionQuote('/a"b')).toThrow('OpenSSH option paths cannot contain double quotes: /a"b')
  })

  it('runs a stdio execution process with quoted executable and daemon paths', () => {
    const command = remoteCommand({ node: '/opt/node here', daemonPath: "/opt/it's here/daemon.js", digest: 'expected-digest' })
    expect(command).toContain(`exec ${shellQuote('/opt/node here')} ${shellQuote('--input-type=module')} ${shellQuote('-e')}`)
    expect(command).toContain(["/opt/it's here/daemon.js", 'serve', '--stdio'].map(shellQuote).join(' '))
    expect(command).toContain('expected-digest')
  })
})

describe('ssh process end', () => {
  it('names the exit code or signal and the retained stderr', async () => {
    await expect(describeEnd('box', Promise.resolve({ exitCode: 255, signal: null }), () => 'Host key verification failed.\n')).resolves
      .toEqual(new Error('ssh to box exited with code 255: Host key verification failed.'))
    await expect(describeEnd('box', Promise.resolve({ exitCode: null, signal: 'SIGTERM' }), () => '')).resolves
      .toEqual(new Error('ssh to box exited with SIGTERM'))
  })

  it('reports a process the provider could not run', async () => {
    await expect(describeEnd('box', Promise.reject(new Error('spawn ENOENT')), () => '')).resolves.toEqual(new Error('ssh to box failed: spawn ENOENT'))
    // A provider may reject with a non-Error value; the message still names it.
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the case under test is a non-Error rejection.
    const rejected: Promise<never> = Promise.reject('gone')
    await expect(describeEnd('box', rejected, () => 'x')).resolves.toEqual(new Error('ssh to box failed: gone: x'))
  })
})
