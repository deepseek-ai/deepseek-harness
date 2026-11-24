/**
 * uSES bridge: turns any bare observable snapshot source into a typed
 * selector hook. Client-side-rendered only, so no server snapshot is wired.
 * This is the ONE hook constructor in the client stack — engines and hosts
 * traffic in bare sources; binding happens on the React side.
 */
// Both the runtime and DefinitelyTyped exports maps expose this extensionless
// shim subpath.
import { useSyncExternalStoreWithSelector } from 'use-sync-external-store/shim/with-selector'
import type { HostObservable, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'

const identity = (value: unknown): unknown => value

/**
 * Bind a bare observable source to a typed uSES selector hook.
 * subscribe/getSnapshot are captured once per source into stable closures
 * (also re-binds `this` for method-based sources), so components never
 * resubscribe across renders. Equality defaults to Object.is.
 * @param w - snapshot source (engine store, Session object, store instance).
 * @returns The selector hook; a standard prop declared without a selector reads the complete snapshot.
 */
export function bindSnapshotSelector<T>(w: HostObservable<T>): SnapshotSelectorHook<T> & (() => T) {
  const subscribe = (fn: () => void) => w.subscribe(fn)
  const getSnapshot = () => w.getSnapshot()
  function useSelector(): T
  function useSelector<S>(sel: (s: T) => S, eq?: (a: S, b: S) => boolean): S
  function useSelector(sel: (s: T) => unknown = identity, eq?: (a: unknown, b: unknown) => boolean): unknown {
    return useSyncExternalStoreWithSelector(subscribe, getSnapshot, undefined, sel, eq)
  }
  return useSelector
}
