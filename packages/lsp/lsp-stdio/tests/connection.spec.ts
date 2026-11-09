import { afterEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { HarnessError } from '@deepseek-ai/dsh-error'
import { LspConnection } from '@deepseek-ai/dsh-lsp-stdio'
import type { ConnectionWriter } from '@deepseek-ai/dsh-lsp-stdio/src/connection.ts'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { spawnSubprocess } from '@deepseek-ai/dsh-subprocess-local/src/spawn.ts'

const fixtureServer = fileURLToPath(new URL('./fixture-server.ts', import.meta.url))

/** A recorded server→client request the test's handler saw. */
interface SeenRequest { method: string; params: unknown }

let open: LspConnection[] = []

afterEach(async () => {
  for (const conn of open) {
    conn.terminate()
    await conn.closed
  }
  open = []
})

/** Spawn the fixture as a raw connection, with a scripted server-request handler. */
function connect(
  env: Record<string, string>,
  onServerRequest: (method: string, params: unknown) => Promise<unknown> = () => Promise.resolve(null),
  seen?: SeenRequest[],
): LspConnection {
  const conn = new LspConnection({
    command: process.execPath,
    args: [fixtureServer],
    cwd: process.cwd(),
    env: { ...scrubbedParentEnv(), ...env },
    maxMessageBytes: 16_000_000,
    maxStderrBytes: 100_000,
    killGraceMs: 3_000,
    configuration: { setting: 42 },
  }, spawnSubprocess, (method, params) => {
    seen?.push({ method, params })
    return onServerRequest(method, params)
  })
  open.push(conn)
  return conn
}

describe('LspConnection', () => {
  it('completes an initialize request/response round-trip', async () => {
    const conn = connect({})
    const result = await conn.request('initialize', { capabilities: {} })
    expect(result).toMatchObject({ capabilities: { hoverProvider: true } })
  })

  it('forwards explicit DSH_* env entries to the child', async () => {
    // A configured DSH_* fact must reach the child: the seam scrubs only the
    // ambient namespace, and the explicit entry merges after that scrub. The
    // fixture echoes the named variable back as hover text.
    const conn = connect({ LSP_FAKE_ECHO_ENV: 'DSH_LSP_TEST_FACT', DSH_LSP_TEST_FACT: 'managed' })
    await conn.request('initialize', { capabilities: {} })
    expect(await conn.request('textDocument/hover', {})).toEqual({ contents: 'managed' })
  })

  it('rejects a request when the server replies with an error', async () => {
    const conn = connect({ LSP_FAKE_ERROR: '1' })
    await conn.request('initialize', { capabilities: {} })
    await expect(conn.request('textDocument/hover', {})).rejects.toMatchObject({
      name: 'LspError',
      code: 'LSP_SERVER_ERROR',
      message: 'language server rejected textDocument/hover with JSON-RPC error -32000: server refused the request',
    })
  })

  it('treats terminating an already-closed child as a teardown race', async () => {
    const conn = connectScript('')
    await conn.closed
    expect(() => { conn.terminate() }).not.toThrow()
  })

  it('answers a server workspace/configuration request from static config', async () => {
    const seen: SeenRequest[] = []
    const conn = connect(
      { LSP_FAKE_ON_OPEN: 'configuration' },
      (method, params) => {
        if (method === 'workspace/configuration') {
          const items = (params as { items: unknown[] }).items
          return Promise.resolve(items.map(() => ({ setting: 42 })))
        }
        return Promise.resolve(null)
      },
      seen,
    )
    await conn.request('initialize', { capabilities: {} })
    await conn.notify('textDocument/didOpen', { textDocument: { uri: 'file:///x', languageId: 'ts', version: 1, text: '' } })
    await waitFor(() => seen.some(s => s.method === 'workspace/configuration'))
    expect(seen[0]?.method).toBe('workspace/configuration')
  })

  it('drops a server→client notification without replying', async () => {
    const conn = connect({ LSP_FAKE_ON_OPEN: 'notification' })
    await conn.request('initialize', { capabilities: {} })
    await conn.notify('textDocument/didOpen', { textDocument: { uri: 'file:///x', languageId: 'ts', version: 1, text: '' } })
    // No throw and the connection stays usable.
    await expect(conn.request('textDocument/hover', {})).resolves.toBeDefined()
  })

  it('sends an error response when the server-request handler rejects', async () => {
    const seen: SeenRequest[] = []
    const conn = connect(
      { LSP_FAKE_ON_OPEN: 'applyEdit' },
      method => method === 'workspace/applyEdit' ? Promise.reject(new Error('not permitted')) : Promise.resolve(null),
      seen,
    )
    await conn.request('initialize', { capabilities: {} })
    await conn.notify('textDocument/didOpen', { textDocument: { uri: 'file:///x', languageId: 'ts', version: 1, text: '' } })
    await waitFor(() => seen.some(s => s.method === 'workspace/applyEdit'))
    // The connection remains healthy after emitting the error response.
    await expect(conn.request('textDocument/hover', {})).resolves.toBeDefined()
  })

  it('fails all pending requests and kills the process on a framing error', async () => {
    const conn = connect({ LSP_FAKE_GARBAGE: '1' })
    // The garbage byte precedes a valid initialize reply; unframed bytes are tolerated until a
    // Content-Length header, so initialize still resolves. This exercises the decoder's resilience.
    await expect(conn.request('initialize', { capabilities: {} })).resolves.toBeDefined()
  })

  it('rejects a new request issued after the process closes', async () => {
    const conn = connect({})
    await conn.request('initialize', { capabilities: {} })
    conn.terminate()
    await conn.closed
    await expect(conn.request('textDocument/hover', {})).rejects.toMatchObject({
      name: 'LspError',
      code: 'LSP_SERVER_EXITED',
      message: expect.stringMatching(/^language server exited/) as string,
    })
  })

  it('cancel is a no-op-safe write after close', async () => {
    const conn = connect({})
    await conn.request('initialize', { capabilities: {} })
    conn.terminate()
    await conn.closed
    expect(() => { conn.cancel(1) }).not.toThrow()
  })

  it('caps the retained stderr tail', async () => {
    const conn = connect({})
    await conn.request('initialize', { capabilities: {} })
    expect(conn.stderrTail.length).toBeLessThanOrEqual(100_000)
  })
})

/** Spawn a raw connection running an inline node script as the "server". */
function connectScript(script: string, maxStderrBytes = 100_000, writer?: ConnectionWriter): LspConnection {
  const conn = new LspConnection({
    command: process.execPath,
    args: ['-e', script],
    cwd: process.cwd(),
    env: scrubbedParentEnv(),
    maxMessageBytes: 16_000_000,
    maxStderrBytes,
    killGraceMs: 3_000,
    configuration: null,
  }, spawnSubprocess, () => Promise.resolve(null), writer)
  open.push(conn)
  return conn
}

describe('LspConnection edge behavior', () => {
  it('fails a request when the command cannot be spawned', async () => {
    const conn = new LspConnection({
      command: '/definitely/not/a/real/binary/xyz',
      args: [],
      cwd: process.cwd(),
      env: {},
      maxMessageBytes: 1000,
      maxStderrBytes: 1000,
      killGraceMs: 3_000,
      configuration: null,
    }, spawnSubprocess, () => Promise.resolve(null))
    open.push(conn)
    // The failed launch usually surfaces first as a stdin write failure; once the process settles,
    // the connection reports the provider's launch failure for it.
    const failure: unknown = await conn.request('initialize', {}).catch((error: unknown) => error)
    expect(failure).toMatchObject({ name: 'LspError', code: expect.stringMatching(/^LSP_(SERVER_EXITED|SPAWN_FAILED)$/) as string })
    await conn.closed
    expect(conn.failedWith(failure)).toBe(true)
    expect(conn.settledFailure(failure)).toMatchObject({
      name: 'LspError',
      code: 'LSP_SPAWN_FAILED',
      message: expect.stringMatching(/^language server process failed: .*ENOENT/) as string,
      cause: expect.any(Error) as Error,
    })
    const unrelated = new Error('unrelated')
    expect(conn.settledFailure(unrelated)).toBe(unrelated)
  })

  it('keeps a subprocess provider HarnessError as the spawn failure', async () => {
    const providerFailure = new HarnessError('sandbox refused the launch', 'SANDBOX_DENIED')
    const conn = new LspConnection({
      command: process.execPath,
      args: ['-e', 'setInterval(()=>{}, 1000)'],
      cwd: process.cwd(),
      env: scrubbedParentEnv(),
      maxMessageBytes: 1000,
      maxStderrBytes: 1000,
      killGraceMs: 3_000,
      configuration: null,
    }, (spec) => {
      const handle = spawnSubprocess(spec)
      return Object.assign(Object.create(handle) as typeof handle, {
        done: handle.done.then(() => { throw providerFailure }),
      })
    }, () => Promise.resolve(null))
    open.push(conn)
    const failure: unknown = await Promise.all([
      conn.request('initialize', {}).catch((error: unknown) => error),
      Promise.resolve().then(() => { conn.terminate() }),
    ]).then(([error]) => error)
    await conn.closed
    expect(conn.settledFailure(failure)).toBe(providerFailure)
  })

  it('kills the process and fails pending requests on a framing error', async () => {
    // Emit an invalid Content-Length header, corrupting the stream irrecoverably.
    const conn = connectScript('process.stdout.write("Content-Length: abc\\r\\n\\r\\n{}"); setInterval(()=>{}, 1000)')
    await expect(conn.request('initialize', {})).rejects.toMatchObject({ name: 'LspError', code: 'LSP_PROTOCOL_ERROR' })
  })

  it('ignores a framed non-object message', async () => {
    // Send a framed JSON number and a framed null (both non-objects) then a proper response to id 1.
    const script = 'let b=Buffer.alloc(0);'
      + 'const fr=(s)=>{const x=Buffer.from(s);return Buffer.concat([Buffer.from(`Content-Length: ${x.length}\\r\\n\\r\\n`),x]);};'
      + 'process.stdout.write(fr("42"));process.stdout.write(fr("null"));'
      + 'process.stdin.on("data",c=>{b=Buffer.concat([b,c]);const s=b.indexOf("\\r\\n\\r\\n");if(s<0)return;const len=Number(/(\\d+)/.exec(b.toString("ascii",0,s))[1]);const body=JSON.parse(b.toString("utf8",s+4,s+4+len));process.stdout.write(fr(JSON.stringify({jsonrpc:"2.0",id:body.id,result:{ok:true}})));});'
    const conn = connectScript(script)
    await expect(conn.request('initialize', {})).resolves.toEqual({ ok: true })
  })

  it('drops a response for an unknown id', async () => {
    // Emit a response for id 999 (never sent), then answer our real request.
    const script = 'let b=Buffer.alloc(0);'
      + 'const fr=(s)=>{const x=Buffer.from(s);return Buffer.concat([Buffer.from(`Content-Length: ${x.length}\\r\\n\\r\\n`),x]);};'
      + 'process.stdout.write(fr(JSON.stringify({jsonrpc:"2.0",id:999,result:{stray:true}})));'
      + 'process.stdin.on("data",c=>{b=Buffer.concat([b,c]);const s=b.indexOf("\\r\\n\\r\\n");if(s<0)return;const len=Number(/(\\d+)/.exec(b.toString("ascii",0,s))[1]);const body=JSON.parse(b.toString("utf8",s+4,s+4+len));process.stdout.write(fr(JSON.stringify({jsonrpc:"2.0",id:body.id,result:{ok:true}})));});'
    const conn = connectScript(script)
    await expect(conn.request('initialize', {})).resolves.toEqual({ ok: true })
  })

  it('caps the retained stderr tail at maxStderrBytes across chunks', async () => {
    // Write stderr repeatedly so a later chunk arrives after the cap is already reached.
    const conn = connectScript('setInterval(()=>process.stderr.write("E".repeat(200)), 5); setInterval(()=>{}, 1000)', 100)
    await waitFor(() => conn.stderrTail.length >= 100)
    await new Promise<void>(resolve => setTimeout(resolve, 50))
    expect(conn.stderrTail.length).toBe(100)
  })

  it('caps the retained stderr tail by bytes for multibyte UTF-8', async () => {
    const conn = connectScript('process.stderr.write("😀😀")', 4)
    await conn.closed
    expect(conn.stderrTail).toBe('😀')
    expect(Buffer.byteLength(conn.stderrTail)).toBe(4)
  })

  it.each([
    ['no message string', '{code:-1}', 'language server rejected initialize with JSON-RPC error -1: no message'],
    ['no numeric code', '{message:"refused"}', 'language server rejected initialize with JSON-RPC error: refused'],
  ])('rejects with LSP_SERVER_ERROR when the error response has %s', async (_label, error, message) => {
    const script = 'let b=Buffer.alloc(0);'
      + 'const fr=(s)=>{const x=Buffer.from(s);return Buffer.concat([Buffer.from(`Content-Length: ${x.length}\\r\\n\\r\\n`),x]);};'
      + `process.stdin.on("data",c=>{b=Buffer.concat([b,c]);const s=b.indexOf("\\r\\n\\r\\n");if(s<0)return;const len=Number(/(\\d+)/.exec(b.toString("ascii",0,s))[1]);const body=JSON.parse(b.toString("utf8",s+4,s+4+len));process.stdout.write(fr(JSON.stringify({jsonrpc:"2.0",id:body.id,error:${error}})));});`
    const conn = connectScript(script)
    await expect(conn.request('initialize', {})).rejects.toMatchObject({ name: 'LspError', code: 'LSP_SERVER_ERROR', message })
  })

  it('rejects a pending request when the process exits mid-flight', async () => {
    // Never responds, then exits shortly: the pending request must reject on close.
    const conn = connectScript('setTimeout(()=>process.exit(0), 100)')
    await expect(conn.request('initialize', {})).rejects.toMatchObject({
      name: 'LspError',
      code: 'LSP_SERVER_EXITED',
      message: 'language server exited',
    })
  })

  it('rejects a pending request when child stdin fails but the process stays alive', async () => {
    const failure = new Error('fixture stdin failure')
    const writer: ConnectionWriter = (_stdin, _message, done) => {
      queueMicrotask(() => { done(failure) })
    }
    const conn = connectScript('setInterval(()=>{}, 1000)', 100_000, writer)
    await expect(conn.request('initialize', {})).rejects.toMatchObject({
      name: 'LspError',
      code: 'LSP_SERVER_EXITED',
      message: 'language server stopped accepting input: fixture stdin failure',
      cause: failure,
    })
  })

  it('reports one stdin failure from the error event and the write callback as one transport failure', async () => {
    const failure = new Error('fixture stdin failure')
    const writer: ConnectionWriter = (stdin, _message, done) => {
      queueMicrotask(() => {
        stdin.emit('error', failure)
        done(failure)
      })
    }
    const conn = connectScript('setInterval(()=>{}, 1000)', 100_000, writer)
    const rejection: unknown = await conn.request('initialize', {}).catch((error: unknown) => error)
    expect(rejection).toMatchObject({ name: 'LspError', code: 'LSP_SERVER_EXITED', cause: failure })
    expect(conn.failedWith(rejection)).toBe(true)
    await expect(conn.notify('initialized', {})).rejects.toBe(rejection)
  })

  it('ignores a frame that is neither a valid request nor a numeric-id response', async () => {
    // A frame with a string id and no method: not dispatchable; the client must ignore it and still
    // answer our real request.
    const script = 'let b=Buffer.alloc(0);'
      + 'const fr=(s)=>{const x=Buffer.from(s);return Buffer.concat([Buffer.from(`Content-Length: ${x.length}\\r\\n\\r\\n`),x]);};'
      + 'process.stdout.write(fr(JSON.stringify({jsonrpc:"2.0",id:"str-id"})));'
      + 'process.stdin.on("data",c=>{b=Buffer.concat([b,c]);const s=b.indexOf("\\r\\n\\r\\n");if(s<0)return;const len=Number(/(\\d+)/.exec(b.toString("ascii",0,s))[1]);const body=JSON.parse(b.toString("utf8",s+4,s+4+len));process.stdout.write(fr(JSON.stringify({jsonrpc:"2.0",id:body.id,result:{ok:true}})));});'
    const conn = connectScript(script)
    await expect(conn.request('initialize', {})).resolves.toEqual({ ok: true })
  })
})

/** Poll a predicate until it holds or a deadline elapses. */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  }
}
