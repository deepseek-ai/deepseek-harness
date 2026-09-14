/** Resolve the exact query-spill verification command through this run's filesystem locator map. */
export const name = 'query-spill-verification-path'
export const inject = ['shell', 'fs']

/** Translate the physical command only; tool logging and approval keep the model-visible locator. */
export function apply(ctx) {
  const shell = ctx.shell
  const fs = ctx.fs
  const run = shell.run
  const suffix = "; grep -Fq request/header \"$file\" && grep -Fq session_event_search \"$file\" && printf 'SPILL_CANONICAL_OK\\n'"
  ctx.effect(() => {
    shell.run = async (spec) => {
      const match = /^file="([^"]+)"/.exec(spec.command)
      if (match === null || spec.command !== match[0] + suffix) return run.call(shell, spec)
      const target = await fs.resolve(match[1])
      const path = fs.processPath(target).replaceAll("'", "'\"'\"'")
      return run.call(shell, { ...spec, command: "file='" + path + "'" + suffix })
    }
    return () => { shell.run = run }
  })
}
