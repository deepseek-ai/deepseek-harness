/**
 * The Worker's `xdg-open`: hands one VFS text file to the page's read-only
 * viewer, the only desktop a preview has. Exit statuses follow xdg-open(1):
 * 1 usage, 2 missing file, 3 no viewer for the target, 4 action failed.
 */
import { resolve } from '../../module-system/posix-path.ts'
import type { VirtualExecutable, VirtualExecutableExit } from './virtual-executables.ts'

/** Page-side display of one text file. */
export type TextViewer = (path: string, text: string) => void

let viewer: TextViewer | undefined

/**
 * Install the page viewer `xdg-open` reports to; the worker host calls this once its tunnel exists.
 * @param next - Viewer that forwards to the page.
 */
export function setTextViewer(next: TextViewer): void {
  viewer = next
}

function exit(exitCode: number, stderr = ''): VirtualExecutableExit {
  return { kind: 'exit', exitCode, stdout: '', stderr }
}

/** Virtual executable replacing the desktop opener with the page's text viewer. */
export const XDG_OPEN_EXECUTABLE: VirtualExecutable = {
  name: 'xdg-open',
  async prepare(args, context) {
    if (args.length !== 1) return exit(1, 'xdg-open: usage: xdg-open { file | URL }\n')
    const path = resolve(context.cwd, args[0] as string)
    const stats = await context.filesystem.stat(path)
    if (stats === undefined) return exit(2, `xdg-open: file '${path}' does not exist\n`)
    if (stats.directory) return exit(3, `xdg-open: no viewer for directory '${path}'\n`)
    if (viewer === undefined) return exit(3, 'xdg-open: no page viewer is attached\n')
    try {
      viewer(path, await context.filesystem.readText(path))
    } catch (error) {
      return exit(4, `xdg-open: ${error instanceof Error ? error.message : String(error)}\n`)
    }
    return exit(0)
  },
  runSync() {
    return { kind: 'asynchronous' }
  },
}
