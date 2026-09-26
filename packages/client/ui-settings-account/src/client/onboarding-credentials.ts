/** Desktop login owns model-credential discovery for both welcome and onboarding. */

/**
 * Read the same safe credential fact used by native login.
 * @returns configured API-key presence; rejects when the desktop bridge is unavailable.
 */
export async function readOnboardingApiKeyPresence(): Promise<boolean> {
  const bridge = (globalThis as typeof globalThis & {
    dshOnboarding?: { hasApiKey(): Promise<boolean> }
  }).dshOnboarding
  if (bridge === undefined) throw new Error('desktop login bridge unavailable')
  return bridge.hasApiKey()
}
