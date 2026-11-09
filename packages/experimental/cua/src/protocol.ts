/** JSON validation shared by model tool admission and the native object facade. */
import { Buffer } from 'node:buffer'
import { z } from 'zod'
import type { CuaAppHandle, CuaSnapshotId } from './types.ts'

const id = z.number().int().positive().max(2 ** 32 - 1)
const pid = z.number().int().positive().max(2 ** 31 - 1)
const point = z.number().nonnegative()
const relativePoint = z.number().int().min(0).max(999)
const traversalLimit = z.number().min(1).multipleOf(1)
const nativeTraversalLimits = z.object({
  maxElements: z.number().int().min(1).max(10000),
  maxDepth: z.number().int().min(1).max(100),
}).strict()
const app = { appHandle: z.string().min(1) }
const pointer = { mouseButton: z.enum(['left', 'right', 'middle']).optional(),
  modifiers: z.array(z.enum(['command', 'control', 'option', 'shift', 'fn'])).optional() }
const click = { ...pointer, clickCount: z.union([z.literal(1), z.literal(2)]).optional(),
  holdMs: z.number().int().nonnegative().optional()
    .describe('Milliseconds between each mouse press and release; omitted for an ordinary click.') }
const window = { ...app, windowId: id }
const jsonValue = z.json()
/** Provider-issued element reference from an accessibility observation. */
export const elementId = z.string().min(1)
  .describe('Opaque string defined by the platform provider, valid for at least the lifetime of one snapshot.')
const snapshot = { ...app, windowId: id.optional(), snapshotId: z.string().min(1), elementId }
const coordinate = { ...window, snapshotId: z.string().min(1).optional(), x: point, y: point }
const absoluteCoordinate = { ...coordinate, relative: z.literal(false).optional().describe('Omitted or false uses pixels in the latest screenshot returned by this tool.') }
const relativeCoordinate = { ...coordinate, relative: z.literal(true).describe('Use integer thousandths of the window width and height, from 0 to 999.'), x: relativePoint, y: relativePoint }
const bounds = z.object({
  x: z.number(), y: z.number(), width: z.number().nonnegative(), height: z.number().nonnegative(),
})
const operation = <M extends string, S extends z.ZodRawShape>(method: M, params: S) => z.object({
  method: z.literal(method), params: z.object(params).strict(),
}).strict()
// Native responses are byte-bounded before parsing. Exact re-encoding also rejects
// whitespace, missing padding and nonzero pad bits without a recursive regex.
const imageBase64 = z.string().min(1).refine(value => Buffer.from(value, 'base64').toString('base64') === value, {
  message: 'Expected canonical base64 image data',
})

/** Shared hover target variants. Providers may add options without replacing a target or its coordinate mode. */
export const MouseMoveTargets = [
  z.object(snapshot).strict(), z.object(absoluteCoordinate).strict(), z.object(relativeCoordinate).strict(),
] as const

function requestSchema<T extends z.ZodType>(hover: T) {
  return z.discriminatedUnion('method', [
    operation('getCapabilities', {}), operation('listApps', {}),
    operation('findApps', { query: z.string().min(1, 'Expected a non-empty search string').regex(/\S/, 'Expected a non-empty search string') }),
    operation('getApp', { selector: z.string().min(1) }),
    operation('activate', app),
    operation('show', { ...app, windowId: id.optional() }),
    operation('listWindows', app),
    operation('getState', { ...app, windowId: id.optional(),
      includeMenus: z.boolean().optional().describe('Expand menu contents; omitted or false shows menu-bar entries only.'),
      details: z.boolean().optional().describe('Include identifiers, global native bounds and complete action names.'),
      maxElements: traversalLimit.optional().describe('Maximum nodes to visit on this read. Omission uses the provider setting.'),
      maxDepth: traversalLimit.optional().describe('Maximum depth to traverse on this read. Omission uses the provider setting.'),
    }),
    operation('listActions', snapshot),
    operation('performAction', { ...snapshot, action: z.string().min(1), argument: jsonValue.optional() }),
    operation('invoke', snapshot),
    z.object({ method: z.literal('mouseMove'), params: hover }).strict(),
    z.object({ method: z.literal('click'), params: z.union([
      z.object({ ...snapshot, ...click }).strict(),
      z.object({ ...absoluteCoordinate, ...click }).strict(),
      z.object({ ...relativeCoordinate, ...click }).strict(),
    ]) }).strict(),
    operation('setValue', { ...snapshot, value: jsonValue }),
    operation('selectText', { ...snapshot, text: z.string().min(1), prefix: z.string().optional(), suffix: z.string().optional(),
      selectionType: z.enum(['text', 'cursor_before', 'cursor_after']).optional() }),
    operation('typeText', { ...app, windowId: id.optional(), text: z.string() }),
    operation('paste', { ...app, windowId: id.optional(), text: z.string(), format: z.enum(['text', 'html']).optional() }),
    operation('pressKey', { ...app, windowId: id.optional(), key: z.string().min(1), modifiers: z.array(z.string()).optional() }),
    operation('sendKeyEvent', { ...app, windowId: id.optional(), key: z.string().min(1), direction: z.enum(['down', 'up']) }),
    z.object({ method: z.literal('scroll'), params: z.union([
      z.object({ ...absoluteCoordinate,
        deltaLinesX: z.number().int().min(-10).max(10), deltaLinesY: z.number().int().min(-10).max(10) }).strict(),
      z.object({ ...relativeCoordinate,
        deltaLinesX: z.number().int().min(-10).max(10), deltaLinesY: z.number().int().min(-10).max(10) }).strict(),
    ]) }).strict(),
    z.object({ method: z.literal('drag'), params: z.union([
      z.object({ ...window, ...pointer, snapshotId: z.string().min(1).optional(), relative: z.literal(false).optional(),
        fromX: point, fromY: point, toX: point, toY: point }).strict(),
      z.object({ ...window, ...pointer, snapshotId: z.string().min(1).optional(), relative: relativeCoordinate.relative,
        fromX: relativePoint, fromY: relativePoint, toX: relativePoint, toY: relativePoint }).strict(),
    ]) }).strict(),
    operation('screenshot', window),
  ])
}

/** Portable model operations, including standard hover without a system-pointer option. */
export const Request = requestSchema(z.union(MouseMoveTargets))

/** Model operations for providers that can move the user's system pointer. */
export const SystemPointerRequest = requestSchema(z.union(MouseMoveTargets.map(target => target.extend({
  useSystemPointer: z.boolean().optional().describe('Request use of the system pointer. The Host checks permission before dispatch.'),
}))))

/** Native resource fields supplied or completed by the Host before dispatch. */
export const NativeResourceParameters = {
  getState: nativeTraversalLimits,
  drag: z.object({ durationMs: z.number().int().min(1).max(5000), steps: z.number().int().min(1).max(240) }).strict(),
  paste: z.object({ maxClipboardBytes: z.number().int().min(1024), pasteReadTimeoutMs: z.number().int().min(1).max(2 ** 31 - 1),
    ...nativeTraversalLimits.shape,
  }).strict(),
  findApps: z.object({ maxAppMatches: z.number().int().min(1).max(1000) }).strict(),
}
/** Host-only launch continuation and user-facing system permission controls; absent from model arguments. */
export const NativeOnlyOperations = [
  operation('launchApp', app), operation('permissionStatus', {}),
  operation('applicationIcons', { paths: z.array(z.string().min(1)) }),
  operation('requestPermission', { permission: z.enum(['accessibility', 'screenRecording']) }),
  operation('openPermissionSettings', { permission: z.enum(['accessibility', 'screenRecording']) }),
] as const

/** Application selection returned only after a successful app selection. */
export const AppResult = z.object({
  appHandle: z.string().min(1).transform(value => value as CuaAppHandle),
  name: z.string(), bundleId: z.string().optional(), running: z.boolean(),
})
/** Running application records from the helper. */
export const AppsResult = z.array(z.object({ pid, name: z.string(), bundleId: z.string().optional() }))
/** Installed application matches keep running and stopped records distinct. */
export const FoundAppsResult = z.array(z.intersection(z.object({ id: z.string().min(1), displayName: z.string(), path: z.string().min(1) }),
  z.discriminatedUnion('isRunning', [z.object({ isRunning: z.literal(true), pid }), z.object({ isRunning: z.literal(false) })])))
/** Current windows and their global native bounds. */
export const WindowsResult = z.array(z.object({
  windowId: id, appName: z.string(), title: z.string(), bounds,
  isOnScreen: z.boolean(), onCurrentSpace: z.boolean().nullable(),
}))
/** Observed state for the selected application or window. */
export const StateResult = z.object({
  appHandle: z.string().min(1).transform(value => value as CuaAppHandle),
  windowId: id.nullable(),
  focusedWindowId: id.nullable().optional(),
  snapshotId: z.string().min(1).transform(value => value as CuaSnapshotId),
  tree: z.string(), windows: WindowsResult, truncated: z.boolean(),
})
/** Provider-defined action names for one element, including attribute-setting operations; an element may advertise none. */
export const ActionNamesResult = z.array(z.string())
/** Original native PNG and platform window geometry before Host image preparation. */
export const NativeScreenshotResult = z.object({
  mimeType: z.literal('image/png'), data: imageBase64, pixelWidth: id, pixelHeight: id, windowId: id,
  bounds: bounds.extend({ width: z.number().positive(), height: z.number().positive() }),
  coordinateSpace: z.enum(['window-points', 'window-pixels']),
})
/** Encoded model-request image; default input coordinates use these pixel dimensions. */
export const ScreenshotResult = NativeScreenshotResult.extend({
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']), coordinateSpace: z.literal('screenshot-pixels'),
})
/** Permissions are reported without opening system permission dialogs. */
export const CapabilitiesResult = z.object({
  platform: z.string(), permissions: z.object({ accessibility: z.boolean(), screenRecording: z.boolean() }),
  /** Whether the provider supports application-level accessibility observations. */
  appLevelAccessibility: z.boolean(),
  /** Whether mouseMove accepts an explicit request to move the system pointer. */
  systemPointer: z.boolean().default(false),
  /** Scopes that support keyboard input. */
  keyboard: z.array(z.enum(['app', 'window'])),
  sessionLocked: z.boolean().nullable(),
  methods: z.array(z.string()), coordinateSpace: z.literal('screenshot-pixels'), browser: z.literal(false),
})
/** Reports whether the provider successfully executed the requested operation. */
export const ActionResult = z.object({
  /** True when the provider successfully executed the operation; false when no applicable operation was found. */
  dispatched: z.boolean(),
  /** Sampled foreground change; omitted when the provider does not sample this action, null when a requested sample was unavailable. */
  foregroundChanged: z.boolean().nullable().optional(),
})
/** Hover reports whether the selected route moved the user's system pointer. */
export const HoverResult = ActionResult.extend({ hoverRoute: z.enum(['accessibility', 'system-pointer']), systemPointerMoved: z.boolean() })
/** Background restoration dispatch and sampled foreground changes; null means the observation was unavailable. */
export const ShowResult = ActionResult.extend({ windowId: id.nullable(), foregroundChanged: z.boolean().nullable() })

/** Bounded native PNG thumbnail for human presentation, excluded from model results and saved grants. */
export const ApplicationIcon = z.string().max(65536).regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/)
