/** Direct-reference script execution contracts, independent from module loading. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Identity assigned by the owner of one execution environment. */
export type ScriptRealmId = Branded<'ScriptRealmId'>

/** External classic script to load in an execution environment. */
export interface ScriptRealmScript {
  readonly url: string
}

/** An environment preserving shared object references and synchronous function calls. */
export interface ScriptRealm {
  readonly id: ScriptRealmId
  /**
   * Expose named values without cloning them or replacing different existing bindings.
   * @param bindings - Global names and their shared values.
   * @returns After the bindings are installed; incompatible names reject before installation.
   */
  expose(bindings: Readonly<Record<string, unknown>>): Promise<void>
  /**
   * Execute an external classic script in this environment.
   * @param script - Script URL.
   * @returns After script loading; failure or environment disposal rejects.
   */
  execute(script: ScriptRealmScript): Promise<void>
  /**
   * Release environment-owned resources without revoking references already handed out.
   * @returns After cleanup; repeated calls share the same result.
   */
  dispose(): Promise<void>
}

/** Instance identity and lifetime cancellation supplied by the creating owner. */
export interface ScriptRealmCreateOptions {
  readonly id: ScriptRealmId
  readonly signal: AbortSignal
}

/** Provider that creates a ready environment and cleans partial creation on failure. */
export interface ScriptRealmFactory<R extends ScriptRealm = ScriptRealm> {
  /**
   * Create an execution environment; the caller owns its disposal.
   * @param options - Instance identity and lifetime cancellation.
   * @returns A ready environment.
   */
  create(options: ScriptRealmCreateOptions): Promise<R>
}
