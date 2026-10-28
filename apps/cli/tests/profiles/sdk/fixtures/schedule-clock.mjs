/** Freeze only the isolated runtime's wall clock before reminder activation starts. */
export function apply(ctx) {
  const original = Date.now
  const now = Number(process.env.DSH_TEST_SCHEDULE_NOW)
  ctx.effect(() => {
    Date.now = () => now
    return () => { Date.now = original }
  })
  ctx.provide('sdkTestClock', { ready: true })
}
