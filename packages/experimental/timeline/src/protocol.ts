import { z } from 'zod'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { outputLanguages } from './policy.ts'
import { CHECKPOINT_BYTES } from './checkpoint.ts'
import {
  annotationId,
  annotationSchema,
  annotationTargetSchema,
  annotationText,
  controlActionSchema,
  controlDeliverySchema,
  controlTargetSchema,
  prioritySchema,
  taskId,
  treeId,
} from './records.ts'

/** Authenticated RPC channel for Timeline edits. */
export const TIMELINE_CHANNEL = '/timeline'
/** Method for applying a user edit. */
export const TIMELINE_EDIT = 'edit'
/** Method for reporting the owner browser's resolved UI language. */
export const TIMELINE_LOCALE = 'locale'
/** Accept only language identifiers supported for Timeline output. */
export const browserLanguageSchema = z.enum(outputLanguages)
const sessionId = z.string().min(1).max(256).transform(value => value as SessionId)
/** Validate user actions before they reach session state. */
export const editRequestSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('import'),
      sessionId,
      id: z.string().min(1).max(128),
      content: z.string().max(CHECKPOINT_BYTES),
      copy: z.boolean().default(false),
      continue: z.boolean().default(false),
    })
    .strict(),
  z.object({ action: z.literal('remove'), sessionId, tree: treeId, draft: z.boolean().optional() }).strict(),
  z
    .object({
      action: z.literal('control'),
      sessionId,
      target: controlTargetSchema,
      id: annotationId,
      intent: controlActionSchema,
      text: annotationText,
    })
    .strict(),
  z
    .object({
      action: z.literal('delivery'),
      sessionId,
      id: annotationId,
      delivery: controlDeliverySchema.exclude(['sending']),
    })
    .strict(),
  z
    .object({
      action: z.literal('annotate'),
      sessionId,
      target: annotationTargetSchema,
      id: annotationId,
      text: annotationText,
    })
    .strict(),
  z
    .object({
      action: z.literal('priority'),
      sessionId,
      tree: treeId,
      task: taskId,
      priority: prioritySchema,
    })
    .strict(),
])
/** Validate the server result of a user action. */
export const editResponseSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('import'), tree: treeId, reused: z.boolean(), notified: z.boolean() }),
  z.object({
    action: z.literal('remove'),
    removed: z.boolean(),
    notified: z.boolean(),
    draft: z.boolean().default(false),
  }),
  z.object({
    action: z.literal('control'),
    annotation: annotationSchema,
    dispatch: z.boolean(),
    context: z.json(),
  }),
  z.object({ action: z.literal('delivery') }),
  z.object({ action: z.literal('annotate'), annotation: annotationSchema, context: z.json() }),
  z.object({ action: z.literal('priority') }),
])
/** Validated user action sent to the host. */
export type UserEdit = z.infer<typeof editRequestSchema>
/** Saved action outcome returned by the host. */
export type UserEditResult = z.infer<typeof editResponseSchema>
