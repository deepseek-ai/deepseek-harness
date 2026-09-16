/** Strict JSON validation for SSH helper requests and remote observations. */
import { z } from 'zod'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Identity of one prepared or running process in its owning SSH helper. */
export type SshProcessId = Branded<'SshProcessId'>
/** Identity of one open text iterator in its owning SSH helper. */
export type SshTextStreamId = Branded<'SshTextStreamId'>
/** Admit a process identity from the private helper protocol. */
export const processIdSchema = z.uuid().transform((value): SshProcessId => value as SshProcessId)
/** Admit a text iterator identity from the private helper protocol. */
export const textStreamIdSchema = z.uuid().transform((value): SshTextStreamId => value as SshTextStreamId)

/** A remote POSIX absolute path; spelling is preserved until remote canonicalization. */
export const remotePath = z.string().min(1).refine(value => value.startsWith('/') && !value.includes('\0'), 'expected an absolute POSIX path')
/** Filesystem identity returned by the remote filesystem provider. */
export const targetSchema = z.object({ targetKey: remotePath, displayPath: z.string() }).strict()
/** Remote metadata observation. */
export const infoSchema = z.object({ version: z.string(), type: z.enum(['file', 'directory', 'other']), size: z.number().nonnegative().optional() }).strict()
/** Metadata that preserves a final symlink. */
export const pathInfoSchema = infoSchema.extend({ type: z.enum(['file', 'directory', 'symlink', 'other']) })
/** A resolved file-effect policy; the remote helper owns path canonicalization. */
export const policySchema = z.object({ mode: z.enum(['read-only', 'workspace-write', 'danger-full-access']), workspaceRoot: remotePath, sessionId: z.string().optional() }).strict()
/** Complete directory entries. */
export const entriesSchema = z.array(z.object({ name: z.string(), type: z.enum(['file', 'directory', 'other']), target: targetSchema, version: z.string().optional(), size: z.number().nonnegative().optional() }).strict())
/** Guarded write intent. */
export const intentSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('createIfAbsent') }).strict(), z.object({ kind: z.literal('replaceIfVersion'), version: z.string() }).strict()])
/** Literal text edit. */
export const editSchema = z.object({ oldString: z.string(), newString: z.string(), replaceAll: z.boolean() }).strict()
/** Atomic write observation. */
export const writeResultSchema = z.object({ operation: z.enum(['create', 'update']), version: z.string(), before: z.string().nullable(), after: z.string() }).strict()
/** Atomic edit observation. */
export const editResultSchema = z.object({ version: z.string(), before: z.string(), after: z.string() }).strict()
/** Explicit child environment; null encodes an environment tombstone. */
export const environmentSchema = z.record(z.string(), z.string().nullable())
const collection = z.object({
  maxBytes: z.number().int().positive(),
  spill: z.object({ maxBytes: z.number().int().positive() }).strict().optional(),
}).strict()
/** Ordinary or terminal process requested by a trusted SSH client. */
export const spawnSchema = z.object({
  argv: z.array(z.string().refine(value => !value.includes('\0'))).min(1),
  cwd: remotePath,
  env: environmentSchema.optional(), graceMs: z.number().int().positive().max(2_147_483_647),
  stdio: z.object({
    stdin: z.union([z.literal('ignore'), z.literal('pipe'), z.object({ data: z.string() }).strict()]),
    stdout: z.union([z.literal('pipe'), z.literal('inherit'), collection]),
    stderr: z.union([z.literal('pipe'), z.literal('inherit'), collection]),
    control: z.literal('pipe').optional(),
  }).strict().optional(),
  terminal: z.object({
    terminalType: z.string().min(1), rows: z.number().int().positive(), cols: z.number().int().positive(),
    shellActivity: z.boolean().optional(),
  }).strict().optional(),
}).strict().refine(value => (value.stdio === undefined) !== (value.terminal === undefined), 'select ordinary or terminal execution')
/** Connection handshake binds sockets and workspace to one helper process. */
export const helloSchema = z.object({ protocol: z.literal(1), hash: z.string().regex(/^[0-9a-f]{64}$/), platform: z.enum(['linux', 'darwin']), nodeVersion: z.string(), node: remotePath, root: remotePath, workspace: remotePath, bootstrapHash: z.string().regex(/^[0-9a-f]{64}$/).optional() }).strict()
/** A prepared process publishes its sockets before target code may execute. */
export const streamEndpointSchema = z.object({ path: remotePath, capability: z.string().regex(/^[0-9a-f]{64}$/) }).strict()
/** A stream capability reaches only the authenticated SSH client and its helper. */
export type SshStreamEndpoint = z.infer<typeof streamEndpointSchema>
/** Prepared process and its independently authenticated stream endpoints. */
export const preparedSchema = z.object({ id: processIdSchema, streams: z.partialRecord(z.enum(['stdin', 'stdout', 'stderr', 'control', 'terminal']), streamEndpointSchema) }).strict()
/** Direct process exit facts. */
export const outcomeSchema = z.object({ exitCode: z.number().int().nullable(), signal: z.string().nullable() }).strict()
/** A bounded raw tail positioned in whole-stream byte coordinates. */
export const outputSnapshotSchema = z.object({ tail: z.base64(), totalBytes: z.number().int().nonnegative() }).strict()
/**
 * Bound one encoded tail and its RPC envelope by the declared collection budget.
 * @param maxBytes - the collector's retained raw-byte limit.
 * @returns the private snapshot frame limit, capped by the helper protocol ceiling.
 */
export function outputSnapshotFrameLimit(maxBytes: number): number {
  return Math.min(64 * 1024 * 1024, maxBytes * 2 + 1024)
}
/** Direct exit, retained output snapshots, and optional complete spill locations. */
export const doneSchema = z.object({
  outcome: outcomeSchema,
  spills: z.object({ stdout: remotePath.optional(), stderr: remotePath.optional() }).strict(),
  collected: z.object({
    stdout: outputSnapshotSchema.optional(),
    stderr: outputSnapshotSchema.optional(),
  }).strict(),
}).strict()
/** Remote terminal foreground observation. */
export const foregroundSchema = z.object({ processGroupId: z.number().int().positive(), inputWaiting: z.boolean() }).strict().nullable()
/** Conservative shell lifecycle and process observation returned by the execution provider. */
export const terminalActivitySchema = z.object({ state: z.enum(['idle', 'busy', 'unknown']), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict()
