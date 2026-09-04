/** Event-level policy tests; no filesystem provider is needed because the plugin performs no I/O. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsObservation, FsTarget, FsWriteIntent } from '@deepseek-ai/dsh-fs'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import type { FsObservationActor } from '@deepseek-ai/dsh-fs-observation-policy'

function target(path: string): FsTarget {
  return { targetKey: FsTargetKey(path), displayPath: path }
}
const ownerExec = (session: object): FsObservationActor => ({ agent: { session } })
const present = (version: string): FsObservation => ({ kind: 'present', version: FsVersion(version) })
const absent: FsObservation = { kind: 'absent' }

/** Dispatch the write-intent waterfall with the bare default thunk. */
function writeIntent(ctx: Context, t: FsTarget, actor: object | undefined): Promise<FsWriteIntent | undefined> {
  return ctx.waterfall('fs/write-intent', t, actor, () => undefined)
}
/** Dispatch the edit-intent waterfall with the bare default thunk. */
function editIntent(ctx: Context, t: FsTarget, actor: object | undefined): Promise<{ version: FsVersion } | undefined> {
  return ctx.waterfall('fs/edit-intent', t, actor, () => undefined)
}

async function setup() {
  const ctx = new Context()
  const fiber = await ctx.plugin(FsPolicy)
  return { ctx, fiber }
}

describe('registration / disposal', () => {
  it('registers no service API (it is a plugin, not ctx.fsPolicy)', async () => {
    const { ctx } = await setup()
    expect((ctx as Context & { fsPolicy?: unknown }).fsPolicy).toBeUndefined()
  })

  it('mounts with no inject (reads no services)', async () => {
    // It mounts immediately even with nothing else in the context.
    const ctx = new Context()
    await ctx.plugin(FsPolicy)
    // The listener is live: an unobserved write decides createIfAbsent.
    expect(await writeIntent(ctx, target('a.txt'), undefined)).toEqual({ kind: 'createIfAbsent' })
  })
})

describe('write-intent decision', () => {
  it('an unobserved target decides createIfAbsent', async () => {
    const { ctx } = await setup()
    expect(await writeIntent(ctx, target('a.txt'), ownerExec({}))).toEqual({ kind: 'createIfAbsent' })
  })

  it('a no-owner actor decides createIfAbsent', async () => {
    const { ctx } = await setup()
    expect(await writeIntent(ctx, target('a.txt'), undefined)).toEqual({ kind: 'createIfAbsent' })
    expect(await writeIntent(ctx, target('a.txt'), {})).toEqual({ kind: 'createIfAbsent' })
  })

  it('an actor with an agent but no session has no owner (createIfAbsent)', async () => {
    // The middle optional-chain rung: agent present, session undefined ⇒ owner
    // undefined ⇒ unobservable, so a write can only be a blind create.
    const { ctx } = await setup()
    expect(await writeIntent(ctx, target('a.txt'), { agent: {} })).toEqual({ kind: 'createIfAbsent' })
  })

  it('an observed target decides replaceIfVersion at the observed version', async () => {
    const { ctx } = await setup()
    const exec = ownerExec({})
    ctx.emit('fs/observed', target('a.txt'), present('v7'), exec)
    expect(await writeIntent(ctx, target('a.txt'), exec)).toEqual({ kind: 'replaceIfVersion', version: 'v7' })
  })

  it('a target observed absent decides createIfAbsent', async () => {
    const { ctx } = await setup()
    const exec = ownerExec({})
    ctx.emit('fs/observed', target('a.txt'), absent, exec)
    expect(await writeIntent(ctx, target('a.txt'), exec)).toEqual({ kind: 'createIfAbsent' })
  })
})

describe('edit-intent decision', () => {
  it('rejects an unread edit with FS_NOT_OBSERVED', async () => {
    const { ctx } = await setup()
    await expect(editIntent(ctx, target('a.txt'), ownerExec({}))).rejects.toMatchObject({
      code: 'FS_NOT_OBSERVED',
      message: 'edit requires reading "a.txt" first',
    })
  })

  it('rejects an edit with no owner (cannot prove prior observation)', async () => {
    const { ctx } = await setup()
    await expect(editIntent(ctx, target('a.txt'), undefined)).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
  })

  it('rejects an edit whose actor has an agent but no session (no owner)', async () => {
    const { ctx } = await setup()
    await expect(editIntent(ctx, target('a.txt'), { agent: {} })).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
  })

  it('returns the observed version as the CAS basis after an observation', async () => {
    const { ctx } = await setup()
    const exec = ownerExec({})
    ctx.emit('fs/observed', target('a.txt'), present('v3'), exec)
    expect(await editIntent(ctx, target('a.txt'), exec)).toEqual({ version: 'v3' })
  })

  it('rejects editing a target observed absent with FS_NOT_FOUND', async () => {
    const { ctx } = await setup()
    const exec = ownerExec({})
    ctx.emit('fs/observed', target('a.txt'), absent, exec)
    await expect(editIntent(ctx, target('a.txt'), exec)).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })
})

describe('observed-state is the prior-observation record', () => {
  it('a read observation authorizes an in-place write at that version', async () => {
    const { ctx } = await setup()
    const exec = ownerExec({})
    ctx.emit('fs/observed', target('a.txt'), present('v0'), exec) // a read
    expect(await writeIntent(ctx, target('a.txt'), exec)).toEqual({ kind: 'replaceIfVersion', version: 'v0' })
  })

  it('a write/edit observation refreshes the basis, so the next edit needs no re-read', async () => {
    const { ctx } = await setup()
    const exec = ownerExec({})
    // A create records v1; the follow-up edit guards against v1 with no read.
    ctx.emit('fs/observed', target('a.txt'), present('v1'), exec)
    expect(await editIntent(ctx, target('a.txt'), exec)).toEqual({ version: 'v1' })
    // The edit records v2; a second edit guards against v2.
    ctx.emit('fs/observed', target('a.txt'), present('v2'), exec)
    expect(await editIntent(ctx, target('a.txt'), exec)).toEqual({ version: 'v2' })
  })

  it('a no-owner observation records nothing', async () => {
    const { ctx } = await setup()
    ctx.emit('fs/observed', target('a.txt'), present('v0'), undefined)
    // Still unobserved for any owner.
    await expect(editIntent(ctx, target('a.txt'), ownerExec({}))).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
  })

  it('supports present → absent → present transitions for one owner', async () => {
    const { ctx } = await setup()
    const exec = ownerExec({})
    const a = target('a.txt')
    ctx.emit('fs/observed', a, present('v1'), exec)
    expect(await writeIntent(ctx, a, exec)).toEqual({ kind: 'replaceIfVersion', version: 'v1' })

    ctx.emit('fs/observed', a, absent, exec)
    expect(await writeIntent(ctx, a, exec)).toEqual({ kind: 'createIfAbsent' })
    await expect(editIntent(ctx, a, exec)).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })

    ctx.emit('fs/observed', a, present('v2'), exec)
    expect(await editIntent(ctx, a, exec)).toEqual({ version: 'v2' })
  })
})

describe('multi-owner isolation', () => {
  it('owner A observing does not grant owner B edit authority', async () => {
    const { ctx } = await setup()
    const a = ownerExec({})
    const b = ownerExec({})
    ctx.emit('fs/observed', target('a.txt'), present('v0'), a)
    await expect(editIntent(ctx, target('a.txt'), b)).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
    expect(await editIntent(ctx, target('a.txt'), a)).toEqual({ version: 'v0' })
  })

  it('each owner records its own observed version independently', async () => {
    const { ctx } = await setup()
    const a = ownerExec({})
    const b = ownerExec({})
    ctx.emit('fs/observed', target('a.txt'), present('v0'), a) // A observed v0
    // B never observed → createIfAbsent; A still holds v0 → replaceIfVersion.
    expect(await writeIntent(ctx, target('a.txt'), b)).toEqual({ kind: 'createIfAbsent' })
    expect(await writeIntent(ctx, target('a.txt'), a)).toEqual({ kind: 'replaceIfVersion', version: 'v0' })
  })
})

describe('single-slot, first-wins', () => {
  it('fully decides the slot without calling next() (the bare default is unreached)', async () => {
    const { ctx } = await setup()
    let defaultRan = false
    const intent = await ctx.waterfall('fs/write-intent', target('a.txt'), ownerExec({}), () => {
      defaultRan = true
      return undefined
    })
    expect(intent).toEqual({ kind: 'createIfAbsent' })
    expect(defaultRan).toBe(false)
  })

  it('a SECOND decider registered AFTER fs-observation-policy is not reached (first-wins short-circuit)', async () => {
    const { ctx } = await setup()
    let secondRan = false
    // Registered after fs-observation-policy, so it dispatches second; fs-observation-policy does
    // not call next(), so this never runs. (A decider registered BEFORE — or with
    // prepend — would instead win: first-wins is by convention, not enforced.)
    ctx.on('fs/edit-intent', () => {
      secondRan = true
      return Promise.resolve(undefined)
    })
    const exec = ownerExec({})
    ctx.emit('fs/observed', target('a.txt'), present('v0'), exec)
    await editIntent(ctx, target('a.txt'), exec)
    expect(secondRan).toBe(false)
  })

  it('a SECOND write-intent decider registered AFTER fs-observation-policy is not reached', async () => {
    const { ctx } = await setup()
    let secondRan = false
    ctx.on('fs/write-intent', () => {
      secondRan = true
      return Promise.resolve(undefined)
    })
    await writeIntent(ctx, target('a.txt'), ownerExec({}))
    expect(secondRan).toBe(false)
  })
})

describe('disposal releases recorded state (HMR safety)', () => {
  it('a fresh plugin after disposal starts with no inherited state', async () => {
    const ctx = new Context()
    const exec = ownerExec({})
    const fiber = await ctx.plugin(FsPolicy)
    ctx.emit('fs/observed', target('a.txt'), present('v0'), exec)
    expect(await editIntent(ctx, target('a.txt'), exec)).toEqual({ version: 'v0' })
    await fiber.dispose()

    await ctx.plugin(FsPolicy)
    // Same owner object, but state was released on disposal.
    await expect(editIntent(ctx, target('a.txt'), exec)).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
  })

  it('no listeners remain after disposal (the gate no longer decides)', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(FsPolicy)
    await fiber.dispose()
    // With no listener, the waterfall falls through to the bare default.
    expect(await writeIntent(ctx, target('a.txt'), ownerExec({}))).toBeUndefined()
  })
})
