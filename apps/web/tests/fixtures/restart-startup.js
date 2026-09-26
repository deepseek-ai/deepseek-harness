/** Hold one Host service until the restart test releases application startup. */
export const name = 'web-restart-startup'

/** Keep the carrier services available while Session Controller startup is held. */
export const inject = ['typertGateway', 'connection', 'webServer']

/**
 * Provide the test-only dependency after startup has been released.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host plugin context.
 * @returns {Promise<void>} Once the barrier is released or the plugin is disposed.
 */
export async function apply(ctx) {
  if (process.env.DSH_WEB_RESTART_HOLD_STARTUP === '1') {
    if (typeof process.send !== 'function') throw new Error('web restart startup fixture requires an IPC channel')
    const released = Promise.withResolvers()
    const resume = (message) => {
      if (message === 'resume-startup') released.resolve(true)
    }
    ctx.effect(() => {
      process.on('message', resume)
      return () => {
        process.off('message', resume)
        released.resolve(false)
      }
    }, 'web-restart: startup barrier')
    process.send('startup-blocked')
    if (!await released.promise) return
  }
  ctx.reflect.provide('webRestartReady', {})
}
