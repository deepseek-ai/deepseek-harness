/**
 * Versionless, JSON-lines wire protocol between the Node host and the CPython subprocess. Frames
 * travel on the child's fd 3 (one JSON object per line), leaving stdout/stderr free for the
 * program's own output. Host treats every inbound frame as hostile because model code can post
 * anything through the same fd; the Python bootstrap trusts host replies.
 * @module @deepseek-ai/dsh-experimental-code-runtime-python/src/protocol
 */

/**
 * The framed-JSON channel's file descriptor from the child's perspective. The
 * host pins it positionally when it spawns the child (`stdio` index 3, i.e.
 * `['pipe','pipe','pipe','pipe']`), and the Python bootstrap reads the same
 * number from its own `protocol.py`. Exported as the single TS-side source of
 * truth: the host wiring uses it, and the cross-language mirror test asserts the
 * Python constant equals it, so a drift on either side breaks the boot channel
 * loudly rather than silently.
 */
export const PROTOCOL_FD = 3

/**
 * One binding namespace declaration inside a {@link BootMessage}. `global` is
 * the program-visible name the namespace is materialized under; `errorClass`,
 * when present, asks the bootstrap to mint a program-visible exception class.
 */
interface Namespace {
  global: string
  names: string[]
  errorClass?: ErrorClass
}

/**
 * A namespace's program-visible exception class: rejected calls raise its
 * instances carrying the failed member name on `memberNameProperty`.
 */
interface ErrorClass {
  name: string
  memberNameProperty: string
}

/**
 * What the host sends immediately after spawn, as the first line on fd 3. The
 * Python bootstrap reads this, applies resource limits, then waits for the
 * subsequent run frame. Separated from the run so the run message stays
 * pure model input.
 */
export interface BootMessage {
  type: 'boot'
  /** RLIMIT_CPU seconds; the Python bootstrap sets this on itself before executing model code. */
  cpuSeconds: number
  /** RLIMIT_AS bytes; caps address space so a runaway allocation fails cleanly. */
  addressSpaceBytes: number
  /** Shared byte budget for captured log text (Python-side ledger). */
  maxLogBytes: number
  /** Byte cap for the rendered completion value. */
  maxValueBytes: number
  /**
   * The namespaces to materialize inside the program (globals + names;
   * functions stay host-side). See {@link Namespace}.
   */
  namespaces: Namespace[]
}

/** Host → Python: sent after `boot-ack`; carries only the model's program body. */
interface RunMessage {
  type: 'run'
  program: string
}

/** Python → host: acknowledges boot completed and resource limits are in place. */
interface BootAckMessage {
  type: 'boot-ack'
}

/** Python → host: one bridged binding call (`await tools.name(args)` inside the program). */
interface CallMessage {
  type: 'call'
  /** Python-issued correlation id; the host answers each id at most once and ignores duplicates. */
  id: number
  /** The namespace global the call targets. */
  global: string
  /** The function name within the namespace. */
  name: string
  /** The JSON-safe argument the model program passed. */
  args: unknown
}

/**
 * Python → host: captured text, streamed eagerly so output survives a
 * mid-run termination (RLIMIT_CPU, SIGTERM/SIGKILL, host wall-timeout).
 */
interface LogMessage {
  type: 'log'
  text: string
  /**
   * Set when this frame IS the child ledger's truncation marker rather than
   * program output. The two ledgers can exhaust at different points — one
   * child entry larger than `maxLogBytes` sends only the marker while the host
   * ledger is still nearly empty — so the host cannot infer the child's state
   * from its own budget, and comparing the text against the marker string
   * would also honour a program that printed that string itself. Carrying it
   * as a field lets the host stop capturing at the same point the child did
   * and keeps exactly one marker in `logs`.
   */
  truncated?: boolean
  /**
   * Set on the frame an explicit `flush()` (or the settlement flush) pushes for
   * an UNTERMINATED line: the host holds it and appends the next log frame to
   * the same entry, so `print('a', end='', flush=True); print('b')` reads back
   * as one `'ab'` entry rather than a fake newline between two entries.
   */
  open?: boolean
}

/** The failure carried on a {@link DoneMessage}: one of three kinds plus text. */
interface DoneErrorField {
  kind: 'exception' | 'invalid-output' | 'output-limit'
  message: string
}

/**
 * Python → host: the program settled. `error` carries a program exception
 * (traceback text), an `invalid-output` (completion value was not lossless
 * JSON), or an `output-limit` (serialized completion exceeded the configured
 * cap); wall/CPU budgets, aborts, and substrate death are observed host-side.
 * From the honest child `value` is present only on a clean completion that
 * produced one, and crosses as exact lossless JSON — never substituted or
 * truncated. A forged frame CAN carry both `value` and `error`;
 * {@link validateChildFrame} preserves both rather than guessing which to drop,
 * so a consumer MUST check `error` first and ignore `value` when it is set.
 */
interface DoneMessage {
  type: 'done'
  value?: unknown
  error?: DoneErrorField
}

/**
 * Every message the Python side sends. The member interfaces stay module-
 * private: consumers match on the union's discriminant; the host sends the
 * boot and run frames as inline literals.
 */
export type ChildToHost = BootAckMessage | CallMessage | LogMessage | DoneMessage

/** Host → Python: successful answer to one {@link CallMessage}. */
interface ReplyOk {
  type: 'reply'
  id: number
  ok: true
  value: unknown
}

/** Host → Python: failed answer to one {@link CallMessage}. */
interface ReplyErr {
  type: 'reply'
  id: number
  ok: false
  message: string
}

/** Host → Python: the answer to one {@link CallMessage}. */
export type ReplyMessage = ReplyOk | ReplyErr

/** The required (non-optional) keys of `T`, as string literals. */
type RequiredKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? never : K }[keyof T] & string
/** The optional keys of `T`, as string literals. */
type OptionalKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? K : never }[keyof T] & string

/**
 * Whether each key of frame `T` is a `'required'` or `'optional'` wire field.
 * Because it is `Record<keyof T, …>`, an entry MUST list every key — a field
 * added to the interface without a corresponding entry fails typecheck — and
 * `keyof T`-typed keys reject a name no frame declares. The `'required'` /
 * `'optional'` tag must match the field's actual optionality (checked by the
 * `satisfies FrameFieldRoles<…>` clause on {@link WIRE_FRAME_FIELD_ROLES}), so
 * an optionality flip is caught too. This is the exhaustive counterpart the
 * array form could not express (a subset array satisfied it silently).
 */
type FrameFieldRoles<T> = Record<RequiredKeys<T>, 'required'> & Record<OptionalKeys<T>, 'optional'>

interface WireFrameShapes {
  BootMessage: BootMessage
  Namespace: Namespace
  RunMessage: RunMessage
  BootAckMessage: BootAckMessage
  CallMessage: CallMessage
  LogMessage: LogMessage
  DoneErrorField: DoneErrorField
  DoneMessage: DoneMessage
  ErrorClass: ErrorClass
  ReplyOk: ReplyOk
  ReplyErr: ReplyErr
}

/**
 * The frames carried on a message union: everything the host and child send as
 * a top-level frame (`ChildToHost`, the two reply variants, and the host→child
 * boot/run frames). The nested shapes `Namespace`, `ErrorClass`, and
 * `DoneErrorField` are fields of other frames, not frames themselves, so they
 * are excluded here and covered only by the roles `satisfies` and the mirror e2e.
 */
type MessageFrames = ChildToHost | ReplyMessage | BootMessage | RunMessage
/** The roster's value types minus the three nested (non-frame) shapes. */
type RosterMessageFrames = Exclude<WireFrameShapes[keyof WireFrameShapes], Namespace | ErrorClass | DoneErrorField>

/**
 * Compile-time proof that {@link WireFrameShapes}'s message-frame entries are
 * EXACTLY the frames on the message unions — checked BOTH directions. Forward
 * (`MessageFrames extends RosterMessageFrames`) catches a frame added to a union
 * without a roster entry; reverse (`RosterMessageFrames extends MessageFrames`)
 * catches a frame removed from a union while the roster still lists it (e.g.
 * dropping `ReplyErr` from `ReplyMessage`). Either divergence makes an alias
 * `false`, failing the assignment below. Type-only; the `const`s emit nothing
 * meaningful at runtime.
 */
type UnionSubsetOfRoster = [MessageFrames] extends [RosterMessageFrames] ? true : false
type RosterSubsetOfUnion = [RosterMessageFrames] extends [MessageFrames] ? true : false
const _unionSubsetOfRoster: UnionSubsetOfRoster = true
const _rosterSubsetOfUnion: RosterSubsetOfUnion = true
void _unionSubsetOfRoster
void _rosterSubsetOfUnion

/**
 * Each frame's wire fields tagged by required/optional, keyed by field name so
 * the mapping is exhaustive over the frame interface (see {@link FrameFieldRoles})
 * across the whole {@link WireFrameShapes} roster. Bound to the interfaces by
 * `satisfies` below; {@link WIRE_FRAME_FIELDS} projects it to sorted
 * required/optional arrays for the cross-language mirror comparison. `global` is
 * the JSON key {@link CallMessage} and {@link Namespace} send (a reserved word
 * the Python side carries via a functional `TypedDict`).
 */
const WIRE_FRAME_FIELD_ROLES = {
  BootMessage: { type: 'required', cpuSeconds: 'required', addressSpaceBytes: 'required', maxLogBytes: 'required', maxValueBytes: 'required', namespaces: 'required' },
  Namespace: { global: 'required', names: 'required', errorClass: 'optional' },
  RunMessage: { type: 'required', program: 'required' },
  BootAckMessage: { type: 'required' },
  CallMessage: { type: 'required', id: 'required', global: 'required', name: 'required', args: 'required' },
  LogMessage: { type: 'required', text: 'required', truncated: 'optional', open: 'optional' },
  DoneErrorField: { kind: 'required', message: 'required' },
  DoneMessage: { type: 'required', value: 'optional', error: 'optional' },
  ErrorClass: { name: 'required', memberNameProperty: 'required' },
  ReplyOk: { type: 'required', id: 'required', ok: 'required', value: 'required' },
  ReplyErr: { type: 'required', id: 'required', ok: 'required', message: 'required' },
} as const satisfies { [K in keyof WireFrameShapes]: FrameFieldRoles<WireFrameShapes[K]> }

/**
 * The wire field names of each frame, split into sorted required and optional
 * key arrays — the shape the cross-language mirror test compares against
 * `py/protocol.py`'s `TypedDict` `__required_keys__`/`__optional_keys__`.
 * Projected from {@link WIRE_FRAME_FIELD_ROLES}, so it inherits that mapping's
 * exhaustive, optionality-checked binding to the frame interfaces: a TS-side
 * field add, remove, rename, or optionality flip fails typecheck at the roles
 * map, and a Python-side divergence fails the mirror test at runtime.
 */
export const WIRE_FRAME_FIELDS =
  Object.fromEntries(
    Object.entries(WIRE_FRAME_FIELD_ROLES).map(([frame, roles]) => {
      const required = Object.keys(roles).filter(key => (roles as Record<string, string>)[key] === 'required').sort()
      const optional = Object.keys(roles).filter(key => (roles as Record<string, string>)[key] === 'optional').sort()
      return [frame, { required, optional }]
    }),
  ) as Record<keyof typeof WIRE_FRAME_FIELD_ROLES, { required: string[]; optional: string[] }>


/**
 * The in-band marker text announcing that log capture stopped at the byte
 * budget. Shared wire vocabulary: the Python-side LogBuffer emits it when ITS
 * ledger exhausts, and the host emits identical text when its own ledger drops
 * a frame first (forged fd-3 traffic, stray stdout bytes) — a truncated run
 * reads the same however the cap was hit.
 * @param maxBytes - the configured `maxLogBytes` the marker names.
 * @returns the marker line.
 */
export function logTruncationMarker(maxBytes: number): string {
  return `[dsh-code-runtime-python] log capture truncated at ${maxBytes} bytes`
}

/**
 * Serialize one JSON-parse-produced value without recursion. `JSON.stringify`
 * recurses per nesting level and throws `RangeError` a few thousand levels
 * deep, but the seam's `CodeJsonValue` has no depth limit — an honest deep
 * completion or binding resolution below the byte budget must cross intact
 * (the worker backend's wire is equally stack-safe). Callers must pass a value
 * produced by `JSON.parse` (or equally JSON-plain): only `null`, finite
 * numbers, booleans, strings, dense arrays, and plain objects — this encoder
 * validates nothing. Output matches compact `JSON.stringify` byte for byte
 * EXCEPT on an integral double beyond the safe range, where {@link scalarJson}
 * emits the exact integer's BigInt digits rather than `JSON.stringify`'s rounded
 * spelling (`1152921504606846976`, not `...847000`) so the seam's lossless-JSON
 * promise holds across the wire.
 * @param value - a JSON-plain value (e.g. straight from `JSON.parse`).
 * @returns the compact JSON encoding.
 */
export function encodeJsonPlain(value: unknown): string {
  // The task stack holds every member of the currently open containers — O(width)
  // — but the encoded OUTPUT is itself O(total bytes) and the stack holds only
  // references, so the walk's auxiliary state is same-order as its result; the
  // metering walks (checkDoneValue/hasNonLosslessNumber) are the ones that must
  // stay O(depth), since they can reject a wide payload without producing any
  // output. Exempted by that same-order argument.
  type Task = { text: string } | { value: unknown }
  const chunks: string[] = []
  const tasks: Task[] = [{ value }]
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    if ('text' in task) {
      chunks.push(task.text)
      continue
    }
    const current = task.value
    if (typeof current === 'string') {
      chunks.push(JSON.stringify(current))
    } else if (Array.isArray(current)) {
      chunks.push('[')
      tasks.push({ text: ']' })
      for (let index = current.length - 1; index >= 0; index--) {
        if (index < current.length - 1) tasks.push({ text: ',' })
        tasks.push({ value: current[index] })
      }
    } else if (typeof current === 'object' && current !== null) {
      const record = current as Record<string, unknown>
      chunks.push('{')
      tasks.push({ text: '}' })
      const keys = Object.keys(record)
      for (let index = keys.length - 1; index >= 0; index--) {
        const key = keys[index] as string
        if (index < keys.length - 1) tasks.push({ text: ',' })
        tasks.push({ value: record[key] })
        tasks.push({ text: `${JSON.stringify(key)}:` })
      }
    } else {
      chunks.push(scalarJson(current))
    }
  }
  return chunks.join('')
}

/**
 * One scalar (null, boolean, finite number) as JSON text. A beyond-safe-range
 * integral double needs BigInt digits: `String(2 ** 60)` emits the ROUNDED
 * `...847000` form, and echoing that to the child would silently change the
 * integer the seam promised to carry losslessly — `BigInt(2 ** 60)` prints the
 * exact `...846976` the double actually holds.
 * @param current - a JSON-plain scalar (JSON.parse emits nothing else).
 * @returns its JSON encoding.
 */
function scalarJson(current: unknown): string {
  if (typeof current === 'number' && Number.isInteger(current) && !Number.isSafeInteger(current)) {
    return BigInt(current).toString()
  }
  return String(current)
}

/**
 * Exact UTF-8 byte length of one string's compact JSON form (quotes + escapes),
 * computed by a single non-allocating scan that stops the instant the running
 * total exceeds `maxBytes`. Used instead of `Buffer.byteLength(JSON.stringify(s))`
 * so a control-heavy forged string — whose escaped copy expands up to ~6x — is
 * rejected BEFORE that copy is materialized: `JSON.stringify` would allocate the
 * full escaped form first, the very hundreds-of-MB spike the metered traversal
 * exists to avoid. Mirrors `JSON.stringify`'s escaping byte-for-byte: `"` and
 * `\` and the five short C0 escapes cost 2, other C0 controls `\uXXXX` cost 6, a
 * valid surrogate pair is one astral code point emitted as raw 4-byte UTF-8, a
 * LONE surrogate becomes `\uXXXX` at 6, and any other code point costs its raw
 * UTF-8 width.
 * @param text - the string to meter.
 * @param maxBytes - largest serialized size the caller can still admit.
 * @returns the exact serialized byte length, or `undefined` once it exceeds `maxBytes`.
 */
function jsonStringBytesUpTo(text: string, maxBytes: number): number | undefined {
  let bytes = 2 // the two quotes
  if (bytes > maxBytes) return undefined
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
      bytes += 2 // `\"` `\\` `\b` `\t` `\n` `\f` `\r`
    } else if (code < 0x20) {
      bytes += 6 // other C0 controls: `\uXXXX`
    } else if (code < 0x80) {
      bytes += 1
    } else if (code < 0x800) {
      bytes += 2
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4 // valid high+low pair: one astral code point, raw 4-byte UTF-8
        index++
      } else {
        bytes += 6 // lone high surrogate: `\uXXXX`
      }
    } else if (code >= 0xd800 && code <= 0xdfff) {
      bytes += 6 // lone surrogate (unpaired high at end, or any low): `\uXXXX`
    } else {
      bytes += 3 // other BMP code point
    }
    if (bytes > maxBytes) return undefined
  }
  return bytes
}

/**
 * Meter a `JSON.parse`-produced done value's compact-JSON byte length AND its
 * number losslessness in one traversal, stopping the instant `maxBytes` is
 * crossed. This bounds the INCREMENTAL allocation the check itself would add on
 * top of the already-parsed value — the enqueued children; strings and keys are
 * metered by {@link jsonStringBytesUpTo} without allocating an escaped copy —
 * not the parse that produced `value`.
 * That upstream width is bounded separately, by the host-side cap on inbound
 * fd-3 frame size before `JSON.parse` runs (owned by the runtime that reads the
 * channel), so `value` cannot be arbitrarily large when it reaches here. The
 * budget is the `maxValueBytes` the boot frame carries — a required wire field
 * with no default at this layer. The traversal rejects over-budget BEFORE
 * materializing a string's escaped form or enqueuing an array's/object's
 * children, so a forgery within that frame cap cannot force those secondary
 * allocations. Object key COUNTING is
 * unavoidably O(keys) — JS has no lazy own-key iterator, and the parse already
 * built the key set — but the check still refuses the per-entry work before the
 * enqueue loop. A non-lossless number (non-finite, negative zero) is caught only
 * when the value fits the budget — an over-budget value is rejected regardless,
 * so the distinction is moot. Same JSON-plain precondition and traversal shape
 * as {@link encodeJsonPlain}; a number's byte length is measured through
 * {@link scalarJson} (matching the encoder, so a beyond-safe-range integer
 * meters its exact BigInt digits, not `JSON.stringify`'s rounded spelling) and
 * a string's/key's through {@link jsonStringBytesUpTo} (the exact escaped size,
 * scanned without allocating the escaped copy).
 * @param value - a JSON-plain value (e.g. straight from `JSON.parse`).
 * @param maxBytes - the completion-value budget in bytes.
 * @returns `{ ok: true, bytes }` with the exact serialized size, or
 * `{ ok: false, reason }` — `over-budget` once the size exceeds `maxBytes`,
 * `non-lossless` on a non-finite or negative-zero number.
 */
export function checkDoneValue(value: unknown, maxBytes: number): { ok: true; bytes: number } | { ok: false; reason: 'over-budget' | 'non-lossless' } {
  let bytes = 0
  // A non-lossless number is recorded, not returned on sight: over-budget must
  // win regardless of where in the value each violation sits, so the whole
  // metering finishes first. Otherwise `["<huge>", 1e400]` and `[1e400,
  // "<huge>"]` — the same over-budget value in two member orders — would
  // classify differently (non-lossless vs over-budget), and the JSDoc promises
  // an over-budget value is rejected as over-budget regardless.
  let nonLossless = false
  // One cursor per OPEN container (a values iterator for the root and arrays,
  // an entries iterator for objects), mirroring hasNonLosslessNumber and the
  // child's _check_done_value: a wide completion near the frame cap would
  // otherwise copy every member's reference onto an explicit work stack —
  // O(width) — OOMing the host after the parse already succeeded. The byte
  // budget still bounds the walk: each member is metered as its cursor yields
  // it, and the width lower-bound checks below bail an over-budget container
  // before the cursor descends.
  const cursors: Cursor[] = [{ kind: 'values', iter: [value].values() }]
  while (cursors.length > 0) {
    // The loop condition guarantees a top cursor.
    const cursor = cursors.at(-1) as Cursor
    const step = cursor.iter.next()
    if (step.done === true) {
      cursors.pop()
      continue
    }
    let current: unknown
    if (cursor.kind === 'entries') {
      // Meter the key's escaped form without allocating it (same reason as the
      // string branch), then add the colon separator, before the value's own
      // bytes are counted.
      const [key, member] = step.value as readonly [string, unknown]
      const keyBytes = jsonStringBytesUpTo(key, maxBytes - bytes)
      if (keyBytes === undefined) return { ok: false, reason: 'over-budget' }
      bytes += keyBytes + 1
      current = member
    } else {
      current = step.value
    }
    if (typeof current === 'number') {
      // Flag a non-lossless number but keep counting its encoded bytes: a value
      // that is BOTH non-lossless and over-budget must classify as over-budget
      // (the loop's byte check below wins), so the byte count cannot skip the
      // offending number. `scalarJson` gives the same spelling a legit scalar
      // would meter.
      if (!Number.isFinite(current) || Object.is(current, -0)) nonLossless = true
      bytes += Buffer.byteLength(scalarJson(current), 'utf8')
    } else if (typeof current === 'string') {
      // Meter the escaped form WITHOUT allocating it: jsonStringBytesUpTo scans
      // and bails the instant the running cost crosses the remaining budget, so
      // a control-heavy forgery (escaped copy up to ~6x) never materializes that
      // copy the way `JSON.stringify` would.
      const stringBytes = jsonStringBytesUpTo(current, maxBytes - bytes)
      if (stringBytes === undefined) return { ok: false, reason: 'over-budget' }
      bytes += stringBytes
    } else if (Array.isArray(current)) {
      // Brackets plus one comma per gap; elements add themselves. Reject
      // BEFORE the cursor descends: every element serializes to at least one
      // byte, so a forged flat array far above the budget fails here without
      // the cursor yielding any of them. (The array itself is already
      // materialized by the upstream parse; this only bounds the extra walk.)
      bytes += 2 + (current.length > 1 ? current.length - 1 : 0)
      if (bytes + current.length > maxBytes) return { ok: false, reason: 'over-budget' }
      cursors.push({ kind: 'values', iter: (current as unknown[]).values() })
    } else if (typeof current === 'object' && current !== null) {
      const record = current as Record<string, unknown>
      // Count own keys with for...in + hasOwn. This IS O(keys) — JS has no lazy
      // own-key iterator and the parse already built the key set — so the count
      // cannot be sublinear; what the bound below buys is refusing the per-entry
      // work (key escaping, value enqueue) before it runs. Each entry costs at
      // least a quoted key (>= 2 bytes) + colon + >= 1-byte value.
      let count = 0
      for (const key in record) if (Object.hasOwn(record, key)) count += 1
      bytes += 2 + (count > 1 ? count - 1 : 0)
      if (bytes + count * 4 > maxBytes) return { ok: false, reason: 'over-budget' }
      cursors.push({ kind: 'entries', iter: ownEntries(record) })
    } else {
      bytes += Buffer.byteLength(scalarJson(current), 'utf8')
    }
    if (bytes > maxBytes) return { ok: false, reason: 'over-budget' }
  }
  // The whole value fit the budget; a recorded number violation is the verdict.
  if (nonLossless) return { ok: false, reason: 'non-lossless' }
  return { ok: true, bytes }
}

/**
 * Whether a raw JSON line contains an integer token that would lose precision
 * as a JavaScript number. `JSON.parse` silently rounds such a token
 * (`9007199254740993` becomes `...992`) BEFORE any validation can see it, so
 * the check must read the source text; a beyond-safe-range token whose double
 * parse round-trips exactly (`2**53`, `2**60`) is lossless and passes. The scan walks the line skipping string literals (a digit run
 * inside a string is data, not a number token) and tests every number token
 * in plain integer form — no fraction or exponent, which parse as doubles by
 * intent. A reviver cannot do this job: the reviver walk recurses per nesting
 * level and would reintroduce the depth limit `encodeJsonPlain` removes.
 * @param line - the raw UTF-8 text of one JSON-lines frame.
 * @returns true when an unsafe integer token is present outside strings.
 */
export function hasUnsafeIntegerToken(line: string): boolean {
  for (let index = 0; index < line.length; index++) {
    const char = line[index]
    if (char === '"') {
      // Skip the string literal, honoring backslash escapes.
      for (index++; index < line.length; index++) {
        if (line[index] === '\\') index++
        else if (line[index] === '"') break
      }
      continue
    }
    if (char === '-' || (char !== undefined && char >= '0' && char <= '9')) {
      let end = index + 1
      while (end < line.length) {
        const c = line[end] as string
        if ((c >= '0' && c <= '9') || c === '.' || c === 'e' || c === 'E' || c === '+' || c === '-') end++
        else break
      }
      const token = line.slice(index, end)
      // Beyond the safe range an integer token is still lossless IFF the
      // double parse round-trips exactly (2**53 does; 2**53+1 rounds) — the
      // canonical boundary accepts every JS-double-exact value, so only a
      // genuinely rounding token marks the frame as forged.
      if (/^-?\d+$/.test(token)) {
        const parsed = Number(token)
        // A token that parses to Infinity is trivially lossy; a finite
        // beyond-safe-range one is lossy only when the BigInt round-trip
        // disagrees.
        if (!Number.isFinite(parsed)) return true
        if (!Number.isSafeInteger(parsed) && BigInt(token) !== BigInt(parsed)) return true
      }
      index = end - 1
    }
  }
  return false
}

/**
 * One open container in checkDoneValue's cursor walk: a values iterator (the
 * root and arrays) or an entries iterator (objects, so each key's escaped
 * bytes can be metered when the entry is reached). A cursor bounds the walk's
 * auxiliary state to O(depth), not O(width).
 */
type Cursor =
  | { kind: 'values'; iter: Iterator<unknown> }
  | { kind: 'entries'; iter: Iterator<readonly [string, unknown]> }

/**
 * Lazily yield one plain object's own enumerable [key, value] entries. The
 * key escapes are metered when {@link checkDoneValue}'s cursor walk reaches
 * each entry, so a wide object never materializes a member list: each entry
 * is produced straight off the already-parsed record, and the escaped key
 * bytes are counted without building the escaped string.
 * @param record - a JSON-parse-produced object.
 * @yields each own enumerable [key, value] pair, in key order.
 */
function* ownEntries(record: Record<string, unknown>): Generator<readonly [string, unknown]> {
  for (const key in record) {
    if (Object.hasOwn(record, key)) yield [key, record[key]]
  }
}

/**
 * Lazily yield one plain object's own enumerable property values. A generator
 * (not `Object.values`/`Object.entries`) because {@link hasNonLosslessNumber}
 * walks breadth it cannot bound: those helpers copy the whole VALUE (or
 * key/value pair) list into a fresh array up front, so a wide object would cost
 * that second full-breadth allocation before a single value is examined. The
 * `for...in` here does not make the walk sublinear — V8 still materializes the
 * key-name enumeration when the loop starts — but it avoids the extra value
 * array, yielding each value straight off the already-parsed object.
 * @param record - a JSON-parse-produced object.
 * @yields each own enumerable property value, in key order.
 */
function* ownValues(record: object): Generator {
  for (const key in record) {
    if (Object.hasOwn(record, key)) yield (record as Record<string, unknown>)[key]
  }
}

/**
 * Whether a JSON.parse-produced value contains a number outside lossless
 * JSON: non-finite (`1e400` parses to `Infinity`) or negative zero (`-0.0`
 * parses to JS `-0`, whose sign bit a re-serialization drops). The honest
 * child's validator rejects these before sending, so a frame carrying one is
 * forged.
 *
 * Runs on `call.args`, which — unlike a completion value — has NO seam byte
 * cap, so there is no budget to reject a wide payload against the way
 * {@link checkDoneValue} does. The traversal therefore holds ONE cursor per
 * NESTING LEVEL (an array or {@link ownValues} iterator) instead of one entry
 * per member: a forged flat `args` at the top of the host's inbound frame-size
 * cap would
 * otherwise push tens of millions of stack entries — and `Object.values` would
 * copy each object's full breadth — allocating hundreds of megabytes beyond
 * what `JSON.parse` already holds. Iterative either way, so a deep frame
 * cannot overflow the host stack.
 * @param value - a JSON-parse-produced value from an fd-3 frame.
 * @returns true when any contained number is non-finite or negative zero.
 */
export function hasNonLosslessNumber(value: unknown): boolean {
  const cursors: Iterator<unknown>[] = [[value].values()]
  while (cursors.length > 0) {
    // The loop condition guarantees a top cursor.
    const cursor = cursors.at(-1) as Iterator<unknown>
    const step = cursor.next()
    if (step.done === true) {
      cursors.pop()
      continue
    }
    const current = step.value
    if (typeof current === 'number') {
      if (!Number.isFinite(current) || Object.is(current, -0)) return true
    } else if (Array.isArray(current)) {
      cursors.push((current as unknown[]).values())
    } else if (typeof current === 'object' && current !== null) {
      cursors.push(ownValues(current))
    }
  }
  return false
}

/**
 * Runtime shape gate for inbound fd-3 traffic. Model code has full access to
 * fd 3 and can post anything — `null`, primitives, poisoned fields — so the
 * compile-time union means nothing here: every field is validated and REBUILT
 * before the host reads it (forged extras never ride along; a non-number id
 * can never be echoed into a reply). Junk returns `undefined` and is dropped
 * so a throw in the host's `message` handler cannot crash the host process.
 * @param raw - one JSON-parsed frame from fd 3.
 * @returns the rebuilt frame, or `undefined` to drop it silently.
 */
export function validateChildFrame(raw: unknown): ChildToHost | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const m = raw as Record<string, unknown>
  switch (m.type) {
    case 'boot-ack':
      return { type: 'boot-ack' }
    case 'log':
      if (typeof m.text !== 'string') return undefined
      // Rebuilt, not passed through: a forged `truncated` of any other type
      // would reach the host as a truthy value and silence capture for the
      // rest of the run. Only the literal `true` counts; `open` likewise.
      return {
        type: 'log',
        text: m.text,
        ...m.truncated === true ? { truncated: true } : {},
        ...m.open === true ? { open: true } : {},
      }
    case 'call': {
      // The id must be a finite number: it is echoed verbatim into the reply
      // frame, and a forged `1e400` id (Infinity after JSON.parse) would make
      // the reply unencodable as strict JSON. Negative zero is rejected too:
      // it passes `Number.isFinite`, but the reply re-serializes it as `0`
      // (`JSON.stringify({id:-0})` is `{"id":0}`), colliding with a real call
      // whose id is `0` — the honest child never issues `-0`.
      if (typeof m.id !== 'number' || !Number.isFinite(m.id) || Object.is(m.id, -0) || typeof m.global !== 'string' || typeof m.name !== 'string') return undefined
      // A forged frame can omit `args` entirely; rebuilding it as `undefined`
      // would invoke the binding with a non-JSON value, bypassing the
      // lossless-JSON argument boundary. Any PRESENT value is JSON-plain by
      // construction (the frame came from JSON.parse), so presence is the
      // whole check.
      if (!Object.hasOwn(m, 'args')) return undefined
      // JSON.parse yields Infinity for 1e400 and preserves -0; both are
      // outside lossless JSON, and the honest child never sends them.
      if (hasNonLosslessNumber(m.args)) return undefined
      return { type: 'call', id: m.id, global: m.global, name: m.name, args: m.args }
    }
    case 'done': {
      // The value passes through untouched here: scanning it for non-lossless
      // numbers would push every member of a wide forged payload before any
      // byte cap runs. The done handler's bounded `checkDoneValue` folds the
      // losslessness check into the metered traversal, rejecting over-budget
      // before it enqueues children.
      const err = m.error
      if (err === undefined) {
        return m.value === undefined ? { type: 'done' } : { type: 'done', value: m.value }
      }
      if (typeof err !== 'object' || err === null) return undefined
      const { kind, message } = err as Record<string, unknown>
      if (typeof message !== 'string') return undefined
      if (kind !== 'exception' && kind !== 'invalid-output' && kind !== 'output-limit') return undefined
      return m.value === undefined
        ? { type: 'done', error: { kind, message } }
        : { type: 'done', value: m.value, error: { kind, message } }
    }
    default:
      return undefined
  }
}
