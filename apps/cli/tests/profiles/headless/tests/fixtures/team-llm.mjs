/** Deterministic keyless Agent Teams adapter shared by profile snapshot and CLI e2e. */

import { brandString } from '@deepseek-ai/dsh-brand'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

let nextCall = 0

function calls(messages) {
  return messages.flatMap(message => message.role === 'assistant'
    ? message.content.filter(block => block.type === 'tool-call').map(block => block.name)
    : [])
}

function latestAssistantCalls(messages) {
  const assistant = messages.findLast(message => message.role === 'assistant')
  return assistant?.content.filter(block => block.type === 'tool-call').map(block => block.name) ?? []
}

function hasNewCoordinationInput(messages) {
  const toolIndex = messages.findLastIndex(message => message.role === 'tool')
  return messages.some((message, index) => index > toolIndex && message.role === 'user'
    && ['agent-message', 'subagent-settled'].includes(message.source?.kind))
}

function hasTaskAction(messages, action) {
  return messages.some(message => message.role === 'assistant'
    && message.content.some((block) => {
      if (block.type !== 'tool-call' || block.name !== 'team_task_update') return false
      try {
        return JSON.parse(block.arguments).action === action
      } catch {
        return false
      }
    }))
}

function latestToolText(messages) {
  const message = messages.findLast(candidate => candidate.role === 'tool')
  if (message === undefined) return ''
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

function toolChunks(specs) {
  const chunks = []
  for (const [index, spec] of specs.entries()) {
    /** @type {import('@deepseek-ai/dsh-llm/types').ToolCallId} */
    const id = brandString(`team-fixture-${++nextCall}`)
    const args = JSON.stringify(spec.args)
    chunks.push(
      { type: 'block-start', index, blockType: 'tool-call' },
      { type: 'tool-call-delta', index, id, name: spec.name, argumentsDelta: args },
      { type: 'block-end', index, block: { type: 'tool-call', id, name: spec.name, arguments: args } },
    )
  }
  chunks.push(
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  )
  return chunks
}

function textChunks(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function researcher(messages) {
  const names = calls(messages)
  if (!names.includes('list_agents')) return toolChunks([{ name: 'list_agents', args: {} }])
  const sibling = messages.filter(message => message.role === 'tool')
    .flatMap(message => message.content.filter(block => block.type === 'text').flatMap(block => block.text.split('\n')))
    .find(line => line.endsWith('— Own deterministic implementation.'))?.split(' ')[0]
  if (sibling === undefined) throw new Error('list_agents did not expose the implementation sibling')
  if (!names.includes('team_task_create')) {
    return toolChunks([{ name: 'team_task_create', args: {
      subject: 'Research', description: 'Collect the deterministic finding.', write_scopes: ['research'],
    } }])
  }
  if (!names.includes('team_task_update')) {
    return toolChunks([{ name: 'team_task_update', args: {
      task_id: 'task-1', expected_revision: 1, action: 'claim',
    } }])
  }
  if (!names.includes('send_message')) {
    return toolChunks([
      { name: 'team_task_update', args: { task_id: 'task-1', expected_revision: 2, action: 'complete' } },
      { name: 'send_message', args: { agent: sibling, message: 'Research complete: use the deterministic finding.' } },
    ])
  }
  return textChunks('Research teammate complete.')
}

function implementer(messages, parentId) {
  const names = calls(messages)
  const last = latestAssistantCalls(messages)
  const text = latestToolText(messages)
  const userText = messages.flatMap(message => message.role === 'user'
    ? message.content.filter(block => block.type === 'text').map(block => block.text)
    : []).join('\n')
  if (!names.includes('team_task_create')) {
    if (last.includes('team_task_get') && text.includes('"subject":"Research"')) {
      return toolChunks([{ name: 'team_task_create', args: {
        subject: 'Implementation',
        description: 'Apply the deterministic finding.',
        blocked_by: ['task-1'],
        write_scopes: ['implementation'],
      } }])
    }
    if (last.includes('wait_agent') || hasNewCoordinationInput(messages)) {
      return toolChunks([{ name: 'team_task_get', args: { task_id: 'task-1' } }])
    }
    return toolChunks([{ name: 'wait_agent', args: { timeout_ms: 10000 } }])
  }
  if (!hasTaskAction(messages, 'claim')) {
    if (last.includes('team_task_get') && text.includes('"status":"completed"')) {
      return toolChunks([{ name: 'team_task_update', args: {
        task_id: 'task-2', expected_revision: 1, action: 'claim',
      } }])
    }
    if (last.includes('team_task_get') && !hasNewCoordinationInput(messages)) {
      return toolChunks([{ name: 'wait_agent', args: { timeout_ms: 10000 } }])
    }
    if (last.includes('wait_agent') || hasNewCoordinationInput(messages)) {
      return toolChunks([{ name: 'team_task_get', args: { task_id: 'task-1' } }])
    }
    return toolChunks([{ name: 'team_task_get', args: { task_id: 'task-1' } }])
  }
  if (!userText.includes('Research complete: use the deterministic finding.')) {
    return toolChunks([{ name: 'wait_agent', args: { timeout_ms: 10000 } }])
  }
  if (!names.includes('send_message')) {
    return toolChunks([
      { name: 'team_task_update', args: { task_id: 'task-2', expected_revision: 2, action: 'complete' } },
      { name: 'send_message', args: { agent: parentId, message: 'Implementation complete and verified.' } },
    ])
  }
  return textChunks('Implementation teammate complete.')
}

function lead(messages) {
  const names = calls(messages)
  const last = latestAssistantCalls(messages)
  if (!names.includes('workflow')) {
    return toolChunks([{ name: 'workflow', args: {
      meta: { name: 'team-preflight', description: 'Check fresh workflow delegation alongside teammates.' },
      script: 'return await agent("TEAM_WORKFLOW_CHILD");',
    } }])
  }
  const spawned = names.filter(name => name === 'subagent').length
  if (spawned === 0) {
    return toolChunks([{
      name: 'subagent',
      args: {
        description: 'Own deterministic implementation.',
        prompt: 'IMPLEMENTER_MARK: wait for research, complete dependent task 2, report to lead.',
      },
    }])
  }
  if (spawned === 1) {
    return toolChunks([{
      name: 'subagent',
      args: {
        description: 'Own deterministic research.',
        prompt: 'RESEARCHER_MARK: complete research task 1, message implementer, then finish.',
      },
    }])
  }
  const result = latestToolText(messages)
  if (last.includes('team_task_list')) {
    const completed = result.match(/"status":"completed"/gu)?.length ?? 0
    if (completed >= 2) return toolChunks([{ name: 'list_agents', args: {} }])
    return toolChunks([{ name: hasNewCoordinationInput(messages) ? 'team_task_list' : 'wait_agent',
      args: hasNewCoordinationInput(messages) ? {} : { timeout_ms: 10000 } }])
  }
  if (last.includes('list_agents')) {
    const inactive = result.split('\n')
      .filter(row => row.includes('— Own deterministic ') && row.includes('[inactive]')).length
    if (inactive >= 2) return textChunks('TEAM_WORKFLOW_OK: both teammates and dependent tasks completed.')
    return toolChunks([{ name: hasNewCoordinationInput(messages) ? 'list_agents' : 'wait_agent',
      args: hasNewCoordinationInput(messages) ? {} : { timeout_ms: 10000 } }])
  }
  if (last.includes('wait_agent') || hasNewCoordinationInput(messages)) return toolChunks([{ name: 'team_task_list', args: {} }])
  return toolChunks([{ name: 'wait_agent', args: { timeout_ms: 10000 } }])
}

class TeamFixtureAdapter extends LlmAdapter {
  async * stream(options) {
    const tools = options.tools.map(tool => tool.name)
    const initial = options.messages.findLast(message => message.role === 'user' && message.source.kind === 'user')
    const workflowChild = initial?.content[0]?.text === 'TEAM_WORKFLOW_CHILD'
    const context = options.messages.findLast(message => message.source?.kind === 'runtime-context')
    const section = name => context?.source.sections?.find(candidate => candidate.name === name)?.text
    const role = section('subagent:identity')
    const parentId = role?.match(/You are a subagent delegated by agent "([^"]+)"/u)?.[1]
    const task = initial?.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    if (!workflowChild && (!tools.includes('subagent') || !tools.includes('workflow') || !tools.includes('team_task_create'))) {
      throw new Error('Team profile is missing delegation, workflow, or task tools')
    }
    let chunks
    if (workflowChild) chunks = textChunks('Fresh workflow child complete.')
    else if (task?.startsWith('RESEARCHER_MARK:')) chunks = researcher(options.messages)
    else if (task?.startsWith('IMPLEMENTER_MARK:')) chunks = implementer(options.messages, parentId)
    else if (role?.startsWith('You are the root agent. Your name is')) chunks = lead(options.messages)
    else throw new Error('Team runtime context is missing a recognized identity')
    for (const chunk of chunks) {
      options.signal?.throwIfAborted()
      yield chunk
    }
  }
}

/** Cordis plugin name. */
export const name = 'team-fixture-llm'
/** LLM registry dependency. */
export const inject = ['llm', 'tools', 'agentTeams']

/** Register the keyless adapter on the shipped default provider route. */
export function apply(ctx) {
  ctx.on('agent/created', async ({ agent }) => {
    if (agent.session.header.parentSession === undefined) await ctx.agentTeams.setEnabled(agent, true)
  })
  const implementerWaiting = Promise.withResolvers()
  const leadWaiting = Promise.withResolvers()
  for (const gate of [implementerWaiting, leadWaiting]) void gate.promise.catch(() => undefined)
  ctx.effect(() => () => {
    implementerWaiting.reject(new Error('Team fixture disposed before implementer wait'))
    leadWaiting.reject(new Error('Team fixture disposed before lead wait'))
  })
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.name === 'team_task_create' && exec.arguments.subject === 'Research') {
      await Promise.all([implementerWaiting.promise, leadWaiting.promise])
    }
    const result = next()
    if (exec.name === 'wait_agent') {
      if (exec.agent.session.header.origin === 'subagent') implementerWaiting.resolve()
      else leadWaiting.resolve()
    }
    return result
  })
  ctx.llm.registerAdapter(['deepseek-official'], new TeamFixtureAdapter())
}
