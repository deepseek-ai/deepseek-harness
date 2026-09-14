import { describe, expect, it } from 'vitest'
import { detachResidual } from '../src/index.ts'

describe('detachResidual — fd-3 residual detachment', () => {
  it('returns a copy that does NOT share the source frame allocation', () => {
    // Simulate the data handler's state: one large joined frame from
    // Buffer.concat, sliced past its newline to leave a small residual VIEW.
    // The fixture MUST stay larger than Node's Buffer pool threshold
    // (`Buffer.poolSize / 2`, 4 KiB): above it `Buffer.from` allocates a
    // dedicated backing store whose `byteLength` equals the copy's length,
    // which is what the byteLength assertion below pins. A smaller residual
    // would be pooled into an 8 KiB shared ArrayBuffer, making `byteLength`
    // report 8192 and the assertion false-fail even though the fix is intact.
    const joined = Buffer.alloc(1024 * 1024, 0x61) // 1 MiB backing allocation
    joined[512] = 0x0a // a newline partway through
    const residual = joined.subarray(513) // a view onto `joined`'s backing store

    // Before the fix the handler carried this view forward verbatim, pinning the
    // whole 1 MiB `joined` allocation behind a residual that reports far fewer
    // bytes. A right-sized copy must not point back into `joined`.
    const [carried] = detachResidual(residual)

    expect(carried).toBeDefined()
    expect(carried!.length).toBe(residual.length)
    expect(carried!.equals(residual)).toBe(true)
    // The core invariant: the copy does NOT share the source frame's backing
    // store, so retaining it cannot pin the 1 MiB allocation.
    expect(carried!.buffer).not.toBe(joined.buffer)
    // And the copy's own backing store is sized to its content — not the whole
    // frame. Holds because the fixture exceeds the pool threshold (see above);
    // a subarray view would report the source's full byteLength here.
    expect(carried!.buffer.byteLength).toBe(carried!.length)
  })

  it('carries nothing forward for an empty residual', () => {
    expect(detachResidual(Buffer.alloc(0))).toEqual([])
  })
})
