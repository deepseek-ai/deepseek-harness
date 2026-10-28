/** Settled native gestures shared by directory, path, and delivery controls. */
import type { PresentedOpenFailure, PresentedOpenOutcome } from '@deepseek-ai/dsh-client-ui-deliverables/client'

/** Failure kind of one settled gesture, keyed to the `path.*` copy it announces. */
export type OpenInAppPathFailure = PresentedOpenFailure

/** Acknowledged open or reveal, named failure, or deliberately skipped gesture. */
export type OpenInAppOutcome = PresentedOpenOutcome
