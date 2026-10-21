/** Own fixture services outside the managed, short-lived native launcher. */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

/**
 * Start a test-owned service launcher for one private helper copy.
 * @param {string} helperPath - Executable copied into the test workspace.
 * @returns {Promise<() => Promise<void>>} Cleanup that awaits every owned service exit.
 */
export async function startFixtureHost(helperPath) {
  helperPath = await realpath(helperPath)
  const source = await readFile(helperPath, 'utf8')
  const marker = `\n// Fixture host: ${JSON.stringify(helperPath)}\n`
  if (!source.includes(marker)) await appendFile(helperPath, marker)
  const runtimeKey = createHash('sha256').update(await readFile(helperPath)).digest('hex')
  const directory = `/tmp/dsh-cua-${userInfo().uid}`
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const children = new Set()
  const sockets = new Set()
  let current
  let closing = false

  function ensureService(timeoutMs) {
    if (current && current.child.exitCode === null && current.child.signalCode === null) return current.ready
    const child = spawn(process.execPath, [helperPath, '--serve', '--runtime-key', runtimeKey,
      '--runtime-directory', directory, '--startup-timeout-ms', String(timeoutMs)], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    })
    const done = new Promise(resolve => { child.once('close', resolve) })
    const ready = new Promise((resolve, reject) => {
      child.once('message', () => { resolve() })
      child.once('error', reject)
      child.once('exit', (code, signal) => reject(new Error(`Fixture service exited before readiness: ${code}, ${signal}`)))
    })
    const timer = setTimeout(() => { child.kill('SIGKILL') }, timeoutMs)
    const service = { child, done, ready: ready.finally(() => { clearTimeout(timer) }) }
    current = service
    children.add(service)
    void done.then(() => { children.delete(service); if (current === service) current = undefined })
    return service.ready
  }

  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => { sockets.delete(socket) })
    const input = createInterface({ input: socket })
    input.once('line', (line) => {
      const reply = async () => {
        try {
          if (closing) throw new Error('Fixture host is closing')
          await ensureService(Number(line))
          socket.end('ready\n')
        } catch (error) { socket.end(`error: ${error.message}\n`) }
      }
      void reply()
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ path: join(directory, `${runtimeKey}.fixture.sock`) }, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  return async () => {
    closing = true
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => { server.close(resolve) })
    const timer = setTimeout(() => {
      for (const { child } of children) child.kill('SIGKILL')
    }, 5000)
    try { await Promise.all([...children].map(service => service.done)) }
    finally { clearTimeout(timer); await writeFile(helperPath, source) }
  }
}
