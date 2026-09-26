/** Call-local argument subscription bound by the atomic Tool slot. */
import { useSyncExternalStore } from 'react'
import type { ToolCallInjected } from '../contract/slots.ts'

const subscribeEmpty = (): (() => void) => () => {}

/**
 * Bind one call without subscribing until its component invokes the Hook.
 * @param _standard - framework-provided scope props.
 * @param context - the preparing call's Step source and identity.
 * @returns a Hook that reads only this call's raw argument prefix.
 */
export const bindToolCallArgumentsPartial: ToolCallInjected['hooks']['toolCallArgumentsPartial'] = (
  _standard, context,
) => {
  const { assistant, callId } = context
  const subscribe = assistant === undefined ? subscribeEmpty : (listener: () => void) => assistant.subscribe(listener)
  const getSnapshot = (): string => {
    const block = assistant?.getSnapshot()?.blocks.find(candidate => candidate.kind === 'tool-call' && candidate.callId === callId)
    return block?.kind === 'tool-call' ? block.argsRaw : ''
  }
  return function useToolCallArgumentsPartial() {
    return useSyncExternalStore(subscribe, getSnapshot)
  }
}
