/** Protocol peer with controllable query settlement and independently serviced requests. */
import { createInterface } from 'node:readline'

interface Frame {
  id?: string | number
  method: string
  params?: Record<string, unknown>
}

const queries: Record<string, unknown>[] = []
const methods: string[] = []
const promptFinishes = new Map<string, () => void>()
const commandFinishes = new Map<string, () => void>()
let seq = 0

function write(frame: object): void {
  process.stdout.write(JSON.stringify(frame) + '\n')
}

function notify(method: string, params: object): void {
  write({ jsonrpc: '2.0', method, params })
}

function event(sessionId: string, type: string, data: object): void {
  notify('session.event', { sessionId, event: { type, seq: seq++, time: 0, data } })
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const frame = JSON.parse(line) as Frame
  methods.push(frame.method)
  const respond = (result: unknown): void => { write({ jsonrpc: '2.0', id: frame.id, result }) }
  if (frame.method === 'initialize') {
    respond({ serverInfo: { name: 'query-fixture', version: '1' } })
  } else if (frame.method === 'session/query') {
    const params = frame.params ?? {}
    queries.push(params)
    const sessionId = String(params.sessionId)
    const blocks = params.contentBlocks as { type: string; text?: string }[]
    const text = blocks.filter(block => block.type === 'text').map(block => block.text).join('\n')
    if (process.env.QUERY_DISCONNECT !== undefined) {
      process.exit(13)
    }
    if (process.env.QUERY_RESULT !== undefined) {
      const response = JSON.parse(process.env.QUERY_RESULT) as {
        kind?: string
        execution?: { commandId: string; result?: { kind: string; text?: string } }
      } | null
      if (response?.kind === 'command' && response.execution?.result !== undefined) {
        const lifecycle = process.env.QUERY_LIFECYCLE
        if (lifecycle !== 'missing-run' && lifecycle !== 'missing-both') {
          event(sessionId, 'command/run', { commandId: response.execution.commandId })
        }
        if (lifecycle === 'invalid-done') {
          notify('session.event', { sessionId, event: { type: 'command/done', seq: seq++, time: 0, data: null } })
        } else if (lifecycle !== 'missing-done' && lifecycle !== 'missing-both' && lifecycle !== 'late-done') {
          event(sessionId, 'command/done', {
            commandId: lifecycle === 'unrelated-done' ? 'another-command' : response.execution.commandId,
            ...response.execution.result,
          })
        }
        notify('session.query.completed', { sessionId, commandId: response.execution.commandId,
          finalResponse: response.execution.result.text ?? '',
          finishReason: response.execution.result.kind === 'error' ? 'error' : 'completed',
          ...JSON.parse(process.env.QUERY_COMPLETION ?? '{}') as object })
        if (lifecycle === 'late-done') {
          event(sessionId, 'command/done', { commandId: response.execution.commandId, ...response.execution.result })
        }
      }
      respond(response)
      return
    }
    if (text === process.env.QUERY_ERROR_TEXT) {
      write({ jsonrpc: '2.0', id: frame.id, error: { code: -32603, message: 'scripted query failure' } })
      return
    }
    if (text === '/compact') {
      const commandId = `command-${queries.length}`
      const result = promptFinishes.has(sessionId)
        ? { kind: 'error', text: 'busy' }
        : { kind: 'success', text: 'compacted', sourceEventSeq: 0 }
      event(sessionId, 'command/run', { commandId, name: 'compact', args: '', source: { kind: 'user' } })
      const finish = (): void => {
        commandFinishes.delete(sessionId)
        event(sessionId, 'command/done', { commandId, ...result })
        notify('session.query.completed', { sessionId, commandId, finalResponse: result.text,
          finishReason: result.kind === 'error' ? 'error' : 'completed' })
        respond({ kind: 'command', execution: { commandId, result } })
      }
      if (process.env.QUERY_HOLD_COMMAND !== undefined && !promptFinishes.has(sessionId)) {
        commandFinishes.set(sessionId, finish)
      } else {
        finish()
      }
      return
    }
    if (text === '/plan hold' || text === '/plan disconnect') {
      const commandId = `command-${queries.length}`
      event(sessionId, 'command/run', { commandId, name: 'plan' })
      event(sessionId, 'agent/inbox/spliced', { inserted: [{ id: `input-${queries.length}` }] })
      event(sessionId, 'command/done', { commandId, kind: 'success', text: 'plan enabled' })
      respond({ kind: 'command', execution: { commandId, result: { kind: 'success', text: 'plan enabled' } } })
      if (text === '/plan disconnect') process.exit(13)
      promptFinishes.set(sessionId, () => {
        promptFinishes.delete(sessionId)
        event(sessionId, 'assistant/message', { message: { content: [{ type: 'text', text: 'the generated plan' }] } })
        event(sessionId, 'turn/end', { reason: { kind: 'completed' } })
        notify('session.status', { sessionId, status: 'idle' })
        notify('session.query.completed', { sessionId, commandId, finalResponse: 'the generated plan', finishReason: 'completed' })
      })
      return
    }
    const messageId = `input-${queries.length}`
    event(sessionId, 'assistant/message', { message: { content: [{ type: 'text', text: 'before receipt' }] } })
    event(sessionId, 'agent/inbox/spliced', {
      target: 'next-turn',
      start: 0,
      inserted: [{ id: messageId, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }],
    })
    notify('session.status', { sessionId, status: 'running' })
    const finish = (): void => {
      promptFinishes.delete(sessionId)
      if (text === 'with-child') {
        notify('subagent.started', { parentSessionId: sessionId, childSessionId: 'child' })
        event('child', 'assistant/message', { message: { content: [{ type: 'text', text: 'child answer' }] } })
        event('unrelated', 'assistant/message', { message: { content: [{ type: 'text', text: 'unrelated answer' }] } })
      }
      event(sessionId, 'assistant/message', { message: { content: [{ type: 'text', text: `reply:${text}` }] } })
      event(sessionId, 'turn/end', { turn: queries.length, reason: { kind: 'completed' } })
      notify('session.status', { sessionId, status: 'idle' })
    }
    if (text === 'hold') {
      promptFinishes.set(sessionId, finish)
      respond({ kind: 'prompt', messageId })
    } else {
      finish()
      respond({ kind: 'prompt', messageId })
    }
  } else if (frame.method === 'test/state') {
    respond({ queries, methods, waitingPrompts: promptFinishes.size, waitingCommands: commandFinishes.size })
  } else if (frame.method === 'test/release') {
    for (const finish of [...promptFinishes.values(), ...commandFinishes.values()]) finish()
    respond({})
  } else if (frame.method === 'test/disconnect') {
    process.exit(13)
  } else if (frame.method === 'shutdown') {
    respond({})
    setImmediate(() => process.exit(0))
  } else {
    write({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'unknown fixture method' } })
  }
})
