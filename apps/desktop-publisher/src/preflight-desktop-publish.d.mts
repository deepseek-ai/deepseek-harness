/** Reject identifiable debugging artifacts before installing publication dependencies. */
/**
 * Pin the requested attempt and reject its explicitly named debugging artifacts.
 * @param repository GitHub repository.
 * @param inputs Dispatch inputs.
 * @param api Parsed GitHub JSON.
 * @returns Exact attempt for subsequent routing; local verification remains required.
 */
export function preflightDesktopPublish(repository: string, inputs: { package_run_id: string; package_run_attempt?: string },
  api: (path: string, paginate?: boolean) => unknown): string
