/** Reject one scheduler preparation to exercise the terminal internal-failure path. */
export const inject = ['tools']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Scenario-owned runtime. */
export function apply(ctx) {
  // Inspect the active instance's key so the fixture cannot introduce a second tools module.
  const key = Object.getOwnPropertySymbols(ctx.tools)
    .find(symbol => symbol.description === '@deepseek-ai/dsh-tools.scheduler')
  if (key === undefined) throw new Error('Scheduler failure fixture requires the active tool scheduler')
  const scheduler = ctx.tools[key]
  const prepare = scheduler.prepare
  ctx.effect(() => {
    scheduler.prepare = async input => {
      if (input.callId === 'scheduler-fail') {
        scheduler.prepare = prepare
        throw new Error('Snapshot scheduler preparation failed')
      }
      return prepare.call(scheduler, input)
    }
    return () => { scheduler.prepare = prepare }
  }, 'scheduler failure fixture')
}
