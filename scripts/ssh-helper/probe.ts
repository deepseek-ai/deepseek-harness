/** Short handshake against an actual executable, with bounded process ownership. */
import { spawn } from 'node:child_process'
import { z } from 'zod'
import { SshRpcPeer, SSH_PROTOCOL_VERSION } from '../../packages/ssh/ssh/src/protocol.ts'
import { helloSchema } from '../../packages/ssh/ssh/src/schemas.ts'

/**
 * Run a packaged helper and read its runtime version through the private wire protocol.
 * @param executable - physical executable under test.
 * @param workspace - existing directory supplied for the handshake.
 * @returns the validated handshake after the helper has exited.
 */
export async function probeHelper(executable: string, workspace: string): Promise<z.infer<typeof helloSchema>> {
  const child = spawn(executable, [], { cwd: workspace, env: { ...process.env, NODE_OPTIONS: '--disable-sigusr1' }, stdio: ['pipe', 'pipe', 'pipe'] })
  let diagnostic = ''
  child.stderr.on('data', (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString()).slice(-8192) })
  const closed = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0 && signal === null) resolve()
      else reject(new Error(`SSH helper probe exited (${code ?? signal}): ${diagnostic}`))
    })
  })
  void closed.catch(() => {})
  const rpc = new SshRpcPeer(child.stdout, child.stdin, 64 * 1024 * 1024, 128)
  child.once('error', (error) => { rpc.close(error) })
  const force = setTimeout(() => { child.kill('SIGKILL') }, 30_000)
  try {
    const hello = await rpc.request('hello', { protocol: SSH_PROTOCOL_VERSION, workspace, leaseMs: 30_000 }, helloSchema, AbortSignal.timeout(20_000))
    await rpc.request('close', {}, z.null(), AbortSignal.timeout(5000))
    child.stdin.end()
    await closed
    return hello
  } catch (error) {
    child.kill('SIGTERM')
    await closed.catch(() => {})
    throw new Error(`SSH helper handshake failed: ${diagnostic}`, { cause: error })
  } finally {
    clearTimeout(force)
    rpc.close()
  }
}
