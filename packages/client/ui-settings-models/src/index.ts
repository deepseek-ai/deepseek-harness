/** Host Loader entry declaring the Models credential-onboarding choice; onboarding belongs to the Client. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ModelsConfig } from './types.ts'

/** Credential-onboarding choice synced to the browser. */
export type Config = ModelsConfig

/** Credential-onboarding choice synced to the browser. */
export const Config = z.object({
  credentialOnboarding: z.boolean().default(true).volatile(),
})

/**
 * Register the browser plugin without Host behavior; the Loader validates the entry's Config, and the browser face
 * receives its volatile fields.
 * @param _ctx - Host context; unused.
 * @param _config - validated Config; unused on the Host.
 */
export function apply(_ctx: Context, _config: Config): void {}
