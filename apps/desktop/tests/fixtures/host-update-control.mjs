/** Test-only access to services in the actual Loader-composed Desktop Host. */
export const ready = Promise.withResolvers()
export const inject = ['agents', 'jobs', 'llm', 'agentPresets', 'connection']
export function apply(ctx) { ready.resolve(ctx) }
