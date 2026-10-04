// A tool.call guard in the style of Claude Code's events page: refuse a
// force push, log what ran, and fail closed through `.catch`.

const RISKY = /\bgit\s+push\b.*--force|\brm\s+-rf?\b/

async function guard($, e, next) {
  if (e.command === 'explode') throw new Error('guard exploded')
  if (RISKY.test(String(e.command ?? ''))) {
    return { deny: 'guard-mod refused this command: ' + e.command }
  }
  const result = await next(e)
  $.ui.log('ran ' + e.tool + ': ' + String(e.command ?? ''))
  return result
}

export function register(on) {
  on('tool.call', { tool: 'Bash' }, guard).catch(async ($, e, next) => {
    return { deny: 'The command guard failed, so this command was not run: ' + next.error.kind }
  })
}
