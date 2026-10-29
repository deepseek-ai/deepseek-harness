/** Deterministic keyless LLM for the real-profile acceptance base: one file write, then text. */

import { existsSync, writeFileSync } from 'node:fs'
import { ToolCallId, LlmAdapter } from '@deepseek-ai/dsh-llm'

let nextCall = 0
let callCount = 0

function textChunks(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function writeChunks(filePath, content) {
  const index = 0
  const id = ToolCallId(`base-fixture-${++nextCall}`)
  const args = JSON.stringify({ file_path: filePath, content })
  return [
    { type: 'block-start', index, blockType: 'tool-call' },
    { type: 'tool-call-delta', index, id, name: 'write', argumentsDelta: args },
    { type: 'block-end', index, block: { type: 'tool-call', id, name: 'write', arguments: args } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** One `read` call the fixture issues for the acceptance cases that exercise the read ceiling. */
function readChunks(filePath) {
  const index = 0
  const id = ToolCallId(`base-fixture-read-${++nextCall}`)
  const args = JSON.stringify({ file_path: filePath })
  return [
    { type: 'block-start', index, blockType: 'tool-call' },
    { type: 'tool-call-delta', index, id, name: 'read', argumentsDelta: args },
    { type: 'block-end', index, block: { type: 'tool-call', id, name: 'read', arguments: args } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/**
 * Wait for a case to release the write this turn is about to ask for.
 *
 * A turn that has not yet asked for its tool call is genuinely in flight, which is what lets an
 * acceptance case change the share driving it in between. The wait is bounded and loud: a case that
 * never releases the gate fails as a fixture fault instead of hanging the run.
 * @param path - File the case creates to release the write.
 * @param signal - Stream cancellation, so a stopped turn stops waiting for the gate.
 * @returns Nothing once the file exists.
 */
async function awaitGate(path, signal) {
  if (path === undefined || path === '') {
    throw new Error('CHILD_GATED_WRITE needs BASE_LLM_GATE to name its release file')
  }
  const deadline = Date.now() + 60_000
  while (!existsSync(path)) {
    signal?.throwIfAborted()
    if (Date.now() > deadline) throw new Error(`CHILD_GATED_WRITE was never released: ${path}`)
    await new Promise(resolve => { setTimeout(resolve, 100) })
  }
}

/** Text the fixture saw from the caller, in order. */
function userTexts(messages) {
  return messages.flatMap(message => message.role === 'user'
    ? message.content.filter(block => block.type === 'text').map(block => block.text)
    : [])
}

/**
 * One tool result is its own \`role: 'tool'\` message, so the check reads the newest one's text.
 * @returns the last tool result's text, or undefined when the conversation has none yet.
 */
function lastToolResult(messages) {
  for (const message of [...messages].reverse()) {
    if (message.role !== 'tool') continue
    return message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  }
  return undefined
}

class BaseFixtureAdapter extends LlmAdapter {
  async * stream(options) {
    const texts = userTexts(options.messages)
    const toolResult = lastToolResult(options.messages)
    // A repeated identical request means the fixture is looping; say so instead of hanging the run.
    const writeRequests = options.messages.flatMap(message => message.content
      .filter(block => block.type === 'tool-call' && block.name === 'write')).length
    // Injected context follows the prompt in the message list, so the newest marker decides the
    // turn rather than the last user text; older prompts stay in the history and must not.
    const command = [...texts].reverse()
      .find(text => ['NO_TOOL', 'WRITE_FILE', 'CHILD_TEXT', 'CHILD_GATED_WRITE', 'CHILD_WRITE', 'CHILD_SLOW', 'CHILD_READ']
        .some(marker => text.includes(marker))) ?? ''
    // A read case names the exact path after its marker, so one fixture serves every path.
    const readPath = command.startsWith('CHILD_READ ') ? command.slice('CHILD_READ '.length).trim() : ''
    // One read per read request, not one per path: a later request to read the same file must issue
    // its own read, or the session never records a fresh observation of what that request saw.
    const readRequests = texts.filter(text => text.includes('CHILD_READ')).length
    const readAsked = options.messages.flatMap(message => message.content)
      .filter(block => block.type === 'tool-call' && block.name === 'read').length >= readRequests
    // A write case asks once per request, whatever earlier turns already did.
    const writeMark = command.startsWith('CHILD_WRITE ') ? command.slice('CHILD_WRITE '.length).trim() : ''
    const writeAsked = options.messages.flatMap(message => message.content)
      .some(block => block.type === 'tool-call' && block.name === 'write'
        && String(block.arguments ?? '').includes(writeMark))
    // A gated write knows whether it has asked yet the same way, so its second call can answer the result.
    const gateMark = command.startsWith('CHILD_GATED_WRITE ')
      ? command.slice('CHILD_GATED_WRITE '.length).trim()
      : ''
    const gatedAsked = gateMark !== '' && options.messages.flatMap(message => message.content)
      .some(block => block.type === 'tool-call' && block.name === 'write'
        && String(block.arguments ?? '').includes(gateMark))
    // Each text answer echoes the request it answered, so a case can tie one answer to one prompt
    // instead of searching the whole history for an expected word.
    const answered = command.includes('NO_TOOL')
      ? `BASE_NO_TOOL_OK ${command}`
      : command.includes('CHILD_TEXT')
        ? `CHILD_TEXT_OK ${command}`
      : command.includes('CHILD_READ')
        ? readAsked ? 'CHILD_READ_DONE' : undefined
        : command.includes('CHILD_SLOW')
          ? `CHILD_SLOW_STARTED ${command}`
          // A gated write asks once, after its gate opens; the answer after the result finishes the turn.
          : command.includes('CHILD_GATED_WRITE')
            ? gatedAsked ? 'CHILD_GATED_WRITE_DONE' : undefined
          // A child write attempt asks once; the answer after its result lets the turn finish.
          : command.includes('CHILD_WRITE')
            ? writeAsked ? 'CHILD_WRITE_REFUSED' : undefined
            // A write the child already asked for and never got a result for is a loop, not a wait.
            : toolResult === undefined && writeRequests >= 1
              ? `BASE_FIXTURE_LOOPED writes=${String(writeRequests)}`
              : toolResult !== undefined ? 'BASE_TURN_2' : undefined
    let chunks
    if (answered !== undefined) chunks = textChunks(answered)
    else if (command.includes('CHILD_READ')) chunks = readChunks(readPath)
    else if (command.includes('CHILD_GATED_WRITE')) {
      // The case reads this to know the model was reached while its write is still withheld; the adapter
      // call itself is logged only once the gate opens.
      writeFileSync(`${String(process.env.BASE_LLM_GATE)}.waiting`, 'waiting\n')
      await awaitGate(process.env.BASE_LLM_GATE, options.signal)
      chunks = writeChunks('note.txt', `the child must not write this ${gateMark}\n`)
    } else {
      chunks = writeChunks('note.txt', command.includes('CHILD_WRITE')
        // The request's own token travels inside the written content, so this call is recognisably
        // the one that request asked for.
        ? `the child must not write this ${writeMark}\n`
        : 'hello from the real write tool\n')
    }
    const label = JSON.stringify(chunks.find(chunk => chunk.type === 'block-end')?.block ?? null).slice(0, 60)
    // Diagnostic only: the acceptance run points this at a temp file to count adapter calls and
    // record which marker the caller really sent.
    if (process.env.BASE_LLM_LOG) {
      const { appendFileSync } = await import('node:fs')
      callCount += 1
      appendFileSync(process.env.BASE_LLM_LOG, `call#${String(callCount)} tools=${JSON.stringify(
        options.tools?.map(t => t.name) ?? [])} command=${JSON.stringify(command.slice(0, 40))}`
        + ` toolResult=${String(toolResult !== undefined)} writes=${String(writeRequests)}`
        + ` -> ${label}\n`)
    }
    // A prompt that must be stopped by the caller: hold the turn open until its own cancellation
    // arrives, so a failed cancel surfaces as an error turn instead of a slow passing one.
    if (command.includes('CHILD_SLOW')) {
      // A stream that never finishes on its own: no terminal chunk is yielded, so the turn stays in
      // flight and only the caller's own cancellation can end it.
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: `CHILD_SLOW_STARTED ${command}` }
      for (let tick = 0; tick < 200; tick += 1) {
        options.signal?.throwIfAborted()
        await new Promise(resolve => { setTimeout(resolve, 100) })
      }
      throw new Error('CHILD_SLOW was never cancelled')
    }
    for (const chunk of chunks) {
      options.signal?.throwIfAborted()
      yield chunk
    }
  }
}

/** Cordis plugin name. */
export const name = 'base-fixture-llm'
/** LLM registry dependency. */
export const inject = ['llm']

/** Register the keyless adapter on the shipped default provider route. */
export function apply(ctx) {
  // Loaded marker: proves the loader activated this plugin, independently of any model call.
  if (process.env.BASE_LLM_LOADED) {
    try { writeFileSync(process.env.BASE_LLM_LOADED, 'loaded\n') } catch {}
  }
  ctx.llm.registerAdapter(['deepseek-official'], new BaseFixtureAdapter())
}
