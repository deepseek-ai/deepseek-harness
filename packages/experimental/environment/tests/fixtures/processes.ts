/** Process checks for specs that wait for the processes their runs start to end. */

/**
 * Tell whether a process exists.
 * @param pid - the process id.
 * @returns false once no process has this id.
 */
export function exists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // ESRCH: no process has this id any more.
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}
