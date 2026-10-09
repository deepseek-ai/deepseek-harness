import { defineMod } from '@deepseek-ai/dsh-experimental-claude-code-mods'

/**
 * Scenario mod: adds prompt context, reports current-directory operations,
 * and refuses forced Git pushes.
 */
export default defineMod({
  name: 'snapshot-guard',
  version: '0.1.0',
  register(on) {
    on('prompt.submit', async (_$, e, next) => {
      const r = await next(e)
      return { ...r, context: [...r.context ?? [], 'Context from the snapshot-guard mod: this workspace is a demo checkout.'] }
    })
    on('tool.call', { tool: 'working_directory' }, async ($, e, next) => {
      const result = await next(e)
      if (typeof e.cd !== 'string' || result.deny !== undefined || result.isError) return result
      const cwd = await $.session.cwd()
      const root = await $.session.root()
      const read = await $.fs.read('witness.txt')
      const exists = await $.fs.exists('witness.txt')
      const stat = await $.fs.stat('witness.txt')
      const listed = (await $.fs.list('.')).some(entry => entry.name === 'witness.txt')
      const process = await $.process.run(['node', '-e', 'process.stdout.write(String(process.cwd() === process.argv[1]))', cwd])
      const facts = JSON.stringify({
        directory: cwd.split('/').pop(), rootIsCurrent: cwd === root, read, exists, stat: stat.kind, listed,
        processCwdMatches: process.stdout === 'true',
      })
      await $.fs.write('mods-directory.json', facts + '\n')
      return { ...result, result: String(result.result) + '\nMods directory facts: ' + facts }
    })
    on('tool.call', { tool: 'Bash' }, (_$, e, next) => {
      if (/\bgit\s+push\b[^\n]*\s(--force|-f)\b/u.test(String(e.command ?? ''))) {
        return { deny: `snapshot-guard refused this command: ${String(e.command)}` }
      }
      return next(e)
    })
  },
})
