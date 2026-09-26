/** Dependency-free IPC names shared with the sandboxed mandatory-update preload. */
export const MANDATORY_IPC = {
  status: 'dsh-desktop:mandatory-status', state: 'dsh-desktop:mandatory-state', action: 'dsh-desktop:mandatory-action',
} as const
