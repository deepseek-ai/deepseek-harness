/** Test-only transport to a real helper executable, retaining authenticated local stream sockets. */
import { spawn } from 'node:child_process'
import { createConnection, type Socket } from 'node:net'
import { once } from 'node:events'
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { SshRpcPeer, SSH_PROTOCOL_VERSION } from '../../../ssh/src/protocol.ts'
import { helloSchema, type SshStreamEndpoint } from '../../../ssh/src/schemas.ts'
import { authenticateStream } from '../../../ssh/src/stream-security.ts'

interface Config { executable: string; helperHash: string; workspace: string; home: string; path: string }

/** Loader-mounted fixture; only its administrative transport differs from SshConnection. */
export default class DirectHelper extends Service {
  readonly ready: Promise<z.infer<typeof helloSchema>>
  private readonly rpc: SshRpcPeer
  private readonly child: ReturnType<typeof spawn>
  private readonly exited: Promise<void>
  private readonly sockets = new Set<Socket>()
  private closing: Promise<void> | undefined
  private diagnostic = ''
  private readonly deadline: NodeJS.Timeout

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'ssh')
    const child = spawn(config.executable, [], {
      cwd: config.workspace, stdio: ['pipe', 'pipe', 'pipe'],
      env: { HOME: config.home, PATH: config.path, TMPDIR: config.home, NODE_OPTIONS: '--disable-sigusr1', DSH_ARTIFACT_SECRET: 'must-not-reach-program' },
    })
    this.child = child
    this.exited = new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => {
        if (code === 0 && signal === null) resolve()
        else reject(new Error(`Artifact helper exited (${code ?? signal}): ${this.diagnostic}`))
      })
    })
    void this.exited.catch(() => {})
    child.stderr.on('data', (chunk: Buffer) => { this.diagnostic = (this.diagnostic + chunk.toString()).slice(-8192) })
    this.rpc = new SshRpcPeer(child.stdout, child.stdin, 64 * 1024 * 1024, 128)
    child.once('error', (error) => { this.rpc.close(error) })
    this.deadline = setTimeout(() => { child.kill('SIGKILL') }, 90_000)
    this.ready = this.rpc.request('hello', { protocol: SSH_PROTOCOL_VERSION, workspace: config.workspace, leaseMs: 60_000 }, helloSchema, AbortSignal.timeout(20_000))
      .then((hello) => {
        assert.equal(hello.hash, config.helperHash)
        assert.equal(hello.executable, config.executable)
        return hello
      })
    void this.ready.catch(() => {})
    ctx.effect(() => () => this.dispose())
  }

  async [Service.init](): Promise<void> { await this.ready }

  get ptcLaunch(): { kind: 'embedded'; executable: string } { return { kind: 'embedded', executable: this.config.executable } }

  async request<T>(method: string, params: unknown, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    return this.rpc.request(method, params, schema, signal ?? AbortSignal.timeout(30_000))
  }

  async connectStream(endpoint: SshStreamEndpoint): Promise<Socket> {
    const socket = createConnection({ path: endpoint.path, allowHalfOpen: true })
    this.own(socket)
    await once(socket, 'connect')
    const secure = await authenticateStream(socket, endpoint.capability, 10_000)
    this.own(secure)
    return secure
  }

  private own(socket: Socket): void {
    this.sockets.add(socket)
    socket.on('error', () => { socket.destroy() })
    socket.once('close', () => { this.sockets.delete(socket) })
  }

  dispose(): Promise<void> { this.closing ??= this.close(); return this.closing }

  private async close(): Promise<void> {
    try {
      await this.ready
      await this.rpc.request('close', {}, z.null(), AbortSignal.timeout(10_000))
      this.child.stdin?.end()
    } finally {
      this.rpc.close()
      const sockets = [...this.sockets].reverse().map(async (socket) => {
        const closed = socket.closed ? Promise.resolve() : once(socket, 'close').catch(() => {})
        socket.destroy()
        await closed
      })
      this.child.stdin?.destroy()
      try { await this.exited; await Promise.all(sockets) }
      finally { clearTimeout(this.deadline) }
    }
  }
}
