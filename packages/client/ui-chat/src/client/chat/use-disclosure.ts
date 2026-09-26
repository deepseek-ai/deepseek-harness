/** Bind independent disclosure state to a Chat seat's reset source. */
import { useCallback, useState, useSyncExternalStore } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { UseDisclosure } from '../contract/slots.ts'

/**
 * Own one initially collapsed disclosure without an external subscription.
 * @param version - reset generation; unchanged generations retain local open state.
 * @returns the open state, an explicit setter, and a toggle action.
 */
export function useDisclosure(version = 0): ReturnType<UseDisclosure> {
  const [expandedVersion, setExpandedVersion] = useState<number | null>(null)
  const expanded = expandedVersion === version
  const setExpanded = useCallback((open: boolean) => {
    setExpandedVersion(open ? version : null)
  }, [version])
  const toggle = useCallback(() => {
    setExpandedVersion(previous => previous === version ? null : version)
  }, [version])
  return { expanded, setExpanded, toggle }
}

/**
 * Bind a Hook without subscribing until a component calls it.
 * @param reset - stable source whose version advances when the seat is hidden by its Turn.
 * @returns a Hook with independent open state for each invocation.
 */
export function bindDisclosure(reset: ObservableSnapshot<number>): UseDisclosure {
  const subscribe = (listener: () => void) => reset.subscribe(listener)
  const getSnapshot = () => reset.getSnapshot()
  return function useBoundDisclosure() {
    const version = useSyncExternalStore(subscribe, getSnapshot)
    return useDisclosure(version)
  }
}
