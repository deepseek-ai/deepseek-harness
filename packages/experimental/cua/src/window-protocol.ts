/** Window-directed model operations; application-oriented macOS operations remain separate. */
import { z } from 'zod'
import { elementId, WindowsResult } from './protocol.ts'

const windowId = z.number().int().positive().max(2 ** 32 - 1)
const handle = { windowHandle: z.string().min(1) }
const modifiers = z.array(z.enum(['command', 'control', 'option', 'shift', 'fn'])).optional()
const pointer = { mouseButton: z.enum(['left', 'right', 'middle']).optional(), modifiers }
const snapshot = { ...handle, snapshotId: z.string().min(1), elementId }
const point = z.number().nonnegative()
const relativePoint = z.number().int().min(0).max(999)
const coordinates = { ...handle, snapshotId: z.string().min(1).optional() }
const absolute = { ...coordinates, x: point, y: point, relative: z.literal(false).optional() }
const relative = { ...coordinates, x: relativePoint, y: relativePoint, relative: z.literal(true) }
const operation = <M extends string, S extends z.ZodRawShape>(method: M, params: S) =>
  z.object({ method: z.literal(method), params: z.object(params).strict() }).strict()
const click = { ...pointer, clickCount: z.union([z.literal(1), z.literal(2)]).optional(),
  holdMs: z.number().int().nonnegative().optional() }

/** Windows tools expose window handles, never app selection or app-wide input. */
export const WindowRequest = z.discriminatedUnion('method', [
  operation('getCapabilities', {}),
  operation('listWindows', {}),
  operation('getWindows', { ids: z.array(windowId).min(1) }),
  operation('findApps', { query: z.string().min(1).regex(/\S/) }),
  operation('launch', { target: z.string().min(1) }),
  operation('getState', { ...handle, includeMenus: z.boolean().optional(), details: z.boolean().optional() }),
  operation('activate', handle), operation('show', handle), operation('screenshot', handle),
  operation('typeText', { ...handle, text: z.string() }),
  operation('paste', { ...handle, text: z.string(), format: z.enum(['text', 'html']).optional() }),
  operation('pressKey', { ...handle, key: z.string().min(1), modifiers }),
  operation('setValue', { ...snapshot, value: z.string() }),
  operation('selectText', { ...snapshot, text: z.string().min(1), prefix: z.string().optional(), suffix: z.string().optional(),
    selectionType: z.enum(['text', 'cursor_before', 'cursor_after']).optional() }),
  z.object({ method: z.literal('hover'), params: z.union([z.object(snapshot).strict(), z.object(absolute).strict(), z.object(relative).strict()]) }).strict(),
  z.object({ method: z.literal('click'), params: z.union([
    z.object({ ...snapshot, ...click }).strict(),
    z.object({ ...absolute, ...click }).strict(), z.object({ ...relative, ...click }).strict(),
  ]) }).strict(),
  z.object({ method: z.literal('scroll'), params: z.union([
    z.object({ ...absolute, deltaLinesX: z.number().int().min(-10).max(10), deltaLinesY: z.number().int().min(-10).max(10) }).strict(),
    z.object({ ...relative, deltaLinesX: z.number().int().min(-10).max(10), deltaLinesY: z.number().int().min(-10).max(10) }).strict(),
  ]) }).strict(),
  z.object({ method: z.literal('drag'), params: z.union([
    z.object({ ...coordinates, ...pointer, fromX: point, fromY: point, toX: point, toY: point,
      relative: z.literal(false).optional() }).strict(),
    z.object({ ...coordinates, ...pointer, fromX: relativePoint, fromY: relativePoint, toX: relativePoint, toY: relativePoint,
      relative: z.literal(true) }).strict(),
  ]) }).strict(),
])
/** Stable discovery metadata; an entry is not a permission grant. */
export const WindowDiscoveryResult = WindowsResult
/** Selected windows retain their discovery ID and an independently authorized handle. */
export const SelectedWindowsResult = z.array(z.object({
  windowHandle: z.string().min(1), windowId, pid: z.number().int().positive(),
}))
/** Launchable Shell entries need not have an executable filesystem path. */
export const LaunchEntriesResult = z.array(z.object({
  id: z.string().min(1), displayName: z.string(), kind: z.enum(['shell', 'executable']),
  path: z.string().min(1).optional(),
}))
/** Dispatch acknowledges launch only; callers must discover any resulting windows. */
export const LaunchResult = z.object({ dispatched: z.literal(true), verified: z.literal(false) })
/** Private Windows preparation and launch continuations, excluded from model arguments. */
export const WindowNativeOperations = [
  operation('discoverWindows', {}),
  operation('prepareWindows', { ids: z.array(windowId).min(1) }),
  operation('prepareLaunch', { target: z.string().min(1) }),
  operation('dispatchLaunch', { appHandle: z.string().min(1) }),
] as const
