import type { IntervalReport, Task, Tree } from '../records.ts'

/** Details stay inside the selected Timeline tab and retain their original identity. */
export type DetailTarget =
  | { kind: 'task'; tree: Tree['id']; task: Task['id'] }
  | { kind: 'report'; report: IntervalReport['id'] }
