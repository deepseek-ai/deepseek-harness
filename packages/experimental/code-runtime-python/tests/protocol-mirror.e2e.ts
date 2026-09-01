import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { logTruncationMarker, PROTOCOL_FD, WIRE_FRAME_FIELDS } from '../src/protocol.ts'

/**
 * Cross-language mirror check between `src/protocol.ts` and `py/protocol.py`,
 * spawning a real `python3` to read the Python side. Two things are asserted:
 * the runtime surfaces both sides EXECUTE against — `PROTOCOL_FD` and the log
 * truncation marker text, where a drift silently corrupts a live run — and the
 * per-frame wire field sets (required/optional keys of each `TypedDict`), which
 * turns the otherwise review-only shape mirror into an executable check that
 * catches the round-12 kind of drift (a renamed/dropped field, or one side
 * making a field optional the other requires). Self-skips when no `python3` is
 * on PATH — CI provides one; the pure-TS `protocol.spec.ts` covers the host
 * codec unconditionally.
 */

const execFileAsync = promisify(execFile)
const pyDir = fileURLToPath(new URL('../py', import.meta.url))
// `-B` blocks bytecode writes into the source tree (`py/__pycache__/*.pyc`);
// `-I` isolates the interpreter but does not imply it.
const python3Flags = ['-I', '-B']

async function hasPython3(): Promise<boolean> {
  try {
    await execFileAsync('python3', ['--version'])
    return true
  } catch {
    return false
  }
}

const python3Available = await hasPython3()

describe.skipIf(!python3Available)('protocol.py mirrors protocol.ts at runtime', () => {
  it('agrees on PROTOCOL_FD and the log truncation marker across byte budgets', async () => {
    const budgets = [1, 65536, 1048576]
    const probe = [
      'import json, sys',
      `sys.path.insert(0, ${JSON.stringify(pyDir)})`,
      'from protocol import PROTOCOL_FD, log_truncation_marker',
      `budgets = ${JSON.stringify(budgets)}`,
      'print(json.dumps({',
      '  "fd": PROTOCOL_FD,',
      '  "markers": [log_truncation_marker(b) for b in budgets],',
      '}))',
    ].join('\n')
    const { stdout } = await execFileAsync('python3', [...python3Flags, '-c', probe])
    const seen = JSON.parse(stdout) as { fd: number; markers: string[] }
    // Assert against the TS-side PROTOCOL_FD export (the value the host wires),
    // not a bare literal, so a drift on either side of the wire is caught here.
    expect(seen.fd).toBe(PROTOCOL_FD)
    expect(seen.markers).toEqual(budgets.map(budget => logTruncationMarker(budget)))
  })

  it('agrees on every frame type\'s wire field set between the TS and Python declarations', async () => {
    // Turn the TypedDict mirror from a review-only obligation into an executable
    // check: enumerate EVERY TypedDict in py/protocol.py (public names carrying
    // __required_keys__) and assert both the frame roster and each frame's
    // required/optional key sets against WIRE_FRAME_FIELDS — projected from the
    // WIRE_FRAME_FIELD_ROLES map that `satisfies` binds exhaustively to the
    // frame interfaces in protocol.ts. Together this catches drift on EITHER
    // side of the wire: a TS-side field add, remove, rename, or optionality flip
    // fails typecheck at the roles map; a Python frame added, removed, or with a
    // changed field set fails this comparison. `global` is the reserved-keyword
    // wire key the Python side carries via a functional TypedDict.
    const probe = [
      'import json, sys',
      `sys.path.insert(0, ${JSON.stringify(pyDir)})`,
      'import protocol as p',
      'def keys(td): return {"required": sorted(td.__required_keys__), "optional": sorted(td.__optional_keys__)}',
      // Every public TypedDict in the module — not a name list from the TS side,
      // so a Python-only extra frame is visible here.
      'frames = {n: keys(v) for n, v in vars(p).items()'
      + ' if not n.startswith("_") and hasattr(v, "__required_keys__")}',
      'print(json.dumps(frames))',
    ].join('\n')
    const { stdout } = await execFileAsync('python3', [...python3Flags, '-c', probe])
    const seen = JSON.parse(stdout) as Record<string, { required: string[]; optional: string[] }>
    // Normalize the TS source of truth to the same sorted shape Python reports.
    const expected = Object.fromEntries(
      Object.entries(WIRE_FRAME_FIELDS).map(([name, sets]) => [
        name,
        { required: [...sets.required].sort(), optional: [...sets.optional].sort() },
      ]),
    )
    // Same frame roster on both sides (catches a frame present on only one),
    // then identical field sets per frame.
    expect(Object.keys(seen).sort()).toEqual(Object.keys(expected).sort())
    expect(seen).toEqual(expected)
  })
})

it('names the py/ directory that ships with the package', () => {
  // Resolves py/ relative to this test file; the same directory ships in the
  // package.json `files` whitelist (`py/**/*.py`). The tests/ directory itself
  // is not published — this asserts the source-tree layout the mirror test
  // depends on, so it holds even when python3 is absent from the runner.
  expect(existsSync(pyDir)).toBe(true)
})
