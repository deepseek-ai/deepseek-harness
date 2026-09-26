/** Native file associations queried from the desktop that owns the path. */
import { runNativeCommand } from './runner.ts'
import { linuxFileApplications } from './file-applications-linux.ts'
import { windowsFileApplications } from './file-applications-windows.ts'
import { nativeFileManager } from './path-opener.ts'
import type { PathOpenerInternals } from './path-opener.ts'
import { parseNativeFileApplications, type NativeFileApplication } from './types.ts'

/** AppKit runs inside the system JXA host; paths arrive as argv, never executable source. */
const MAC_APPLICATIONS = `
ObjC.import('AppKit');
function run(argv) {
  var workspace = $.NSWorkspace.sharedWorkspace;
  var file = $.NSURL.fileURLWithPath(argv[0]);
  var preferred = workspace.URLForApplicationToOpenURL(file);
  var preferredPath = preferred.isNil() ? null : ObjC.unwrap(preferred.path);
  var urls = workspace.URLsForApplicationsToOpenURL(file);
  var apps = [];
  for (var i = 0; i < urls.count; i++) {
    var url = urls.objectAtIndex(i);
    var path = ObjC.unwrap(url.path);
    var image = null;
    if (argv[1] === 'icons') {
      var icon = workspace.iconForFile(path);
      var thumbnail = $.NSImage.alloc.initWithSize($.NSMakeSize(32, 32));
      thumbnail.lockFocus;
      icon.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, 32, 32), $.NSZeroRect, $.NSCompositingOperationSourceOver, 1);
      thumbnail.unlockFocus;
      var bitmap = $.NSBitmapImageRep.imageRepWithData(thumbnail.TIFFRepresentation);
      var png = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
      image = png.isNil() ? null : 'data:image/png;base64,' + ObjC.unwrap(png.base64EncodedStringWithOptions(0));
    }
    var bundle = $.NSBundle.bundleWithURL(url);
    var bundleId = bundle.isNil() || bundle.bundleIdentifier.isNil() ? null : ObjC.unwrap(bundle.bundleIdentifier);
    var version = bundle.isNil() ? null : bundle.objectForInfoDictionaryKey('CFBundleShortVersionString');
    apps.push({
      id: path,
      name: ObjC.unwrap($.NSFileManager.defaultManager.displayNameAtPath(path)),
      default: path === preferredPath,
      icon: image,
      bundle: bundleId,
      version: version === null || version.isNil() ? null : String(ObjC.unwrap(version))
    });
  }
  return JSON.stringify(apps);
}`

/**
 * List registered handlers in OS preference order, including the current default and application icons.
 * @param path - verified absolute local file path.
 * @param signal - caller lifetime, propagated to the OS query.
 * @param internals - platform and command adapter for deterministic tests.
 * @returns current file handlers; on macOS, copies sharing a bundle identifier and display name collapse
 * to one entry; an empty list when the platform has no association query.
 */
export async function nativeFileApplications(
  path: string, signal: AbortSignal, internals: PathOpenerInternals = {},
): Promise<readonly NativeFileApplication[]> {
  return queryFileApplications(path, signal, internals, true)
}

/**
 * Query handler metadata; display queries render macOS icons and collapse duplicate copies,
 * launch validation keeps every registered copy.
 */
async function queryFileApplications(
  path: string, signal: AbortSignal, internals: PathOpenerInternals, display: boolean,
): Promise<readonly NativeFileApplication[]> {
  signal.throwIfAborted()
  const target = await desktopTarget(path, signal, internals)
  const run = internals.run ?? runNativeCommand
  if (target.platform === 'linux') return linuxFileApplications(path, signal, run, internals.env ?? process.env)
  if (target.platform === 'darwin') {
    const { stdout } = await run('osascript', ['-l', 'JavaScript', '-e', MAC_APPLICATIONS, target.path, display ? 'icons' : 'handlers'], signal)
    const applications = parseMacApplications(JSON.parse(stdout))
    return display ? dedupeMacApplications(applications) : applications
  }
  if (target.platform !== 'win32') return []
  const stdout = await windowsFileApplications(target.path, null, signal, run)
  return parseNativeFileApplications(JSON.parse(stdout))
}

/** One validated macOS handler with the grouping metadata the display query strips. */
interface MacApplication extends NativeFileApplication {
  readonly bundle: string | null
  readonly version: string | null
}

/**
 * Validate every entry of the decoded macOS query output, base fields and grouping metadata alike.
 * @param value - decoded application list from the macOS query.
 * @returns validated handlers in OS preference order.
 * @throws Error when any entry is malformed, matching the other platform parsers.
 */
function parseMacApplications(value: unknown): readonly MacApplication[] {
  if (!Array.isArray(value)) throw new Error('Invalid native application list')
  const entries: readonly unknown[] = value
  return entries.map((entry) => {
    if (typeof entry !== 'object' || entry === null) throw new Error('Invalid native application entry')
    const bundle = macField('bundle' in entry ? entry.bundle : null)
    const version = macField('version' in entry ? entry.version : null)
    const [base] = parseNativeFileApplications([entry])
    // oxlint-disable-next-line typescript/no-non-null-assertion -- a one-entry input parses to one entry
    return { ...base!, bundle, version }
  })
}

/** Validate one optional string field value of a macOS entry; missing fields, null, and empty strings read as null. */
function macField(field: unknown): string | null {
  if (field === null) return null
  if (typeof field !== 'string') throw new Error('Invalid native application entry')
  return field.length === 0 ? null : field
}

/**
 * Collapse duplicate registrations of the same application for display. Self-updating
 * apps leave extra copies on disk (an update staged under Application Support,
 * per-version installs) and LaunchServices registers every one, so the raw handler
 * list repeats the app. Finder shows one entry per app and splits only deliberate
 * side-by-side installs, which carry distinct display names; matching that, copies
 * sharing a bundle identifier and display name collapse to the system default, else
 * the highest version, at the group's first position. Launch validation bypasses
 * this collapse, so every registered copy stays openable.
 * @param applications - validated handlers in OS preference order.
 * @returns application metadata with one entry per application and no grouping metadata.
 */
function dedupeMacApplications(applications: readonly MacApplication[]): readonly NativeFileApplication[] {
  const order: MacApplication[] = []
  const groups = new Map<string, number>()
  for (const app of applications) {
    if (app.bundle === null) {
      order.push(app)
      continue
    }
    const key = `${app.bundle}\u0000${app.name}`
    const index = groups.get(key)
    if (index === undefined) {
      groups.set(key, order.length)
      order.push(app)
      continue
    }
    // oxlint-disable-next-line typescript/no-non-null-assertion -- group indices point at pushed entries
    const held = order[index]!
    if (held.default) continue
    if (app.default || compareVersions(app.version, held.version) > 0) order[index] = app
  }
  return order.map(({ id, name, default: preferred, icon }) => ({ id, name, default: preferred, icon }))
}

/** Order two dotted version strings numerically; non-numeric segments count as 0, and a missing version sorts lowest. */
function compareVersions(left: string | null, right: string | null): number {
  if (left === null || right === null) return left === right ? 0 : left === null ? -1 : 1
  const a = left.split('.')
  const b = right.split('.')
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (Number(a[i]) || 0) - (Number(b[i]) || 0)
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * Open a file in a currently registered handler; stale or arbitrary application identifiers are rejected.
 * Validation checks the complete registered list, so macOS copies collapsed out of the display list stay openable.
 * @param path - verified absolute local file path.
 * @param application - identifier returned by the file association query.
 * @param signal - caller lifetime, propagated to query and launch.
 * @param internals - platform and command adapter for deterministic tests.
 * @returns after the system launcher accepts the file.
 */
export async function openNativeFileApplication(
  path: string, application: string, signal: AbortSignal, internals: PathOpenerInternals = {},
): Promise<void> {
  const target = await desktopTarget(path, signal, internals)
  const run = internals.run ?? runNativeCommand
  if (target.platform === 'win32') {
    await windowsFileApplications(target.path, application, signal, run)
    return
  }
  const apps = await queryFileApplications(path, signal, internals, false)
  if (!apps.some(app => app.id === application)) throw new Error('Application is not registered for this file')
  if (target.platform === 'linux') await run('gio', ['launch', application, path], signal)
  else await run('open', ['-a', application, path], signal)
}

/** Resolve the desktop that owns the file, including Windows applications reached from WSL. */
async function desktopTarget(
  path: string, signal: AbortSignal, internals: PathOpenerInternals,
): Promise<{ platform: NodeJS.Platform; path: string }> {
  signal.throwIfAborted()
  const platform = internals.platform ?? process.platform
  if (platform === 'linux' && nativeFileManager(internals) === 'explorer') {
    const translated = await (internals.run ?? runNativeCommand)('wslpath', ['-w', path], signal)
    signal.throwIfAborted()
    const windowsPath = translated.stdout.replace(/[\r\n]+$/, '')
    if (windowsPath === '') throw new Error('wslpath returned no Windows path')
    return { platform: 'win32', path: windowsPath }
  }
  return { platform, path }
}
