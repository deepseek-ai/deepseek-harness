/**
 * The native picking occupant (package-internal; the `./client` surface
 * exposes only the Loader exports). Same-package tests exercise it directly
 * through this module.
 */
import { useEffect, useRef } from 'react'
import type { ReactElement } from 'react'
// Type-only: the owner contract of the directory-flow holes.
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'

/** Injected face: the native chooser call the flow drives (bound in apply's closure). */
export interface NativeFlowInjected {
  /** Open the local desktop or Host single-directory chooser. */
  pick: () => Promise<string | null>
}

/**
 * Renderless flow occupant: each rising `open` edge runs exactly one pick and
 * reports exactly one outcome; the ref arms once per open so re-renders (and
 * an adoption keeping `open` true while `busy`) never launch a second
 * chooser. The owner withdrawing `open` re-arms the next request.
 * @param props - owner conversation plus the injected pick call.
 * @returns nothing — the native chooser renders on the host display.
 */
export function NativeDirectoryFlow(props: DirectoryFlowOwnerProps & NativeFlowInjected): ReactElement | null {
  const { open, pick } = props
  const armed = useRef(false)
  // Callbacks ride a ref so the settled pick reports through the owner's
  // latest handlers, not the ones captured when the chooser opened.
  const outcome = useRef(props)
  outcome.current = props
  // Unmount (HMR replacing the occupant) discards settlements wholesale: the
  // dead instance must neither adopt a path nor drive the owner's error
  // surface. The wire carries no per-request abort, so the native chooser
  // survives until answered — its answer just lands nowhere; the replacement
  // instance re-arms under the owner's still-open request. An injected-face
  // identity change alone (re-registration) keeps the pending settlement:
  // the native chooser is still the same dialog.
  const alive = useRef(true)
  useEffect(() => {
    // StrictMode's development replay runs the cleanup once before the real
    // lifetime: re-arm on setup or every outcome would be discarded.
    alive.current = true
    return () => { alive.current = false }
  }, [])
  useEffect(() => {
    if (!open) {
      armed.current = false
      return
    }
    if (armed.current) return
    armed.current = true
    pick().then(
      (path) => {
        if (!alive.current) return
        if (path === null) outcome.current.onCancel(); else outcome.current.onPicked(path)
      },
      (reason: unknown) => {
        if (!alive.current) return
        outcome.current.onError(reason instanceof Error ? reason.message : String(reason))
      },
    )
  }, [open, pick])
  return null
}
