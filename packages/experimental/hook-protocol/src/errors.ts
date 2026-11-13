/** Structured error identity that hook-backed tool policies record on denied and blocked calls. @module */

/** Error name shared by every hook policy failure. */
export const HOOK_ERROR_NAME = 'HookError'

/** Code for a call a `PreToolUse` hook denied before dispatch; the model should not retry the call unchanged. */
export const HOOK_DENIED = 'HOOK_DENIED'

/** Code for a result a `PostToolUse` hook blocked after dispatch; the hook's feedback replaces the result. */
export const HOOK_BLOCKED = 'HOOK_BLOCKED'
