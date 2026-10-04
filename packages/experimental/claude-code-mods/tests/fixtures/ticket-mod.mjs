// A mod that adds a tool for the model, context for the model, and a line
// under each answer, from the examples on Claude Code's mods API page.

const TICKETS = { 'T-1': 'Login button does nothing (open)' }

export function register(on) {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'ticket',
      description: 'Look up a ticket by its id and return its title and status',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    })
    return next(e)
  })

  // The full tool name is mcp__, the plugin's name, and the registered name
  on('tool.call', { tool: 'mcp__ticket-mod__ticket' }, async ($, e) => {
    return { result: TICKETS[e.id] ?? 'Lookup failed: no ticket ' + e.id }
  })

  on('prompt.submit', async ($, e, next) => {
    if (!/\bPR\b|pull request/i.test(e.text)) return next(e)
    return next({ ...e, context: [...(e.context ?? []), 'Current branch: feature/mods'] })
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    return { ...result, text: 'Done in ' + (e.durationMs >= 0 ? 'some' : 'negative') + ' ms' }
  })
}
