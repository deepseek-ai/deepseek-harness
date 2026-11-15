/** A context with the DeepSeek authentication service over stand-in credential planes. */
import { Context } from '@deepseek-ai/cordis'
import DeepSeekAuth, { type DeepSeekAuthCandidate, type DeepSeekAuthRequest, type DeepSeekAuthUnresolved } from '@deepseek-ai/dsh-deepseek-auth'
import type { DeepSeekAccount } from '@deepseek-ai/dsh-deepseek-account'
import { DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'

/** Credential planes of one test context. */
export interface Planes {
  /** Launch-environment variables. */
  environment?: Record<string, string>
  /** Values of the mounted credentials service by reference; omitted mounts no service. */
  stored?: Record<string, string>
  /** Account service stand-in. */
  account?: DeepSeekAccount
}

const mounted: Context[] = []

/** Dispose every context {@link mount} created. */
export async function disposeMounted(): Promise<void> {
  await Promise.all(mounted.splice(0).map(ctx => ctx.fiber.dispose()))
}

/**
 * Mount the service.
 * @param planes - the credential planes it reads.
 * @returns the context.
 */
export async function mount(planes: Planes = {}): Promise<Context> {
  const ctx = new Context()
  mounted.push(ctx)
  ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([{ source: 'process', values: planes.environment ?? {} }]))
  const { stored } = planes
  if (stored !== undefined) {
    ctx.provide('credentials', {
      resolve: (ref: string) => Promise.resolve(stored[ref] === undefined ? undefined : { value: stored[ref] }),
      describe: (ref: string) => Promise.resolve({ configured: (stored[ref]?.length ?? 0) > 0 }),
    } as never)
  }
  if (planes.account !== undefined) ctx.provide('deepseekAccount', planes.account)
  await ctx.plugin(DeepSeekAuth)
  return ctx
}

/** A request to the Search API accepting both kinds, with overrides. */
export function request(overrides: Partial<DeepSeekAuthRequest> = {}): DeepSeekAuthRequest {
  return { consumer: 'web-test', accepts: ['account', 'api-key'], destination: { path: '/v1/tools/search' }, ...overrides }
}

/** Each entry as `kind endpoint`, or `kind !unresolved` for an unresolved kind. */
export function summary(entries: readonly (DeepSeekAuthCandidate | DeepSeekAuthUnresolved)[]): string[] {
  return entries.map(entry => 'unresolved' in entry ? `${entry.kind} !${entry.unresolved}` : `${entry.kind} ${entry.endpoint}`)
}

/** Narrow an entry to a candidate, failing the test for an unresolved kind. */
export function candidate(entry: DeepSeekAuthCandidate | DeepSeekAuthUnresolved | undefined): DeepSeekAuthCandidate {
  if (entry === undefined || 'unresolved' in entry) throw new Error('expected a candidate')
  return entry
}
