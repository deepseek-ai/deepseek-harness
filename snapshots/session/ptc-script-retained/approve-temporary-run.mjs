/** Recorded human answer for the one temporary run; other approvals remain unanswered. */
export const name = 'approve-temporary-run'

/** Register the scenario's answer through the normal approval audit path. */
export function apply(ctx) {
  ctx.on('approval/request', (request, next) => request.toolName === 'run_code' && request.callId === 'script_temporary_exit'
    ? Promise.resolve('allowed-once') : next())
}
