/** Desktop build output used by the native integration tests. */
import { fileURLToPath } from 'node:url'

export const receiverAddon = fileURLToPath(new URL(`../../../../apps/desktop/lib/native/${process.platform}-${process.arch}/frame-forwarding.node`, import.meta.url))
