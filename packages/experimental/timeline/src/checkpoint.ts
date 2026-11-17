import { z } from 'zod'
import {
  annotationText,
  newId,
  prioritySchema,
  statuses,
  taskId,
  taskRevisionSchema,
  timestampSchema,
  treeId,
} from './records.ts'
import type { Annotation, Task, Tree } from './records.ts'
import { patchTasks, recordTaskHistory } from './tasks.ts'

/** Maximum encoded size of an imported task tree. */
export const CHECKPOINT_BYTES = 2 * 1024 * 1024

const task = z
  .object({
    id: taskId,
    parent: taskId.nullable().optional(),
    title: z.string().trim().min(1).max(120),
    description: z.string().max(320).optional(),
    status: z.enum(statuses).optional(),
    done: z.tuple([z.number().nonnegative(), z.number().positive()]).optional(),
    weight: z.number().positive().optional(),
    note: z.string().max(400).optional(),
    details: z.string().max(4000).optional(),
    priority: prioritySchema.optional(),
    history: taskRevisionSchema.array().optional(),
  })
  .strict()
const discussion = z
  .object({
    task: taskId.optional(),
    text: annotationText,
    createdAt: timestampSchema.optional(),
    reply: z.object({ text: annotationText, createdAt: timestampSchema.optional() }).strict().optional(),
  })
  .strict()
const schema = z
  .object({
    format: z.literal('dsh-timeline-tree'),
    version: z.literal(1),
    title: z.string().trim().min(1).max(120),
    description: z.string().max(320).optional(),
    elapsedMs: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    tasks: task.array().max(1000),
    discussions: discussion.array().max(10000).optional(),
    metadata: z.record(z.string(), z.json()).optional(),
  })
  .strict()
type CheckpointData = z.infer<typeof schema>

/** Portable version-one plan data, independent of Session storage and plugin versions. */
export class Checkpoint {
  private constructor(
    private readonly data: Omit<CheckpointData, 'tasks'>,
    readonly tasks: readonly Task[],
  ) {}

  /**
   * Validate a UTF-8-sized JSON file and its complete task graph before any write.
   * @param text - the text to parse.
   * @returns the validated portable plan.
   */
  static fromString(text: string): Checkpoint {
    if (new TextEncoder().encode(text).byteLength > CHECKPOINT_BYTES)
      throw new Error('Timeline checkpoint exceeds 2 MiB')
    return Checkpoint.fromJson(JSON.parse(text))
  }

  /**
   * Normalize file values through the same graph and progress checks as task edits.
   * @param input - input to validate.
   * @returns the validated portable plan.
   */
  static fromJson(input: unknown): Checkpoint {
    const result = schema.safeParse(input)
    if (!result.success) {
      const detail = result.error.issues.slice(0, 1).map(({ path, message }) =>
        `${path.length ? ` (${path.join('.')})` : ''}: ${message}`,
      ).join('')
      throw new Error(`Invalid Timeline checkpoint${detail}`)
    }
    const { tasks: inputTasks, ...data } = result.data
    const metadata = new Map<Task['id'], Pick<Task, 'priority' | 'history'>>()
    const patches = inputTasks.map(({ weight, priority, history, ...task }) => {
      metadata.set(task.id, { priority: priority ?? null, history: history ?? [] })
      return { ...task, ...(weight === undefined ? {} : { timeShare: weight }) }
    })
    const tasks =
      inputTasks.length === 0
        ? []
        : patchTasks([], patches, 0, 1000, 'checkpoint').map(task => ({
          ...task,
          ...metadata.get(task.id),
        }))
    const ids = new Set(tasks.map(task => task.id))
    if (data.discussions?.some(note => note.task !== undefined && !ids.has(note.task)))
      throw new Error('Timeline checkpoint discussion refers to an unknown task')
    return new Checkpoint(data, tasks)
  }

  /**
   * Export one acknowledged tree and its ordinary user discussions without live requests.
   * @param tree - the task tree before the change.
   * @param annotations - saved notes and work requests.
   * @param now - current wall clock time in milliseconds.
   * @param sessionId - identifier of the owning session.
   * @param pluginVersion - release version to include in the export metadata, when known.
   * @returns the portable snapshot of the tree.
   */
  static fromTree(
    tree: Tree,
    annotations: readonly Annotation[],
    now: number,
    sessionId: string,
    pluginVersion?: string,
  ): Checkpoint {
    const done = tree.tasks.every(task => task.status === 'done' || task.status === 'retired')
    const end = done ? Math.max(tree.createdAt, ...tree.tasks.map(task => task.updatedAt)) : now
    return new Checkpoint(
      {
        format: 'dsh-timeline-tree',
        version: 1,
        title: tree.title,
        ...(tree.description ? { description: tree.description } : {}),
        elapsedMs: Math.max(0, end - tree.createdAt),
        metadata: {
          plugin: '@deepseek-ai/dsh-timeline',
          ...(pluginVersion === undefined ? {} : { pluginVersion }),
          exportedAt: new Date(now).toISOString(),
          sourceSessionId: sessionId,
          sourceTreeId: tree.id,
          treeCreatedAt: new Date(tree.createdAt).toISOString(),
          lastTaskUpdatedAt: new Date(
            Math.max(tree.createdAt, ...tree.tasks.map(task => task.updatedAt)),
          ).toISOString(),
        },
        discussions: annotations
          .filter(
            note =>
              note.control === undefined && note.target.kind !== 'report' && note.target.tree === tree.id,
          )
          .map(note => ({
            ...(note.target.kind === 'task' ? { task: note.target.task } : {}),
            text: note.text,
            createdAt: note.createdAt,
            ...(note.reply === null ? {} : { reply: note.reply }),
          })),
      },
      structuredClone(tree.tasks),
    )
  }

  /**
   * Return canonical readable fields; empty text, default values and inert metadata are omitted.
   * @returns portable data without descriptive metadata.
   */
  toJson(): CheckpointData {
    const parents = new Set(this.tasks.filter(task => task.status !== 'retired').map(task => task.parent))
    return {
      format: 'dsh-timeline-tree',
      version: 1,
      title: this.data.title,
      ...(this.data.description ? { description: this.data.description } : {}),
      ...(this.data.elapsedMs ? { elapsedMs: this.data.elapsedMs } : {}),
      tasks: this.tasks.map(task => ({
        id: task.id,
        title: task.title,
        ...(task.parent === null ? {} : { parent: task.parent }),
        ...(task.description ? { description: task.description } : {}),
        ...(parents.has(task.id) || task.status === 'pending' ? {} : { status: task.status }),
        ...(parents.has(task.id) || (task.done[0] === 0 && task.done[1] === 1) ? {} : { done: task.done }),
        ...(task.timeShare === 1 ? {} : { weight: task.timeShare }),
        ...(task.note ? { note: task.note } : {}),
        ...(task.details ? { details: task.details } : {}),
        ...(task.priority === null ? {} : { priority: task.priority }),
        ...(task.history.length === 0 ? {} : { history: task.history }),
      })),
      ...(this.data.discussions?.length ? { discussions: this.data.discussions } : {}),
    }
  }

  /**
   * Encode a checkpoint that the same bounded reader can import.
   * @returns the complete JSON export.
   */
  toString(): string {
    const text = `${JSON.stringify({ ...this.toJson(), ...(this.data.metadata ? { metadata: this.data.metadata } : {}) }, null, 2)}\n`
    if (new TextEncoder().encode(text).byteLength > CHECKPOINT_BYTES)
      throw new Error('Timeline checkpoint exceeds 2 MiB')
    return text
  }

  /**
   * Create detached local identities; imported active leaves wait for an explicit continuation.
   * @param id - new identifier for the imported tree.
   * @param now - current wall clock time in milliseconds.
   * @returns the restored tree, notes, and unfinished work.
   */
  restore(id: string, now: number): { tree: Tree; annotations: Annotation[]; resume: string[] } {
    const saved = structuredClone(this.tasks)
    const parents = new Set(this.tasks.filter(task => task.status !== 'retired').map(task => task.parent))
    const active = this.tasks.filter(task => !parents.has(task.id) && task.status === 'active')
    const paused =
      active.length === 0
        ? saved
        : patchTasks(
          saved,
          active.map(({ id, note }) => ({
            id,
            status: 'paused',
            note: note || 'Imported checkpoint; awaiting continuation.',
          })),
          now,
          1000,
        )
    const tasks = recordTaskHistory(saved, paused, now).map(task => ({
      ...task,
      createdAt: now,
      updatedAt: now,
    }))
    const selected = treeId.parse(id)
    return {
      tree: {
        id: selected,
        title: this.data.title,
        description: this.data.description ?? '',
        tasks,
        createdAt: Math.max(0, now - (this.data.elapsedMs ?? 0)),
      },
      annotations: (this.data.discussions ?? []).map(note => ({
        id: newId('note'),
        target:
          note.task === undefined
            ? { kind: 'tree' as const, tree: selected }
            : { kind: 'task' as const, tree: selected, task: note.task },
        text: note.text,
        createdAt: note.createdAt ?? now,
        reply:
          note.reply === undefined ? null : { text: note.reply.text, createdAt: note.reply.createdAt ?? now },
      })),
      resume: active.map(task => task.id),
    }
  }
}
