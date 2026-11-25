/** Reject identifiable debugging artifacts before installing publication dependencies. */

/** Workflow dispatch inputs validated before runner routing. */
export interface DesktopPublishPreflightInputs {
  readonly package_run_id: string
  readonly package_run_attempt?: string
  readonly publish_stable?: boolean | string
  readonly publish_nightly?: boolean | string
  readonly rollout_stable?: boolean | string
  readonly rollout_nightly?: boolean | string
  readonly rollout_percentage?: string
  readonly upload_website?: boolean | string
}

/**
 * Pin the requested attempt and reject invalid dispatch choices or debugging artifacts.
 * @param repository GitHub repository.
 * @param inputs Dispatch inputs.
 * @param api Parsed GitHub JSON.
 * @returns Exact attempt for subsequent routing; local verification remains required.
 */
export function preflightDesktopPublish(
  repository: string,
  inputs: DesktopPublishPreflightInputs,
  api: (path: string, paginate?: boolean) => unknown,
): string
