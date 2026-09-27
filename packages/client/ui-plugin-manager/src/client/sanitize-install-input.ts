/** Privacy-safe installation input classification shared by click and result events. */

/**
 * Keep registry package names and plain versions; classify other installer inputs without their contents.
 * @param spec - user-entered installation spec.
 * @returns an identifier safe to send without URL credentials, tokens, or local paths.
 */
export function sanitizeInstallInput(spec: string): string {
  if (/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*(?:@[a-z0-9.*^~+<>=| -]+)?$/iu.test(spec)) return spec
  if (/^(?:git[+:]|git@|github:|gitlab:|bitbucket:)/iu.test(spec)) return '[git]'
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(spec)) return '[url]'
  return '[path-or-other]'
}
