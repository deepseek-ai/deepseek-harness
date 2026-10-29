/** Application identities admitted from native selection or saved provider configuration. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Native-provider digest of platform application metadata, separate from process and window handles. */
export type CuaApplicationId = Branded<'CuaApplicationId'>
/** Identity shown to the human before application access is granted. */
export interface CuaApplicationGrant {
  /** Native identity digest admitted from the helper or validated profile configuration. */
  id: CuaApplicationId
  /** Application label presented when the decision was made. */
  name: string
  /** Canonical executable path for display and icons; absent when the operating system cannot provide it. */
  executablePath?: string | undefined
}
