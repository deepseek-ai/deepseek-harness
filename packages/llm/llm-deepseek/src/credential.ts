/** Credential values shared by DeepSeek model and web providers; callers own protocol headers and missing-key errors. */
import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { assertUsableApiKey } from '@deepseek-ai/dsh-llm'

/**
 * Read and validate one API key. An installed credentials service is authoritative, including absence;
 * only deployments without that service read the launch environment. Store and format failures propagate.
 * @param ctx - context providing the credential and launch-environment services.
 * @param ref - credential reference to resolve.
 * @returns the validated key, or undefined when no key is configured.
 */
export async function resolveDeepSeekApiKey(ctx: Context, ref: CredentialRef): Promise<string | undefined> {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    const hit = await credentials.resolve(ref)
    return hit === undefined ? undefined : assertUsableApiKey(hit.value, 'llm-deepseek', ref)
  }
  const ambient = launchEnvironmentOf(ctx).get(ref)
  return ambient === undefined || ambient.value.length === 0 ? undefined : assertUsableApiKey(ambient.value, 'llm-deepseek', ref)
}

/**
 * Check key presence without resolving a credential-store value or validating its format. Store failures propagate.
 * @param ctx - context providing the credential and launch-environment services.
 * @param ref - credential reference to inspect.
 * @returns whether the authoritative credential source reports a configured key.
 */
export async function deepSeekApiKeyConfigured(ctx: Context, ref: CredentialRef): Promise<boolean> {
  const credentials = ctx.get('credentials')
  return credentials === undefined
    ? (launchEnvironmentOf(ctx).get(ref)?.value.length ?? 0) > 0
    : (await credentials.describe(ref)).configured
}

/**
 * Read an account token only for a destination allowed by the account service. Credential-store failures propagate.
 * @param ctx - context providing the optional account service.
 * @param endpoint - destination that would receive the token.
 * @returns the token, or undefined without an allowed signed-in account.
 */
export async function resolveDeepSeekAccountToken(ctx: Context, endpoint: string): Promise<string | undefined> {
  return await ctx.get('deepseekAccount')?.resolveToken(endpoint)
}

/**
 * Invalidate the account token rejected by a request, without clearing a newer sign-in. Removal failure is contained
 * so callers can report the original request failure; the account service owns in-memory invalidation and persistence.
 * @param ctx - context providing the optional account service.
 * @param token - exact token sent by the rejected request.
 * @returns settlement after the invalidation attempt.
 */
export async function rejectDeepSeekAccountToken(ctx: Context, token: string): Promise<void> {
  try { await ctx.get('deepseekAccount')?.rejectToken(token) }
  catch (_credentialRemovalFailed) { /* Storage failure cannot replace the request failure. */ }
}
