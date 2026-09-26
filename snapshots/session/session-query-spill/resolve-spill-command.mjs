/** Resolve the exact query-spill verification command through this run's filesystem locator map. */
export const name = 'query-spill-verification-path'
export const inject = ['shell', 'fs']

/** Translate the physical command only; tool logging and approval keep the model-visible locator. */
export function apply(ctx) {
  const shell = ctx.shell
  const fs = ctx.fs
  const execute = shell.execute
  const suffix = "; grep -Fq request/header \"$file\" && grep -Fq session_event_search \"$file\" && printf 'SPILL_CANONICAL_OK\\n'"
  ctx.effect(() => {
    shell.execute = (spec) => {
      const match = /^file="([^"]+)"/.exec(spec.command)
      if (match === null || spec.command !== match[0] + suffix) return execute.call(shell, spec)
      const physical = fs.processPathFromHostPath(match[1])
      if (physical === undefined) throw new Error('snapshot spill path is not readable by the shell')
      const path = physical.replaceAll("'", "'\"'\"'")
      return execute.call(shell, { ...spec, command: "file='" + path + "'" + suffix })
    }
    return () => { shell.execute = execute }
  })
}
