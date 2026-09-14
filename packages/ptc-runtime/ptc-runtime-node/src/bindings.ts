/** Validate and capture the binding names available to one program. */
import { DUNDER_MEMBER, PORTABLE_RESERVED_WORDS, RESERVED_BINDING_GLOBALS, RESERVED_ERROR_MEMBERS } from '@deepseek-ai/dsh-ptc-runtime'
import type { PtcBindingNamespace, PtcRunRequest } from '@deepseek-ai/dsh-ptc-runtime'
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/
/**
 * Reject unusable namespaces before starting a process.
 * @param request - Host-owned binding declarations.
 * @returns Namespaces keyed by their declared global.
 */
export function validateBindings(request: PtcRunRequest): Map<string, PtcBindingNamespace> {
  const bindings = new Map<string, PtcBindingNamespace>()
  for (const namespace of request.bindings) {
    if (!IDENTIFIER.test(namespace.global) || PORTABLE_RESERVED_WORDS.has(namespace.global)) {
      throw new Error(`dsh-ptc-runtime-node: binding global ${JSON.stringify(namespace.global)} is not a usable identifier`)
    }
    // RESERVED_BINDING_GLOBALS is the seam's shared backend-owned set:
    // `console` is THIS backend's log-capture slot; the dunder entries exist
    // for the Python side — its seeded/wrapped slots plus the `__debug__`
    // compile-time constant — refused here too so the namespace list stays
    // portable across backends. The seam declaration is the single home for
    // why each entry is reserved.
    if (RESERVED_BINDING_GLOBALS.has(namespace.global)) {
      throw new Error(`dsh-ptc-runtime-node: reserved binding global ${JSON.stringify(namespace.global)}`)
    }
    if (bindings.has(namespace.global)) {
      throw new Error(`dsh-ptc-runtime-node: duplicate binding global ${JSON.stringify(namespace.global)}`)
    }
    bindings.set(namespace.global, namespace)
  }

  const errorClassNames = new Set<string>()
  for (const namespace of request.bindings) {
    const descriptor = namespace.errorClass
    if (!descriptor) continue
    if (!IDENTIFIER.test(descriptor.name) || PORTABLE_RESERVED_WORDS.has(descriptor.name)) {
      throw new Error(`dsh-ptc-runtime-node: binding error class ${JSON.stringify(descriptor.name)} is not a usable identifier`)
    }
    if (RESERVED_BINDING_GLOBALS.has(descriptor.name)) {
      throw new Error(`dsh-ptc-runtime-node: reserved binding global ${JSON.stringify(descriptor.name)}`)
    }
    if (bindings.has(descriptor.name) || errorClassNames.has(descriptor.name)) {
      throw new Error(`dsh-ptc-runtime-node: duplicate injected global ${JSON.stringify(descriptor.name)}`)
    }
    const member = descriptor.memberNameProperty
    if (member.length === 0 || RESERVED_ERROR_MEMBERS.has(member) || DUNDER_MEMBER.test(member)) {
      throw new Error(`dsh-ptc-runtime-node: binding error member property ${JSON.stringify(descriptor.memberNameProperty)} is not usable`)
    }
    errorClassNames.add(descriptor.name)
  }
  return bindings
}
