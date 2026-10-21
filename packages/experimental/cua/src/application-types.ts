/** Application identities admitted from native selection or saved provider configuration. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Native digest of an executable path and its signing requirement, process lifetime or pending executable identity. */
export type CuaApplicationId = Branded<'CuaApplicationId'>
/** Identity shown to the human before application access is granted. */
export interface CuaApplicationGrant {
  /** Native identity digest admitted from the helper or validated profile configuration. */
  id: CuaApplicationId
  /** Application label presented when the decision was made. */
  name: string
  /** Canonical executable path presented with the application label. */
  executablePath: string
}
