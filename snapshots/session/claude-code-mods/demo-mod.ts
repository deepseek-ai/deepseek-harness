import { defineMod } from '@deepseek-ai/dsh-experimental-claude-code-mods'

/**
 * A mod whose effects reach the Session log: it adds a context line after
 * each prompt and refuses a force push, so the recording shows what the
 * model sees from a `prompt.submit` rewrite and a `tool.call` deny.
 */
export default defineMod({
  name: 'snapshot-guard',
  version: '0.1.0',
  register(on) {
    on('prompt.submit', async (_$, e, next) => {
      const r = await next(e)
      return { ...r, context: [...r.context ?? [], 'Context from the snapshot-guard mod: this workspace is a demo checkout.'] }
    })
    on('tool.call', { tool: 'Bash' }, (_$, e, next) => {
      if (/\bgit\s+push\b[^\n]*\s(--force|-f)\b/u.test(String(e.command ?? ''))) {
        return { deny: `snapshot-guard refused this command: ${String(e.command)}` }
      }
      return next(e)
    })
  },
})
