/** Raw JSON-RPC probe over the profile's stdio: every stdout line must be a protocol frame. */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

/** One observed child exit; a graceful EOF exit carries code zero and no signal. */
export interface ProbeExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

/** Test-side requests and explicit process ownership. */
export interface McpProbe {
  /**
   * @param method - JSON-RPC method.
   * @param params - JSON params.
   * @returns The matching result; a protocol error or a non-protocol stdout line rejects pending and later requests.
   */
  request(method: string, params?: object): Promise<unknown>
  /** @param method - Notification method. @param params - JSON params. */
  notify(method: string, params?: object): void
  /** @returns Captured stderr, which the protocol never uses. */
  stderr(): string
  /** @returns The exit observed after stdin EOF. */
  close(): Promise<ProbeExit>
  /** Stop a failed fixture and await its exit. */
  terminate(): Promise<void>
}

/**
 * Start the built CLI with the given arguments and hold its stdio.
 * @param options - Executable arguments, working directory, and environment.
 * @returns The probe; `terminate` must run even after a failed assertion.
 */
export function startProbe(options: { readonly args: readonly string[]; readonly cwd: string; readonly env: NodeJS.ProcessEnv }): McpProbe {
  const child = spawn(process.execPath, [...options.args], { cwd: options.cwd, env: options.env, stdio: 'pipe' })
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
  let nextId = 0
  let ended = false
  let failure: Error | undefined
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  const fail = (error: Error): void => {
    failure ??= error
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  }
  child.on('error', fail)
  child.stdin.on('error', fail)
  const closed = new Promise<ProbeExit>((resolve) => {
    child.once('close', (code, signal) => {
      ended = true
      fail(new Error(`cua-mcp exited before replying (${String(code)}, ${String(signal)}): ${stderr}`))
      resolve({ code, signal })
    })
  })
  const reading = (async () => {
    for await (const line of createInterface({ input: child.stdout })) {
      let parsed: unknown
      try { parsed = JSON.parse(line) } catch { parsed = undefined }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || Reflect.get(parsed, 'jsonrpc') !== '2.0') {
        throw new Error(`cua-mcp wrote a non-protocol line to stdout: ${line}`)
      }
      const frame = parsed as { id?: number; method?: string; result?: unknown; error?: unknown }
      if (frame.id === undefined) continue
      const request = pending.get(frame.id)
      if (request === undefined) throw new Error(`cua-mcp replied to an unknown request ${String(frame.id)}`)
      pending.delete(frame.id)
      if (frame.error === undefined) request.resolve(frame.result)
      else request.reject(new Error(`MCP request failed: ${JSON.stringify(frame.error)}`))
    }
  })().catch((error: unknown) => { fail(error instanceof Error ? error : new Error(String(error))) })
  const write = (message: object): void => { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`) }
  return {
    async request(method, params) {
      if (failure !== undefined) throw failure
      if (ended) throw new Error('cua-mcp is closed')
      const id = ++nextId
      const response = Promise.withResolvers<unknown>()
      const timer = setTimeout(() => {
        pending.delete(id)
        response.reject(new Error(`MCP ${method} did not reply: ${stderr}`))
      }, 90_000)
      pending.set(id, { resolve: response.resolve, reject: response.reject })
      write({ id, method, ...params === undefined ? {} : { params } })
      try { return await response.promise } finally { clearTimeout(timer) }
    },
    notify(method, params) { write({ method, ...params === undefined ? {} : { params } }) },
    stderr: () => stderr,
    async close() {
      child.stdin.end()
      const exit = await closed
      await reading
      if (failure !== undefined && !failure.message.startsWith('cua-mcp exited before replying')) throw failure
      return exit
    },
    async terminate() {
      if (!ended) child.kill('SIGKILL')
      await closed
      await reading
    },
  }
}
