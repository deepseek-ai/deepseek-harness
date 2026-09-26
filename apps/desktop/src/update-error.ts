/** Localized update preparation failures with separately displayed diagnostics. */
import type { DesktopUpdatePreparationFailureKind } from './ipc.ts'

/** Only explicitly safe main-process facts may be exposed as technical details. */
export class DesktopUpdatePreparationError extends Error {
  /**
   * @param kind - Stable preparation cause shared by native and Web presentations.
   * @param message - Locale-owned recovery guidance.
   * @param technicalDetails - Main-owned facts, excluding raw subprocess output and credentials.
   */
  constructor(readonly kind: DesktopUpdatePreparationFailureKind, message: string, readonly technicalDetails?: string) { super(message) }
}
