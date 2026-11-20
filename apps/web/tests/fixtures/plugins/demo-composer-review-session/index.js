/** Host configuration for the session-specific composer hint. */
import z from '@deepseek-ai/schemastery'

/** Copy a Session ID into `sessionId` to give its composer the review checklist. */
export const Config = z.object({
  sessionId: z.string().default('').volatile(),
})

/** Publish config to the client half without mounting a Host service. */
export function apply() {}
