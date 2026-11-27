/** Default Desktop Office native preview registration. */
import type { Context } from '@deepseek-ai/cordis'
import remote from '@deepseek-ai/dsh-client-ui-office-frame-forwarding/remote'
import { mountOfficePreview } from './mount.ts'

export { inject } from './mount.ts'

/** Mount the generated `officePreview` Remote contribution and register native presentation inside the existing document preview.
 * @param ctx - Desktop Client plugin scope.
 * @returns Disposer withdrawing the UI before its Remote contribution.
 */
export function apply(ctx: Context): Promise<() => Promise<void>> {
  return mountOfficePreview(ctx, remote)
}
