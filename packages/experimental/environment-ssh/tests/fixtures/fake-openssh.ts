/**
 * Fake OpenSSH tools for tests: the `ssh` and `ssh-keygen` behaviour the SSH transport relies on.
 * argv: <tool> <state.json> <tool arguments...>. `ssh` ignores a leading `-F <file>`, checks host keys strictly against
 * the given known_hosts files, then runs the remote command in a POSIX shell. Under `accept-new` it records
 * the host key in the given known_hosts file and stops before authentication, as real ssh does with no methods.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'

interface State {
  readonly hostname: string
  readonly port: string
  readonly alias?: string
  readonly userKnownHosts: string
  readonly keyType: string
  readonly keyBase64: string
  readonly failConfig?: boolean
  /** Print no settings, as a destination with no host name, port or known-hosts files would. */
  readonly minimalConfig?: boolean
  /** The host cannot be reached, so no key is recorded. */
  readonly unreachable?: boolean
  /** Extra `ssh -G` lines, to exceed output bounds. */
  readonly configPadding?: number
  readonly keygenFails?: boolean
}

const [tool, statePath, ...words] = process.argv.slice(2)
const args = tool === 'ssh' && words[0] === '-F' ? words.slice(2) : words
const state = JSON.parse(readFileSync(statePath!, 'utf8')) as State
const name = state.alias ?? (state.port === '22' ? state.hostname : `[${state.hostname}]:${state.port}`)
const fail = (message: string, code: number): never => {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}
const recorded = (file: string): string[][] => existsSync(file)
  ? readFileSync(file, 'utf8').split('\n').filter(line => line.trim() !== '').map(line => line.split(' '))
  : []

switch (tool) {
  case 'ssh': {
    if (args[0] === '-G') {
      if (state.failConfig) fail(`ssh: Could not resolve hostname ${args[2]}`, 255)
      if (state.minimalConfig) {
        process.stdout.write('user me\n')
        break
      }
      const lines = [`hostname ${state.hostname}`, `port ${state.port}`, `userknownhostsfile ${state.userKnownHosts}`, 'globalknownhostsfile none']
      if (state.alias !== undefined) lines.push(`hostkeyalias ${state.alias}`)
      for (let index = 0; index < (state.configPadding ?? 0); index++) lines.push(`setenv PADDING_${index}=x`)
      process.stdout.write(`${lines.join('\n')}\n`)
      break
    }
    const options = new Map<string, string>()
    let index = 0
    for (; args[index] !== '--'; index++) {
      if (args[index] === '-o') {
        const [key, ...value] = args[++index]!.split('=')
        options.set(key!, value.join('='))
      }
    }
    const files = [...options.get('UserKnownHostsFile')!.matchAll(/"([^"]*)"/g)].map(match => match[1]!)
    if (options.get('BatchMode') !== 'yes') fail('fake ssh requires batch mode', 2)
    if (options.get('StrictHostKeyChecking') === 'accept-new' && options.get('PreferredAuthentications') === 'none') {
      if (state.unreachable) fail(`ssh: connect to host ${state.hostname} port ${state.port}: Connection refused`, 255)
      appendFileSync(files[0]!, `${name} ${state.keyType} ${state.keyBase64}\n`)
      fail(`Warning: Permanently added '${name}' (${state.keyType}) to the list of known hosts.\nme@${state.hostname}: Permission denied (none).`, 255)
    }
    if (options.get('StrictHostKeyChecking') !== 'yes') fail('fake ssh requires strict host key checking', 2)
    const entries = files.flatMap(recorded).filter(fields => fields[0] === name)
    if (entries.length === 0) fail('Host key verification failed.', 255)
    if (!entries.some(fields => fields[1] === state.keyType && fields[2] === state.keyBase64)) {
      fail('@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@', 255)
    }
    const child = spawn('/bin/sh', ['-c', args[index + 2]!], { stdio: 'inherit' })
    child.on('exit', (code) => { process.exit(code ?? 1) })
    break
  }
  case 'keygen': {
    if (args[0] === '-F') {
      const lines = recorded(args[3]!).filter(fields => fields[0] === args[1])
      process.stdout.write(lines.map(fields => `${fields.join(' ')}\n`).join(''))
      process.exitCode = lines.length > 0 ? 0 : 1
      break
    }
    if (state.keygenFails) fail('(stdin) is not a public key file.', 255)
    const [host, type, key] = readFileSync(0, 'utf8').trim().split(' ')
    const digest = createHash('sha256').update(Buffer.from(key!, 'base64')).digest('base64').replace(/=+$/, '')
    process.stdout.write(`256 SHA256:${digest} ${host} (${type!.replace(/^ssh-/, '').toUpperCase()})\n`)
    break
  }
  default: fail(`unknown fake tool ${tool}`, 2)
}
