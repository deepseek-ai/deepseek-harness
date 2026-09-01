import { describe, expect, it } from 'vitest'
import { checkDoneValue, encodeJsonPlain, hasNonLosslessNumber, hasUnsafeIntegerToken, hostFrameParseCeiling, logTruncationMarker, validateChildFrame } from '../src/index.ts'

describe('logTruncationMarker', () => {
  it('names the configured byte budget', () => {
    expect(logTruncationMarker(65536)).toBe('[dsh-code-runtime-python] log capture truncated at 65536 bytes')
    expect(logTruncationMarker(1)).toBe('[dsh-code-runtime-python] log capture truncated at 1 bytes')
  })
})

describe('validateChildFrame', () => {
  it('rebuilds boot-ack frames without extra fields', () => {
    expect(validateChildFrame({ type: 'boot-ack' })).toEqual({ type: 'boot-ack' })
    // Forged extras never ride along.
    expect(validateChildFrame({ type: 'boot-ack', extra: 'x' })).toEqual({ type: 'boot-ack' })
  })

  it('rebuilds log frames when the text field is a string', () => {
    expect(validateChildFrame({ type: 'log', text: 'hi' })).toEqual({ type: 'log', text: 'hi' })
    // Non-string text drops.
    expect(validateChildFrame({ type: 'log', text: 42 })).toBeUndefined()
    expect(validateChildFrame({ type: 'log' })).toBeUndefined()
  })

  it('carries a log frame truncation flag only for the literal true', () => {
    // The child's own ledger marker sets `truncated: true`; the host rebuilds
    // it so it stops capturing at the same point.
    expect(validateChildFrame({ type: 'log', text: 'x', truncated: true }))
      .toEqual({ type: 'log', text: 'x', truncated: true })
    // Any other truthy or non-boolean value is a forgery and is dropped from
    // the rebuild — otherwise it would silence capture for the rest of the run.
    expect(validateChildFrame({ type: 'log', text: 'x', truncated: 1 })).toEqual({ type: 'log', text: 'x' })
    expect(validateChildFrame({ type: 'log', text: 'x', truncated: 'yes' })).toEqual({ type: 'log', text: 'x' })
    expect(validateChildFrame({ type: 'log', text: 'x', truncated: false })).toEqual({ type: 'log', text: 'x' })
  })

  it('rebuilds call frames with a numeric id, string global, and string name', () => {
    expect(validateChildFrame({ type: 'call', id: 1, global: 'tools', name: 'echo', args: { x: 1 } }))
      .toEqual({ type: 'call', id: 1, global: 'tools', name: 'echo', args: { x: 1 } })
    // A frame with NO args key drops whole: rebuilding it as `undefined`
    // would invoke the binding with a non-JSON value, bypassing the
    // lossless-JSON argument boundary. Any present value is JSON-plain by
    // construction (frames arrive via JSON.parse), so null passes.
    expect(validateChildFrame({ type: 'call', id: 2, global: 'tools', name: 'echo' })).toBeUndefined()
    expect(validateChildFrame({ type: 'call', id: 2, global: 'tools', name: 'echo', args: null }))
      .toEqual({ type: 'call', id: 2, global: 'tools', name: 'echo', args: null })
    // A missing/mistyped required field drops.
    expect(validateChildFrame({ type: 'call', id: '1', global: 'tools', name: 'echo' })).toBeUndefined()
    expect(validateChildFrame({ type: 'call', id: 1, global: 7, name: 'echo' })).toBeUndefined()
    expect(validateChildFrame({ type: 'call', id: 1, global: 'tools' })).toBeUndefined()
  })

  it('rebuilds done frames with optional value/error', () => {
    expect(validateChildFrame({ type: 'done' })).toEqual({ type: 'done' })
    expect(validateChildFrame({ type: 'done', value: 42 })).toEqual({ type: 'done', value: 42 })
    expect(validateChildFrame({ type: 'done', error: { kind: 'exception', message: 'boom' } }))
      .toEqual({ type: 'done', error: { kind: 'exception', message: 'boom' } })
    expect(validateChildFrame({ type: 'done', error: { kind: 'invalid-output', message: 'lossy' } }))
      .toEqual({ type: 'done', error: { kind: 'invalid-output', message: 'lossy' } })
    expect(validateChildFrame({ type: 'done', error: { kind: 'output-limit', message: 'big' } }))
      .toEqual({ type: 'done', error: { kind: 'output-limit', message: 'big' } })
    expect(validateChildFrame({ type: 'done', value: 1, error: { kind: 'exception', message: 'boom' } }))
      .toEqual({ type: 'done', value: 1, error: { kind: 'exception', message: 'boom' } })
    // A `value: undefined` field is dropped (JSON never carries it, but a forged
    // shape might; the rebuild coalesces to the absent case).
    expect(validateChildFrame({ type: 'done', value: undefined })).toEqual({ type: 'done' })
    // A missing or unrecognized kind drops the frame: the child always sends
    // one of the three, so anything else is a forgery.
    expect(validateChildFrame({ type: 'done', error: { message: 'boom' } })).toBeUndefined()
    expect(validateChildFrame({ type: 'done', error: { kind: 'timeout', message: 'x' } })).toBeUndefined()
  })

  it('rejects malformed done frames', () => {
    // error must be an object.
    expect(validateChildFrame({ type: 'done', error: 'boom' })).toBeUndefined()
    expect(validateChildFrame({ type: 'done', error: null })).toBeUndefined()
    // error.message must be a string.
    expect(validateChildFrame({ type: 'done', error: {} })).toBeUndefined()
    expect(validateChildFrame({ type: 'done', error: { message: 42 } })).toBeUndefined()
  })

  it('drops non-object inputs and unknown types silently', () => {
    expect(validateChildFrame(null)).toBeUndefined()
    expect(validateChildFrame(undefined)).toBeUndefined()
    expect(validateChildFrame(42)).toBeUndefined()
    expect(validateChildFrame('str')).toBeUndefined()
    expect(validateChildFrame({})).toBeUndefined()
    expect(validateChildFrame({ type: 'unknown' })).toBeUndefined()
  })

  it('drops CALL frames whose args are non-finite or negative zero', () => {
    // JSON.parse turns 1e400 into Infinity and preserves -0; the honest child
    // rejects both before sending, so a call frame carrying one is forged.
    expect(validateChildFrame({ type: 'call', id: 1, global: 'tools', name: 'x', args: { n: Infinity } })).toBeUndefined()
    expect(validateChildFrame({ type: 'call', id: Infinity, global: 'tools', name: 'x', args: null })).toBeUndefined()
    // Plain zero and ordinary floats pass.
    expect(validateChildFrame({ type: 'call', id: 1, global: 'tools', name: 'x', args: [0, 1.5] }))
      .toEqual({ type: 'call', id: 1, global: 'tools', name: 'x', args: [0, 1.5] })
  })

  it('drops a CALL frame whose id is negative zero', () => {
    // `-0` passes Number.isFinite, but the reply re-serializes it as `0`
    // (JSON.stringify({id:-0}) === '{"id":0}'), so a forged `-0` id would
    // collide with a real call whose id is `0`. The honest child never sends it.
    expect(validateChildFrame({ type: 'call', id: -0, global: 'tools', name: 'x', args: null })).toBeUndefined()
    // Plain positive zero is a legitimate id and passes.
    expect(validateChildFrame({ type: 'call', id: 0, global: 'tools', name: 'x', args: null }))
      .toEqual({ type: 'call', id: 0, global: 'tools', name: 'x', args: null })
  })

  it('passes DONE values through untouched — losslessness is metered later', () => {
    // validateChildFrame no longer scans done.value: an unbounded scan would
    // push every member of a wide forged payload before any byte cap ran. The
    // done handler's checkDoneValue folds losslessness into the metered walk.
    expect(validateChildFrame({ type: 'done', value: Infinity })).toEqual({ type: 'done', value: Infinity })
    expect(validateChildFrame({ type: 'done', value: [{ x: -0 }] })).toEqual({ type: 'done', value: [{ x: -0 }] })
    expect(validateChildFrame({ type: 'done', value: [0, 1.5] })).toEqual({ type: 'done', value: [0, 1.5] })
  })
})

describe('lossless-number scan', () => {
  it('finds non-finite and negative-zero numbers at any depth, iteratively', () => {
    expect(hasNonLosslessNumber(Infinity)).toBe(true)
    expect(hasNonLosslessNumber(-Infinity)).toBe(true)
    expect(hasNonLosslessNumber(NaN)).toBe(true)
    expect(hasNonLosslessNumber(-0)).toBe(true)
    expect(hasNonLosslessNumber({ a: [1, { b: -0 }] })).toBe(true)
    expect(hasNonLosslessNumber({ a: [0, 1.5, 'x', null, true] })).toBe(false)
    // Deep nesting must not overflow the stack.
    let deep: unknown = 0
    for (let i = 0; i < 100000; i++) deep = [deep]
    expect(hasNonLosslessNumber(deep)).toBe(false)
  })

  it('walks wide arrays and objects one member at a time', () => {
    // `call.args` carries no seam byte cap, so a wide forged payload has no
    // budget to be rejected against — the walk must hold one cursor per
    // NESTING LEVEL, not one entry per member, or a flat payload at the top of
    // the host's inbound frame-size cap would allocate tens of millions of stack
    // entries (and `Object.values` a second full-breadth copy). Observable
    // through the boundary: a wide payload whose per-member cost the old shape
    // would have paid still scans, and a violation ANYWHERE in it is found
    // wherever it sits.
    const wideArray = new Array(2_000_000).fill(0) as unknown[]
    expect(hasNonLosslessNumber(wideArray)).toBe(false)
    // Last element, so the cursor must run the whole breadth lazily.
    wideArray[wideArray.length - 1] = -0
    expect(hasNonLosslessNumber(wideArray)).toBe(true)
    const wideObject: Record<string, unknown> = {}
    for (let i = 0; i < 200_000; i++) wideObject[`k${i}`] = i
    expect(hasNonLosslessNumber(wideObject)).toBe(false)
    wideObject.last = Infinity
    expect(hasNonLosslessNumber(wideObject)).toBe(true)
    // Interleaved nesting: a per-level cursor must resume its parent after a
    // child level ends, so a violation after a nested container is still seen.
    expect(hasNonLosslessNumber([[1], { a: 2 }, NaN])).toBe(true)
  })

  it('scans only own enumerable properties', () => {
    // The per-level cursor filters own keys (a prototype-carrying frame is
    // impossible off JSON.parse, but the filter is what keeps the walk equal
    // to what the encoder would serialize).
    const withProto = Object.create({ inherited: -0 }) as Record<string, unknown>
    withProto.own = 1
    expect(hasNonLosslessNumber(withProto)).toBe(false)
  })
})

describe('unsafe-integer token scan', () => {
  it('flags integer tokens outside the safe range, skipping strings and float forms', () => {
    expect(hasUnsafeIntegerToken('{"v":9007199254740993}')).toBe(true)
    // Exact beyond-safe-range tokens are lossless and pass (2**53, 2**64).
    expect(hasUnsafeIntegerToken('{"v":9007199254740992}')).toBe(false)
    expect(hasUnsafeIntegerToken('{"v":18446744073709551616}')).toBe(false)
    // A token that parses to Infinity is trivially lossy.
    expect(hasUnsafeIntegerToken(`{"v":${'9'.repeat(400)}}`)).toBe(true)
    expect(hasUnsafeIntegerToken('{"v":-9007199254740993}')).toBe(true)
    expect(hasUnsafeIntegerToken('{"v":9007199254740991}')).toBe(false)
    expect(hasUnsafeIntegerToken('{"v":"9007199254740993"}')).toBe(false)
    expect(hasUnsafeIntegerToken(String.raw`{"v":"esc\"9007199254740993"}`)).toBe(false)
    expect(hasUnsafeIntegerToken('{"v":9007199254740993.0}')).toBe(false)
    expect(hasUnsafeIntegerToken('{"v":9e99}')).toBe(false)
  })
})

describe('checkDoneValue', () => {
  it('matches the exact encoded size and rejects one byte over', () => {
    const cases: unknown[] = [null, true, false, 0, -1.5, 'a"b\\', [], {}, [1, 'x', null], { a: [1, 2], b: { c: 'd' } }]
    for (const value of cases) {
      const exact = Buffer.byteLength(JSON.stringify(value), 'utf8')
      expect(checkDoneValue(value, exact), JSON.stringify(value)).toEqual({ ok: true, bytes: exact })
      expect(checkDoneValue(value, exact - 1), JSON.stringify(value)).toEqual({ ok: false, reason: 'over-budget' })
      expect(encodeJsonPlain(value)).toBe(JSON.stringify(value))
    }
  })

  it('rejects an over-budget value before its secondary allocations', () => {
    // A huge string is refused on the cheap length lower bound, before its
    // escaped copy is built.
    const huge = { data: 'x'.repeat(1_000_000), tail: 'y' }
    expect(checkDoneValue(huge, 1024)).toEqual({ ok: false, reason: 'over-budget' })
    // A flat array far above the budget fails on the brackets+length bound,
    // before its elements are pushed onto the traversal stack. (The array is
    // already materialized by the upstream parse; this only avoids the extra
    // per-element stack growth.)
    const flat = new Array(10_000_000).fill(0)
    expect(checkDoneValue(flat, 1024)).toEqual({ ok: false, reason: 'over-budget' })
    // A wide object: braces+commas fit the cap, but the per-entry lower bound
    // (quoted key + colon + value = count*4) does not, so it fails before any
    // key is escaped or any value enqueued.
    const wide: Record<string, number> = {}
    for (let i = 0; i < 10; i++) wide[`k${i}`] = i
    expect(checkDoneValue(wide, 12)).toEqual({ ok: false, reason: 'over-budget' })
  })

  it('meters a string\'s exact escaped size without allocating it', () => {
    // A control-heavy string that fits by DECODED length but not once escaped
    // must still reject: 200 NULs are 200 UTF-16 units (would pass a naive
    // length bound against cap 1024) but escape to 200*6 + 2 = 1202 bytes.
    // jsonStringBytesUpTo scans and bails before the escaped copy is built.
    expect(checkDoneValue('\0'.repeat(200), 1024)).toEqual({ ok: false, reason: 'over-budget' })
    // Exact-size acceptance, no false rejection: one NUL serializes to a
    // 6-char \\uXXXX escape, so with the two quotes = 8 bytes.
    expect(checkDoneValue('\0', 8)).toEqual({ ok: true, bytes: 8 })
    expect(checkDoneValue('\0', 7)).toEqual({ ok: false, reason: 'over-budget' })
    // Multi-byte and astral characters meter at their raw UTF-8 width (a valid
    // surrogate pair is 4 bytes, matching JSON.stringify), not a 6-byte escape.
    expect(checkDoneValue('\u00e9', 4)).toEqual({ ok: true, bytes: 4 }) // 2 quotes + 2-byte UTF-8
    expect(checkDoneValue('\u{1f600}', 6)).toEqual({ ok: true, bytes: 6 }) // 2 quotes + 4-byte UTF-8
    expect(checkDoneValue('\u{1f600}', 5)).toEqual({ ok: false, reason: 'over-budget' })
    // A lone surrogate escapes to \\uXXXX = 6, so with quotes = 8.
    expect(checkDoneValue('\ud800', 8)).toEqual({ ok: true, bytes: 8 })
    // A high surrogate followed by a NON-low character is a lone surrogate (6-byte
    // escape) plus that character: `\ud800` + `a` = 2 quotes + 6 + 1 = 9.
    expect(checkDoneValue('\ud800a', 9)).toEqual({ ok: true, bytes: 9 })
    // A BMP 3-byte code point (CJK) meters at its raw UTF-8 width: 2 quotes + 3.
    expect(checkDoneValue('中', 5)).toEqual({ ok: true, bytes: 5 })
    // Same non-allocating meter for object keys, before the value is enqueued.
    expect(checkDoneValue({ ['\0'.repeat(200)]: 1 }, 1024)).toEqual({ ok: false, reason: 'over-budget' })
    // A string reached with less than the two quotes' worth of budget is refused
    // immediately (even the empty escaped form does not fit).
    expect(checkDoneValue('x', 1)).toEqual({ ok: false, reason: 'over-budget' })
  })

  it('meters only own enumerable keys', () => {
    // The walk counts keys with a `for...in` + hasOwn pass rather than
    // Object.keys/entries (which allocate per member before the bound). A
    // prototype-carrying forgery is impossible off JSON.parse, but the own-key
    // filter is what keeps the count equal to the encoder's.
    const withProto = Object.create({ inherited: 'x' }) as Record<string, unknown>
    withProto.own = 1
    expect(checkDoneValue(withProto, 1024)).toEqual({ ok: true, bytes: Buffer.byteLength('{"own":1}', 'utf8') })
  })

  it('rejects non-finite and negative-zero numbers at any depth as non-lossless', () => {
    expect(checkDoneValue(Infinity, 1024)).toEqual({ ok: false, reason: 'non-lossless' })
    expect(checkDoneValue(-Infinity, 1024)).toEqual({ ok: false, reason: 'non-lossless' })
    expect(checkDoneValue(NaN, 1024)).toEqual({ ok: false, reason: 'non-lossless' })
    expect(checkDoneValue(-0, 1024)).toEqual({ ok: false, reason: 'non-lossless' })
    expect(checkDoneValue({ a: [1, { b: -0 }] }, 1024)).toEqual({ ok: false, reason: 'non-lossless' })
    // An ordinary finite value within budget passes with its exact byte count.
    const clean = { a: [0, 1.5, 'x', null, true] }
    expect(checkDoneValue(clean, 1024)).toEqual({ ok: true, bytes: Buffer.byteLength(JSON.stringify(clean), 'utf8') })
  })

  it('classifies an over-budget value as over-budget regardless of member order', () => {
    // A value that is BOTH over-budget and non-lossless must reject as
    // over-budget whichever member the walk reaches first — the non-lossless
    // number is recorded and metering finishes, so the two orders below (the
    // same value) cannot classify differently. Cap 100 with a 1000-char string.
    const big = 'x'.repeat(1000)
    expect(checkDoneValue([big, Infinity], 100)).toEqual({ ok: false, reason: 'over-budget' })
    expect(checkDoneValue([Infinity, big], 100)).toEqual({ ok: false, reason: 'over-budget' })
    // A non-lossless number that DOES fit the budget still rejects as
    // non-lossless (the recorded violation is the verdict once the whole value
    // is confirmed within budget).
    expect(checkDoneValue([Infinity], 100)).toEqual({ ok: false, reason: 'non-lossless' })
    // The non-lossless number's OWN encoded bytes still count toward the budget,
    // so a value whose only over-budget contribution is the non-lossless number
    // itself is classified over-budget, not non-lossless. `[Infinity]` encodes
    // as the 10-byte `[Infinity]`; at cap 3 the byte check wins.
    expect(checkDoneValue([Infinity], 3)).toEqual({ ok: false, reason: 'over-budget' })
    expect(checkDoneValue(Infinity, 3)).toEqual({ ok: false, reason: 'over-budget' })
  })

  it('meters and encodes deep nesting iteratively without overflowing the stack', () => {
    let deep: unknown = 0
    for (let i = 0; i < 100_000; i++) deep = [deep]
    // 100000 '[' + '0' + 100000 ']' = 200001 bytes.
    expect(checkDoneValue(deep, 1_000_000)).toEqual({ ok: true, bytes: 200_001 })
    // encodeJsonPlain's headline contract is the same stack-safety (JSON.stringify
    // recurses per level and throws RangeError a few thousand deep), so exercise
    // it on the same 100k-deep value — JSON.stringify would throw here.
    expect(encodeJsonPlain(deep)).toBe(`${'['.repeat(100_000)}0${']'.repeat(100_000)}`)
  })

  it('emits exact digits for beyond-safe integral doubles', () => {
    // String(2**60) prints the ROUNDED ...847000; echoing that to the child
    // would change the integer. BigInt digits give the exact ...846976.
    const v = JSON.parse('[1152921504606846976]') as unknown
    expect(encodeJsonPlain(v)).toBe('[1152921504606846976]')
    expect(checkDoneValue(v, 100)).toEqual({ ok: true, bytes: Buffer.byteLength('[1152921504606846976]', 'utf8') })
  })

  it('walks wide arrays and objects one member at a time', () => {
    // A completion value has a seam byte budget, but the budget alone does not
    // bound the traversal's AUXILIARY state: a wide value near the frame cap
    // (millions of members) must not have every member's reference copied onto
    // a work stack — that O(width) allocation would OOM the host after the
    // parse already succeeded. The walk holds one cursor per nesting level, so
    // a wide value meters exactly and a violation anywhere in it is found
    // wherever it sits.
    const wideArray = new Array(2_000_000).fill(0) as unknown[]
    const arrayJson = `[${wideArray.join(',')}]`
    const arrayExact = Buffer.byteLength(arrayJson, 'utf8')
    expect(checkDoneValue(wideArray, arrayExact)).toEqual({ ok: true, bytes: arrayExact })
    expect(checkDoneValue(wideArray, arrayExact - 1)).toEqual({ ok: false, reason: 'over-budget' })
    // Last element, so the cursor must run the whole breadth lazily to find it.
    wideArray[wideArray.length - 1] = -0
    expect(checkDoneValue(wideArray, arrayExact)).toEqual({ ok: false, reason: 'non-lossless' })
    wideArray[wideArray.length - 1] = 0
    const wideObject: Record<string, unknown> = {}
    for (let i = 0; i < 100_000; i++) wideObject[`k${i}`] = i
    const objectExact = Buffer.byteLength(JSON.stringify(wideObject), 'utf8')
    expect(checkDoneValue(wideObject, objectExact)).toEqual({ ok: true, bytes: objectExact })
    expect(checkDoneValue(wideObject, objectExact - 1)).toEqual({ ok: false, reason: 'over-budget' })
    wideObject.last = -0
    expect(checkDoneValue(wideObject, Buffer.byteLength(JSON.stringify(wideObject), 'utf8'))).toEqual({ ok: false, reason: 'non-lossless' })
  })
})

describe('hostFrameParseCeiling', () => {
  it('caps the parse at the protocol limit on a default heap and lower on a constrained one', () => {
    // The raw-byte frame cap does not protect the host heap: JSON.parse of a
    // wide-object frame materializes several times the raw bytes in property
    // storage, so the effective cap is min(protocol cap, heap-derived
    // ceiling). A default Node heap (~4 GiB) never binds.
    expect(hostFrameParseCeiling(4 * 1024 * 1024 * 1024)).toBe(64 * 1024 * 1024)
    // A constrained host (--max-old-space-size=256 reports a ~304 MiB limit)
    // derives floor((304 - 64) / 16) = 15 MiB: a 50 MiB budget would be
    // rejected at load, where the address-space gate alone would admit it.
    expect(hostFrameParseCeiling(304 * 1024 * 1024)).toBe(15 * 1024 * 1024)
    // A tiny heap leaves almost no parse room — the load gate fails loud.
    expect(hostFrameParseCeiling(128 * 1024 * 1024)).toBe(4 * 1024 * 1024)
  })
})
