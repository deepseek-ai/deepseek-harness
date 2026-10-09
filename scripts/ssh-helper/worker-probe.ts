/** Run the embedded worker while macOS denies access to the checkout and host Node. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { Duplex, type Readable, type Writable } from 'node:stream'
import { join } from 'node:path'
import { z } from 'zod'
import { JsonChannel } from '../../packages/ptc-runtime/ptc-runtime-node/src/channel.ts'
import { decodePtcJsonWire } from '../../packages/ptc-runtime/ptc-runtime-node/src/json-wire.ts'
import { SUBPROCESS_CONTROL_ENV, SUBPROCESS_CONTROL_FD } from '../../packages/subprocess/subprocess/src/control.ts'

/**
 * Execute a PTC program with the host runtime and source files inaccessible.
 * @param executable - relocated helper executable.
 * @param workspace - isolated program working directory.
 * @param home - empty helper home and native-resource cache.
 * @param checkout - real source checkout path denied by Seatbelt.
 * @param hostNode - real host Node path denied by Seatbelt.
 */
export async function probeRestrictedWorker(
  executable: string, workspace: string, home: string, checkout: string, hostNode: string,
): Promise<void> {
  const profile = `(version 1)(allow default)${[checkout, hostNode].map(path => `(deny file-read* (subpath ${JSON.stringify(path)}))(deny process-exec (subpath ${JSON.stringify(path)}))`).join('')}`
  const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, executable, '1048576'], {
    cwd: workspace, env: { HOME: home, TMPDIR: home, PATH: '/usr/bin:/bin', DSH_PTC_RUNTIME_NODE: '1', [SUBPROCESS_CONTROL_ENV]: 'pipe', NODE_OPTIONS: '--disable-sigusr1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore', 'ignore', 'pipe'],
  })
  const completed = Promise.withResolvers<unknown>()
  let diagnostic = ''
  assert(child.stderr !== null && child.stdout !== null)
  child.stderr.on('data', (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString()).slice(-8192) })
  child.stdout.resume()
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0 && signal === null) resolve()
      else reject(new Error(`Restricted PTC worker exited (${code ?? signal}): ${diagnostic}`))
    })
  })
  void exited.catch((error: unknown) => { completed.reject(error) })
  const streams: ReadonlyArray<Readable | Writable | null | undefined> = child.stdio
  const control = streams[SUBPROCESS_CONTROL_FD]
  assert(control instanceof Duplex)
  const channel = new JsonChannel(control, 1_048_576, (raw) => {
    const message = z.object({ type: z.string(), value: z.unknown().optional(), error: z.unknown().optional() }).parse(raw)
    if (message.type === 'ready') {
      const code = `const fs=await import('node:fs/promises'); const denied=[]; for(const path of ${JSON.stringify([join(checkout, 'package.json'), hostNode])}) { try { await fs.readFile(path); denied.push('readable') } catch(error) { denied.push(error.code) } } return {executable:process.execPath,env:Object.keys(process.env),denied};`
      void channel.send({ type: 'boot', data: { code, namespaces: [], maxOutputBytes: 65_536 } })
        .catch((error: unknown) => { completed.reject(error) })
    } else if (message.type === 'done') {
      if (message.error !== undefined) completed.reject(new Error(JSON.stringify(message.error)))
      else completed.resolve(decodePtcJsonWire(message.value))
      channel.close()
    } else completed.reject(new Error(`Unexpected restricted-worker message: ${message.type}`))
  }, (error) => { completed.reject(error) })
  const force = setTimeout(() => { child.kill('SIGKILL') }, 20_000)
  try {
    const result = z.object({ executable: z.string(), env: z.array(z.string()), denied: z.array(z.enum(['EPERM', 'EACCES'])) }).parse(await completed.promise)
    assert.equal(result.executable, executable)
    assert.deepEqual(result.env, [])
    assert.equal(result.denied.length, 2)
    await exited
  } finally {
    channel.close()
    child.kill('SIGTERM')
    try { await exited } finally { clearTimeout(force) }
  }
}
