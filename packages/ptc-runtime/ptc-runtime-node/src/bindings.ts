/** Validate and capture the binding names available to one program. */
import { PtcImage, RESERVED_BINDING_WORDS, PtcRuntimeError, RESERVED_BINDING_GLOBALS, RESERVED_ERROR_MEMBERS } from '@deepseek-ai/dsh-ptc-runtime'
import type { PtcBindingFunction, PtcBindingNamespace, PtcJsonValue, PtcProgramFormat, PtcRunRequest } from '@deepseek-ai/dsh-ptc-runtime'
import { snapshotPtcJsonValue, encodePtcJsonWire, type PtcJsonWire, type PtcImageWire } from './json-wire.ts'
import { RESERVED_PREFIX } from './evaluators/scoped-repl.ts'
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/
/**
 * Reject unusable namespaces before starting a process.
 * @param request - Host-owned binding declarations.
 * @param programFormat - Evaluator syntax whose internal identifiers must remain reserved.
 * @returns Namespaces keyed by their declared global.
 */
export function validateBindings(request: PtcRunRequest, programFormat: PtcProgramFormat): Map<string, PtcBindingNamespace> {
  const bindings = new Map<string, PtcBindingNamespace>()
  for (const namespace of request.bindings) {
    if (!IDENTIFIER.test(namespace.global) || RESERVED_BINDING_WORDS.has(namespace.global)
      || (programFormat === 'scoped-repl' && namespace.global.includes(RESERVED_PREFIX))) {
      throw new PtcRuntimeError(`dsh-ptc-runtime-node: binding global ${JSON.stringify(namespace.global)} is not a usable identifier`, 'PTC_RUNTIME_INVALID_ARGUMENT')
    }
    if (RESERVED_BINDING_GLOBALS.has(namespace.global)) {
      throw new PtcRuntimeError(`dsh-ptc-runtime-node: reserved binding global ${JSON.stringify(namespace.global)}`, 'PTC_RUNTIME_INVALID_ARGUMENT')
    }
    if (bindings.has(namespace.global)) {
      throw new PtcRuntimeError(`dsh-ptc-runtime-node: duplicate binding global ${JSON.stringify(namespace.global)}`, 'PTC_RUNTIME_INVALID_ARGUMENT')
    }
    bindings.set(namespace.global, namespace)
  }

  const errorClassNames = new Set<string>()
  for (const namespace of request.bindings) {
    const descriptor = namespace.errorClass
    if (!descriptor) continue
    if (!IDENTIFIER.test(descriptor.name) || RESERVED_BINDING_WORDS.has(descriptor.name)
      || (programFormat === 'scoped-repl' && descriptor.name.includes(RESERVED_PREFIX))) {
      throw new PtcRuntimeError(`dsh-ptc-runtime-node: binding error class ${JSON.stringify(descriptor.name)} is not a usable identifier`, 'PTC_RUNTIME_INVALID_ARGUMENT')
    }
    if (RESERVED_BINDING_GLOBALS.has(descriptor.name)) {
      throw new PtcRuntimeError(`dsh-ptc-runtime-node: reserved binding global ${JSON.stringify(descriptor.name)}`, 'PTC_RUNTIME_INVALID_ARGUMENT')
    }
    if (bindings.has(descriptor.name) || errorClassNames.has(descriptor.name)) {
      throw new PtcRuntimeError(`dsh-ptc-runtime-node: duplicate injected global ${JSON.stringify(descriptor.name)}`, 'PTC_RUNTIME_INVALID_ARGUMENT')
    }
    const member = descriptor.memberNameProperty
    if (member.length === 0 || RESERVED_ERROR_MEMBERS.has(member)) {
      throw new PtcRuntimeError(`dsh-ptc-runtime-node: binding error member property ${JSON.stringify(descriptor.memberNameProperty)} is not usable`, 'PTC_RUNTIME_INVALID_ARGUMENT')
    }
    errorClassNames.add(descriptor.name)
  }
  return bindings
}

/**
 * Invoke a host binding and encode its lossless result.
 * @param binding - Current evaluation's function, absent if it was removed.
 * @param args - Validated JSON arguments detached from the program.
 * @param image - Registers host-issued images with the owning process.
 * @returns Flat binding data; unavailable bindings and invalid results reject.
 */
export async function invokeBinding(
  binding: PtcBindingFunction | undefined, args: PtcJsonValue, image?: (value: PtcImage) => PtcImageWire,
): Promise<PtcJsonWire> {
  if (!binding) throw new Error('binding is unavailable in this evaluation; reacquire the current tool')
  const value = snapshotPtcJsonValue(await binding(args), value => image !== undefined && value instanceof PtcImage)
  if (value === undefined) throw new Error('binding resolution must be lossless JSON')
  return encodePtcJsonWire(value, candidate => candidate instanceof PtcImage ? image?.(candidate) : undefined)
}
