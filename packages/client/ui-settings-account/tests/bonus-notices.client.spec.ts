// @vitest-environment jsdom
/**
 * Bonus notice lifecycle: reads happen when the account becomes active and on
 * an explicit refresh, never on a timer. A notice is acknowledged only after its
 * card reports a presented frame, with backoff retry for the rest of the
 * signed-in lifecycle; nothing about a notice survives sign-out or unload.
 */
import { afterEach, expect, it, vi } from 'vitest'
import type { AccountBonusBatch, AccountBonusOrderId, AccountUserId } from '@deepseek-ai/dsh-deepseek-account/types'
import { createBonusNoticeController, type BonusNotice } from '../src/client/bonus-notices.ts'

const TIMING = { ackRetryDelayMs: 1_000, ackRetryMaxDelayMs: 60_000 }

/**
 * @param accountId - owning account.
 * @param orderId - server order.
 * @param expiresAt - server expiration.
 * @returns one unnotified bonus as the Host projects it.
 */
function batch(accountId: string, orderId: string, expiresAt = '2099-01-01T00:00:00Z'): AccountBonusBatch {
  return {
    accountId: accountId as AccountUserId,
    bonuses: [{
      orderId: orderId as AccountBonusOrderId,
      campaign: 'dsh_login_bonus',
      amount: '5.00',
      currency: 'CNY',
      grantedAt: '2026-09-21T12:00:00Z',
      expiresAt,
      message: 'Server copy 5.00',
    }],
  }
}

function setup() {
  const read = vi.fn(async (): Promise<AccountBonusBatch | null> => null)
  const acknowledge = vi.fn(async (): Promise<boolean> => true)
  const published: (BonusNotice | null)[] = []
  const controller = createBonusNoticeController({
    ...TIMING, read, acknowledge, publish: (notice) => { published.push(notice) },
  })
  /** @returns the most recently published notice. */
  const latest = (): BonusNotice | null | undefined => published.at(-1)
  return { controller, read, acknowledge, published, latest }
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

it('reads once when the account becomes active and never on a timer', async () => {
  vi.useFakeTimers()
  const { controller, read } = setup()
  controller.begin()
  await vi.advanceTimersByTimeAsync(0)
  expect(read).toHaveBeenCalledTimes(1)
  // Nothing else schedules a read: only an explicit refresh does.
  await vi.advanceTimersByTimeAsync(TIMING.ackRetryMaxDelayMs)
  expect(read).toHaveBeenCalledTimes(1)
  await controller.refresh()
  await vi.advanceTimersByTimeAsync(0)
  expect(read).toHaveBeenCalledTimes(2)
  controller.end()
})

it('publishes the server copy for the first unnotified order', async () => {
  const { controller, read, latest } = setup()
  read.mockResolvedValue(batch('account-a', 'order-1'))
  controller.begin()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ orderId: 'order-1', message: 'Server copy 5.00' }) })
  controller.end()
})

it('acknowledges only after the card reports a presented frame, then keeps the card until it is closed', async () => {
  const { controller, read, acknowledge, published, latest } = setup()
  read.mockResolvedValue(batch('account-a', 'order-1'))
  controller.begin()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ orderId: 'order-1' }) })
  expect(acknowledge).not.toHaveBeenCalled()
  controller.shown('order-1' as AccountBonusOrderId)
  await vi.waitFor(() => { expect(acknowledge).toHaveBeenCalledWith('account-a', 'order-1') })
  // A refresh still offering the order must not republish the open card.
  const publishedBefore = published.length
  await controller.refresh()
  await vi.waitFor(() => { expect(read).toHaveBeenCalledTimes(2) })
  expect(published.length).toBe(publishedBefore)
  expect(latest()).toMatchObject({ orderId: 'order-1' })
  controller.dismiss('order-1' as AccountBonusOrderId)
  expect(latest()).toBeNull()
  expect(acknowledge).toHaveBeenCalledTimes(1)
  controller.end()
})

it('retries a failed acknowledgement with a growing backoff starting at the configured delay', async () => {
  vi.useFakeTimers()
  const { controller, read, acknowledge } = setup()
  read.mockResolvedValue(batch('account-a', 'order-1'))
  acknowledge.mockRejectedValue(new Error('offline'))
  controller.begin()
  await vi.advanceTimersByTimeAsync(0)
  controller.shown('order-1' as AccountBonusOrderId)
  await vi.advanceTimersByTimeAsync(0)
  expect(acknowledge).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(TIMING.ackRetryDelayMs - 1)
  expect(acknowledge).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(acknowledge).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(TIMING.ackRetryDelayMs * 2)
  expect(acknowledge).toHaveBeenCalledTimes(3)
  controller.end()
})

it('keeps the card and its pending acknowledgement when the signed-in session re-enters', async () => {
  vi.useFakeTimers()
  const { controller, read, acknowledge, latest } = setup()
  read.mockResolvedValue(batch('account-a', 'order-1'))
  acknowledge.mockRejectedValue(new Error('offline'))
  controller.begin()
  await vi.advanceTimersByTimeAsync(0)
  controller.shown('order-1' as AccountBonusOrderId)
  await vi.advanceTimersByTimeAsync(0)
  expect(acknowledge).toHaveBeenCalledTimes(1)
  // The second commit update of one sign-in and a reconnected stream's replayed
  // state both re-enter here. Each frame reads again, and neither may drop the
  // card or stop the failed acknowledgement from backing off.
  controller.begin()
  controller.begin()
  await vi.advanceTimersByTimeAsync(0)
  expect(read).toHaveBeenCalledTimes(3)
  expect(latest()).toMatchObject({ orderId: 'order-1' })
  await vi.advanceTimersByTimeAsync(TIMING.ackRetryDelayMs)
  expect(acknowledge).toHaveBeenCalledTimes(2)
  controller.end()
})

it.each(['aborted', 'null'] as const)("does not adopt the replaced credential's in-flight read when it answers %s", async (answer) => {
  vi.useFakeTimers()
  const { controller, read, acknowledge, latest } = setup()
  read.mockResolvedValue(batch('account-a', 'order-1'))
  acknowledge.mockRejectedValue(new Error('offline'))
  controller.begin()
  await vi.advanceTimersByTimeAsync(0)
  controller.shown('order-1' as AccountBonusOrderId)
  await vi.advanceTimersByTimeAsync(0)
  expect(acknowledge).toHaveBeenCalledTimes(1)
  // Account A's next signed-in frame starts a read the Host abandons when the
  // credential is replaced by B. B's frame must not inherit it: A's answer names
  // the replaced account, so adopting it would leave B with no read of its own.
  const abandoned = Promise.withResolvers<AccountBonusBatch | null>()
  read.mockReturnValueOnce(abandoned.promise)
  controller.begin()
  await vi.advanceTimersByTimeAsync(0)
  read.mockResolvedValueOnce(batch('account-b', 'order-2'))
  controller.begin()
  await vi.advanceTimersByTimeAsync(0)
  expect(read).toHaveBeenCalledTimes(3)
  expect(latest()).toMatchObject({ orderId: 'order-2' })
  if (answer === 'aborted') abandoned.reject(new Error('aborted'))
  else abandoned.resolve(null)
  await vi.advanceTimersByTimeAsync(TIMING.ackRetryMaxDelayMs)
  // The abandoned answer neither restores A's card nor resumes A's retry.
  expect(latest()).toMatchObject({ orderId: 'order-2' })
  expect(acknowledge).toHaveBeenCalledTimes(1)
  controller.end()
})

it('refreshes the copy of the order already on screen when a read offers it again', async () => {
  const { controller, read, latest } = setup()
  read.mockResolvedValue(batch('account-a', 'order-1'))
  controller.begin()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ orderId: 'order-1', message: 'Server copy 5.00' }) })
  // The same order arrives with new copy: its card updates in place instead of being replaced.
  read.mockResolvedValue({ ...batch('account-a', 'order-1'), bonuses: [{ ...batch('account-a', 'order-1').bonuses[0]!, message: 'Updated copy' }] })
  await controller.refresh()
  expect(latest()).toMatchObject({ orderId: 'order-1', message: 'Updated copy' })
  controller.end()
})

it('withdraws a card the user never saw when a read offers no bonus', async () => {
  const { controller, read, latest } = setup()
  read.mockResolvedValue(batch('account-a', 'order-1'))
  controller.begin()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ orderId: 'order-1' }) })
  // The card never reported a presented frame, so an empty read withdraws it.
  read.mockResolvedValue({ accountId: 'account-a' as AccountUserId, bonuses: [] })
  await controller.refresh()
  expect(latest()).toBeNull()
  controller.end()
})

it('queues the next shown order behind a settling acknowledgement', async () => {
  const { controller, read, acknowledge, latest } = setup()
  read.mockResolvedValue(batch('account-a', 'order-1'))
  let settle: ((value: boolean) => void) | undefined
  acknowledge.mockImplementationOnce(() => new Promise<boolean>((resolve) => { settle = resolve }))
  acknowledge.mockResolvedValue(true)
  controller.begin()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ orderId: 'order-1' }) })
  controller.shown('order-1' as AccountBonusOrderId)
  await vi.waitFor(() => { expect(acknowledge).toHaveBeenCalledTimes(1) })
  // A later order replaces the card while the first acknowledgement is still settling.
  read.mockResolvedValue(batch('account-a', 'order-2'))
  await controller.refresh()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ orderId: 'order-2' }) })
  controller.shown('order-2' as AccountBonusOrderId)
  settle?.(true)
  // The settled order clears and the next one follows without a further display.
  await vi.waitFor(() => { expect(acknowledge).toHaveBeenLastCalledWith('account-a', 'order-2') })
  controller.end()
})

it('ignores an acknowledgement pump that fires while one is already in flight', async () => {
  vi.useFakeTimers()
  const { controller, read, acknowledge, latest } = setup()
  read.mockResolvedValue(batch('account-a', 'order-1'))
  let settle: ((value: boolean) => void) | undefined
  acknowledge.mockImplementation(() => new Promise<boolean>((resolve) => { settle = resolve }))
  controller.begin()
  await vi.advanceTimersByTimeAsync(0)
  controller.shown('order-1' as AccountBonusOrderId)
  await vi.advanceTimersByTimeAsync(0)
  expect(acknowledge).toHaveBeenCalledTimes(1)
  // A Settings entry schedules another pump while the first call is unresolved.
  read.mockResolvedValue(batch('account-a', 'order-1'))
  void controller.refresh()
  await vi.advanceTimersByTimeAsync(0)
  expect(acknowledge).toHaveBeenCalledTimes(1)
  settle?.(true)
  await vi.advanceTimersByTimeAsync(0)
  expect(latest()).toMatchObject({ orderId: 'order-1' })
  controller.end()
})

it('stops retrying when the account changes while an acknowledgement is failing', async () => {
  const { controller, read, acknowledge, latest } = setup()
  read.mockResolvedValue(batch('account-a', 'order-1'))
  let fail: ((reason: Error) => void) | undefined
  acknowledge.mockImplementationOnce(() => new Promise<boolean>((_resolve, reject) => { fail = reject }))
  acknowledge.mockResolvedValue(true)
  controller.begin()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ orderId: 'order-1' }) })
  controller.shown('order-1' as AccountBonusOrderId)
  await vi.waitFor(() => { expect(acknowledge).toHaveBeenCalledTimes(1) })
  // Another account answers before account-a's call fails: its failure must not
  // schedule a retry into the new account's queue.
  read.mockResolvedValue(batch('account-b', 'order-2'))
  await controller.refresh()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ orderId: 'order-2' }) })
  fail?.(new Error('offline'))
  await new Promise((resolve) => { setTimeout(resolve, 10) })
  expect(acknowledge).toHaveBeenCalledTimes(1)
  controller.end()
})

it('ignores a dismissal that names an order the card does not show', async () => {
  const { controller, read, acknowledge, latest } = setup()
  read.mockResolvedValue(batch('account-a', 'order-1'))
  controller.begin()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ orderId: 'order-1' }) })
  controller.dismiss('order-2' as AccountBonusOrderId)
  // The other order's dismissal neither withdraws this card nor queues its acknowledgement.
  expect(latest()).toMatchObject({ orderId: 'order-1' })
  expect(acknowledge).not.toHaveBeenCalled()
  controller.end()
})

it('keeps one queued acknowledgement when a reported order returns after another card', async () => {
  const { controller, read, acknowledge, latest } = setup()
  read.mockResolvedValue(batch('account-a', 'order-1'))
  acknowledge.mockRejectedValue(new Error('offline'))
  controller.begin()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ orderId: 'order-1' }) })
  controller.shown('order-1' as AccountBonusOrderId)
  await vi.waitFor(() => { expect(acknowledge).toHaveBeenCalledTimes(1) })
  read.mockResolvedValue(batch('account-a', 'order-2'))
  await controller.refresh()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ orderId: 'order-2' }) })
  read.mockResolvedValue(batch('account-a', 'order-1'))
  await controller.refresh()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ orderId: 'order-1' }) })
  // Its acknowledgement was already queued and is still retrying, so no second entry joins it.
  controller.shown('order-1' as AccountBonusOrderId)
  expect(latest()).toMatchObject({ orderId: 'order-1' })
  controller.end()
})

it('displays an order the server offers again after an earlier sign-in acknowledged it', async () => {
  const first = setup()
  first.read.mockResolvedValue(batch('account-a', 'order-1'))
  first.controller.begin()
  await vi.waitFor(() => { expect(first.latest()).toMatchObject({ orderId: 'order-1' }) })
  first.controller.shown('order-1' as AccountBonusOrderId)
  await vi.waitFor(() => { expect(first.acknowledge).toHaveBeenCalledTimes(1) })
  first.controller.end()
  // Nothing is remembered, so the same order the server still offers displays again.
  const second = setup()
  second.read.mockResolvedValue(batch('account-a', 'order-1'))
  second.controller.begin()
  await vi.waitFor(() => { expect(second.latest()).toMatchObject({ orderId: 'order-1' }) })
  second.controller.end()
})

it('discards the previous account card and retries when a credential is replaced without a signed-out frame', async () => {
  const { controller, read, acknowledge, latest } = setup()
  read.mockResolvedValue(batch('account-a', 'order-1'))
  acknowledge.mockResolvedValue(false)
  controller.begin()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ orderId: 'order-1' }) })
  controller.shown('order-1' as AccountBonusOrderId)
  await vi.waitFor(() => { expect(acknowledge).toHaveBeenCalledOnce() })
  // The credential is replaced in place: another signed-in frame arrives, the read
  // names the other account, and no signed-out frame ever describes the switch.
  read.mockResolvedValue(batch('account-b', 'order-2'))
  controller.begin()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ orderId: 'order-2' }) })
  controller.end()
})

it('keeps the retry going when the re-entry read fails', async () => {
  vi.useFakeTimers()
  const { controller, read, acknowledge, latest } = setup()
  read.mockResolvedValue(batch('account-a', 'order-1'))
  acknowledge.mockRejectedValue(new Error('offline'))
  controller.begin()
  await vi.advanceTimersByTimeAsync(0)
  controller.shown('order-1' as AccountBonusOrderId)
  await vi.advanceTimersByTimeAsync(0)
  expect(acknowledge).toHaveBeenCalledTimes(1)
  // The replayed state re-enters and its read fails; a failed read must leave the
  // pending acknowledgement retrying rather than strand it.
  read.mockRejectedValue(new Error('offline'))
  controller.begin()
  await vi.advanceTimersByTimeAsync(0)
  expect(latest()).toMatchObject({ orderId: 'order-1' })
  await vi.advanceTimersByTimeAsync(TIMING.ackRetryDelayMs)
  expect(acknowledge).toHaveBeenCalledTimes(2)
  controller.end()
})

it('acknowledges a re-offered order once per displayed card', async () => {
  const { controller, read, acknowledge, latest } = setup()
  read.mockResolvedValue(batch('account-a', 'order-1'))
  controller.begin()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ orderId: 'order-1' }) })
  controller.shown('order-1' as AccountBonusOrderId)
  controller.shown('order-1' as AccountBonusOrderId)
  await vi.waitFor(() => { expect(acknowledge).toHaveBeenCalledTimes(1) })
  // Closing the card withdraws it; the next read of the same order is a new card.
  controller.dismiss('order-1' as AccountBonusOrderId)
  await vi.waitFor(() => { expect(acknowledge).toHaveBeenCalledTimes(1) })
  await controller.refresh()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ orderId: 'order-1' }) })
  controller.shown('order-1' as AccountBonusOrderId)
  await vi.waitFor(() => { expect(acknowledge).toHaveBeenCalledTimes(2) })
  controller.end()
})

it('keeps the visible card when a read offers no bonus', async () => {
  const { controller, read, latest } = setup()
  read.mockResolvedValue(batch('account-a', 'order-1'))
  controller.begin()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ orderId: 'order-1' }) })
  // A card the user has already seen keeps its place.
  controller.shown('order-1' as AccountBonusOrderId)
  // A Settings entry whose read returns nothing must not pull the card out from under the user.
  read.mockResolvedValue({ accountId: 'account-a' as AccountUserId, bonuses: [] })
  await controller.refresh()
  expect(latest()).toMatchObject({ orderId: 'order-1' })
  controller.dismiss('order-1' as AccountBonusOrderId)
  await controller.refresh()
  expect(latest()).toBeNull()
  controller.end()
})

it('keeps a pending acknowledgement for the signed-in lifecycle and drops it at sign-out', async () => {
  // Advance the backoff clock explicitly so retry observation has no competing deadline.
  vi.useFakeTimers()
  const { controller, read, acknowledge, latest } = setup()
  acknowledge.mockRejectedValue(new Error('offline'))
  read.mockResolvedValue(batch('account-a', 'order-1'))
  const again = setup()
  try {
    controller.begin()
    await vi.advanceTimersByTimeAsync(0)
    expect(latest()).toMatchObject({ orderId: 'order-1' })
    controller.shown('order-1' as AccountBonusOrderId)
    await vi.advanceTimersByTimeAsync(0)
    expect(acknowledge).toHaveBeenCalledWith('account-a', 'order-1')
    expect(acknowledge).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(TIMING.ackRetryDelayMs)
    expect(acknowledge).toHaveBeenCalledTimes(2)

    // Signing out ends the retry with the lifecycle; the next sign-in starts clean.
    controller.end()
    const callsAtEnd = acknowledge.mock.calls.length
    again.read.mockResolvedValue(batch('account-a', 'order-1'))
    again.controller.begin()
    await vi.advanceTimersByTimeAsync(0)
    expect(again.latest()).toMatchObject({ orderId: 'order-1' })
    // The next sign-in must not inherit the earlier pending acknowledgement.
    expect(again.acknowledge).not.toHaveBeenCalled()
    expect(acknowledge.mock.calls.length).toBe(callsAtEnd)
    // Past the next retry delay: the ended lifecycle scheduled nothing.
    await vi.advanceTimersByTimeAsync(TIMING.ackRetryDelayMs * 3)
    expect(acknowledge.mock.calls.length).toBe(callsAtEnd)
  } finally {
    controller.end()
    again.controller.end()
  }
})

it('ignores an acknowledgement that settles after the lifecycle it belonged to', async () => {
  const { controller, read, acknowledge, latest } = setup()
  read.mockResolvedValue(batch('account-a', 'order-1'))
  let settle: ((value: boolean) => void) | undefined
  acknowledge.mockImplementation(() => new Promise<boolean>((resolve) => { settle = resolve }))
  controller.begin()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ orderId: 'order-1' }) })
  controller.shown('order-1' as AccountBonusOrderId)
  await vi.waitFor(() => { expect(acknowledge).toHaveBeenCalledTimes(1) })
  controller.end()
  // The new sign-in has its own pending queue; the old call settling later must not touch it.
  const next = setup()
  next.read.mockResolvedValue(batch('account-a', 'order-2'))
  next.controller.begin()
  await vi.waitFor(() => { expect(next.latest()).toMatchObject({ orderId: 'order-2' }) })
  next.controller.shown('order-2' as AccountBonusOrderId)
  await vi.waitFor(() => { expect(next.acknowledge).toHaveBeenCalledTimes(1) })
  settle?.(true)
  await new Promise((resolve) => { setTimeout(resolve, 5) })
  expect(next.acknowledge).toHaveBeenCalledTimes(1)
  expect(next.latest()).toMatchObject({ orderId: 'order-2' })
  next.controller.end()
})

it('does not let an in-flight acknowledgement of one account clear another account\'s queue', async () => {
  const { controller, read, acknowledge, latest } = setup()
  read.mockResolvedValue(batch('account-a', 'order-1'))
  let settleA: ((value: boolean) => void) | undefined
  acknowledge.mockImplementationOnce(() => new Promise<boolean>((resolve) => { settleA = resolve }))
  acknowledge.mockResolvedValue(true)
  controller.begin()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ orderId: 'order-1' }) })
  controller.shown('order-1' as AccountBonusOrderId)
  await vi.waitFor(() => { expect(acknowledge).toHaveBeenCalledWith('account-a', 'order-1') })
  // Another account answers the same lifecycle before account-a's call settles.
  read.mockResolvedValue(batch('account-b', 'order-2'))
  await controller.refresh()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ orderId: 'order-2' }) })
  settleA?.(true)
  await new Promise((resolve) => { setTimeout(resolve, 5) })
  // The stale answer settled account-a's order, not account-b's retry.
  expect(acknowledge).toHaveBeenCalledTimes(1)
  controller.shown('order-2' as AccountBonusOrderId)
  await vi.waitFor(() => { expect(acknowledge).toHaveBeenLastCalledWith('account-b', 'order-2') })
  controller.end()
})

it('restarts the retry delay after a lifecycle ends', async () => {
  vi.useFakeTimers()
  const { controller, read, acknowledge } = setup()
  read.mockResolvedValue(batch('account-a', 'order-1'))
  acknowledge.mockRejectedValue(new Error('offline'))
  controller.begin()
  await vi.advanceTimersByTimeAsync(0)
  controller.shown('order-1' as AccountBonusOrderId)
  await vi.advanceTimersByTimeAsync(TIMING.ackRetryDelayMs * 3)
  expect(acknowledge.mock.calls.length).toBeGreaterThan(2)
  controller.end()
  // The next lifecycle starts from the configured delay, not the previous backoff.
  const next = setup()
  next.read.mockResolvedValue(batch('account-a', 'order-2'))
  next.acknowledge.mockRejectedValue(new Error('offline'))
  next.controller.begin()
  await vi.advanceTimersByTimeAsync(0)
  next.controller.shown('order-2' as AccountBonusOrderId)
  await vi.advanceTimersByTimeAsync(0)
  expect(next.acknowledge).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(TIMING.ackRetryDelayMs - 1)
  expect(next.acknowledge).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(next.acknowledge).toHaveBeenCalledTimes(2)
  next.controller.end()
})

it('withdraws the displayed card when the signed-in account changes', async () => {
  const { controller, read, latest } = setup()
  read.mockResolvedValue(batch('account-a', 'order-1'))
  controller.begin()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ orderId: 'order-1' }) })
  read.mockResolvedValue(batch('account-b', 'order-2'))
  await controller.refresh()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ orderId: 'order-2' }) })
  controller.end()
})

it('never acknowledges after the plugin unloads', async () => {
  vi.useFakeTimers()
  const { controller, read, acknowledge } = setup()
  read.mockResolvedValue(batch('account-a', 'order-1'))
  controller.begin()
  await vi.advanceTimersByTimeAsync(0)
  controller.end()
  controller.shown('order-1' as AccountBonusOrderId)
  await vi.advanceTimersByTimeAsync(TIMING.ackRetryMaxDelayMs)
  expect(acknowledge).not.toHaveBeenCalled()
})

it('suppresses a bonus that expired before its first presented frame', async () => {
  const { controller, read, latest } = setup()
  read.mockResolvedValue(batch('account-a', 'order-1', '2000-01-01T00:00:00Z'))
  controller.begin()
  await vi.waitFor(() => { expect(read).toHaveBeenCalledTimes(1) })
  expect(latest()).toBeUndefined()
  controller.end()
})

it('does not record a display when the award expired before the card could render', async () => {
  const { controller, read, acknowledge, latest } = setup()
  read.mockResolvedValue(batch('account-a', 'order-1'))
  controller.begin()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ orderId: 'order-1' }) })
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2100-01-01T00:00:00Z'))
  // The card refuses to render an expired award, so no display is reported.
  controller.shown('order-1' as AccountBonusOrderId)
  expect(acknowledge).not.toHaveBeenCalled()
  controller.end()
})
