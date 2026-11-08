// @vitest-environment jsdom
/**
 * Notification lifecycle: account activation and Settings entry replace polling
 * with an immediate query. Display reports follow a presented frame.
 * Each event is attempted once; nothing
 * about a notice survives sign-out or unload.
 */
import { afterEach, expect, it, vi } from 'vitest'
import type { AccountNotificationBatch, AccountNotificationId } from '@deepseek-ai/dsh-deepseek-account/types'
import { createNotificationController, type AccountNotice, type NotificationController } from '../src/client/notification-controller.ts'
import { notification } from './notification-fixture.ts'

const TIMING = { pollIntervalMs: 600_000 }
const controllers = new Set<NotificationController>()

/**
 * @param id - notification identifier.
 * @param displayUntil - server expiration.
 * @returns one unconsumed notification as the Host projects it.
 */
function batch(id: string, displayUntil: string | null = '2099-01-01T00:00:00Z'): AccountNotificationBatch {
  return {
    nextPollAfterSeconds: TIMING.pollIntervalMs / 1_000,
    notifications: [notification(id, { displayUntil })],
  }
}

function setup() {
  const read = vi.fn(async (): Promise<AccountNotificationBatch | null> => null)
  const readContent = vi.fn(async (): Promise<AccountNotice | null> => null)
  const displayed = vi.fn(async (_id: AccountNotificationId): Promise<boolean> => true)
  const dismissed = vi.fn(async (_id: AccountNotificationId): Promise<boolean> => true)
  const clicked = vi.fn(async (_id: AccountNotificationId): Promise<boolean> => true)
  const stacks: (readonly AccountNotice[])[] = []
  const published: (AccountNotice | null)[] = []
  const controller = createNotificationController({
    ...TIMING, locale: 'en', read, readContent,
    reportEvent: (id, event) => ({ displayed: displayed, cta_clicked: clicked, dismissed })[event](id),
    publish: (notices) => { stacks.push(notices); published.push(notices[0] ?? null) },
  })
  controllers.add(controller)
  /** @returns the most recently published notice. */
  const latest = (): AccountNotice | null | undefined => published.at(-1)
  return { controller, read, readContent, displayed, clicked, dismissed, published, latest, stacks }
}

afterEach(() => {
  for (const controller of controllers) controller.end()
  controllers.clear()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('reads immediately and starts the next delay only after the current request settles', async () => {
  vi.useFakeTimers()
  const { controller, read } = setup()
  let finish!: (value: AccountNotificationBatch | null) => void
  read.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
  controller.begin()
  expect(read).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(TIMING.pollIntervalMs * 3)
  expect(read).toHaveBeenCalledTimes(1)
  finish(null)
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(TIMING.pollIntervalMs - 1)
  expect(read).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(read).toHaveBeenCalledTimes(2)
  controller.end()
})

it.each(['begin', 'refresh'] as const)('restarts polling immediately on %s and cancels the previous delay', async (trigger) => {
  vi.useFakeTimers()
  const { controller, read } = setup()
  controller.begin()
  await vi.advanceTimersByTimeAsync(TIMING.pollIntervalMs / 2)
  if (trigger === 'begin') controller.begin()
  else await controller.refresh()
  expect(read).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(TIMING.pollIntervalMs / 2)
  expect(read).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(TIMING.pollIntervalMs / 2)
  expect(read).toHaveBeenCalledTimes(3)
  controller.end()
  await vi.advanceTimersByTimeAsync(TIMING.pollIntervalMs * 2)
  expect(read).toHaveBeenCalledTimes(3)
})

it('discards a superseded request without publishing or resuming its poll', async () => {
  vi.useFakeTimers()
  const { controller, read, latest } = setup()
  let finish!: (value: AccountNotificationBatch | null) => void
  read.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
  read.mockResolvedValue(batch('new'))
  controller.begin()
  await controller.refresh()
  await vi.advanceTimersByTimeAsync(TIMING.pollIntervalMs / 2)
  finish(batch('old'))
  await vi.advanceTimersByTimeAsync(0)
  expect(latest()?.id).toBe('new')
  await vi.advanceTimersByTimeAsync(TIMING.pollIntervalMs / 2)
  expect(read).toHaveBeenCalledTimes(3)
  await vi.advanceTimersByTimeAsync(TIMING.pollIntervalMs / 2)
  expect(read).toHaveBeenCalledTimes(3)
})

it('does not report or reschedule an obsolete request failure', async () => {
  vi.useFakeTimers()
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const { controller, read } = setup()
  let reject!: (error: Error) => void
  read.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail }))
  controller.begin()
  controller.end()
  reject(new Error('offline'))
  await vi.advanceTimersByTimeAsync(TIMING.pollIntervalMs * 2)
  expect(read).toHaveBeenCalledTimes(1)
  expect(log).not.toHaveBeenCalled()
})

it('does not resume polling after sign-out while a list reply is refreshing language content', async () => {
  vi.useFakeTimers()
  const { controller, read, readContent, latest } = setup()
  const response = Promise.withResolvers<AccountNotificationBatch | null>()
  const content = Promise.withResolvers<AccountNotice | null>()
  read.mockReturnValueOnce(response.promise)
  readContent.mockReturnValueOnce(content.promise)
  controller.begin()
  await controller.setLocale('zh')
  response.resolve(batch('first'))
  await vi.advanceTimersByTimeAsync(0)
  expect(readContent).toHaveBeenCalledWith('first', 'zh')
  controller.end()
  content.resolve(notification('first'))
  await vi.advanceTimersByTimeAsync(TIMING.pollIntervalMs * 2)
  expect(latest()).toBeNull()
  expect(read).toHaveBeenCalledOnce()
})

it('retains the shown card on failure and polls again after the configured delay', async () => {
  vi.useFakeTimers()
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const { controller, read, latest, displayed } = setup()
  read.mockResolvedValueOnce(batch('first')).mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(batch('second'))
  controller.begin()
  await vi.advanceTimersByTimeAsync(0)
  controller.shown('first' as AccountNotificationId)
  await vi.advanceTimersByTimeAsync(TIMING.pollIntervalMs)
  expect(latest()?.id).toBe('first')
  expect(log).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(TIMING.pollIntervalMs)
  expect(read).toHaveBeenCalledTimes(3)
  expect(latest()?.id).toBe('first')
  expect(displayed).toHaveBeenCalledOnce()
})

it('uses each server delay in seconds, retains it after failure, and resets it when polling restarts', async () => {
  vi.useFakeTimers()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const { controller, read } = setup()
  read.mockResolvedValueOnce({ ...batch('first'), notifications: [], nextPollAfterSeconds: 2 })
    .mockResolvedValueOnce({ ...batch('first'), notifications: [], nextPollAfterSeconds: 5 })
    .mockRejectedValueOnce(new Error('offline'))
  controller.begin()
  await vi.advanceTimersByTimeAsync(1_999)
  expect(read).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(1)
  expect(read).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(4_999)
  expect(read).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1)
  expect(read).toHaveBeenCalledTimes(3)
  await vi.advanceTimersByTimeAsync(4_999)
  expect(read).toHaveBeenCalledTimes(3)
  await vi.advanceTimersByTimeAsync(1)
  expect(read).toHaveBeenCalledTimes(4)
  await controller.refresh()
  expect(read).toHaveBeenCalledTimes(5)
  await vi.advanceTimersByTimeAsync(TIMING.pollIntervalMs - 1)
  expect(read).toHaveBeenCalledTimes(5)
  await vi.advanceTimersByTimeAsync(1)
  expect(read).toHaveBeenCalledTimes(6)
})

it('publishes the server copy for the first unconsumed notification', async () => {
  const { controller, read, latest } = setup()
  read.mockResolvedValue(batch('notice-1'))
  controller.begin()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ id: 'notice-1', body: 'Server copy 5.00' }) })
  controller.end()
})

it('reports display only after a presented frame and keeps the card until it is closed', async () => {
  const { controller, read, displayed, published, latest } = setup()
  read.mockResolvedValue(batch('notice-1'))
  controller.begin()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ id: 'notice-1' }) })
  expect(displayed).not.toHaveBeenCalled()
  controller.shown('notice-1' as AccountNotificationId)
  await vi.waitFor(() => { expect(displayed).toHaveBeenCalledWith('notice-1') })
  // A refresh still offering the notification must not republish the open card.
  const publishedBefore = published.length
  await controller.refresh()
  await vi.waitFor(() => { expect(read).toHaveBeenCalledTimes(2) })
  expect(published.length).toBe(publishedBefore)
  expect(latest()).toMatchObject({ id: 'notice-1' })
  controller.dismiss('notice-1' as AccountNotificationId)
  expect(latest()).toBeNull()
  expect(displayed).toHaveBeenCalledTimes(1)
  controller.end()
})

it.each(['aborted', 'null'] as const)("does not adopt the replaced credential's in-flight read when it answers %s", async (answer) => {
  vi.useFakeTimers()
  const { controller, read, displayed, latest } = setup()
  read.mockResolvedValue(batch('notice-1'))
  displayed.mockRejectedValue(new Error('offline'))
  controller.begin()
  await vi.advanceTimersByTimeAsync(0)
  controller.shown('notice-1' as AccountNotificationId)
  await vi.advanceTimersByTimeAsync(0)
  expect(displayed).toHaveBeenCalledTimes(1)
  // Account A's next signed-in frame starts a read the Host abandons when the
  // credential is replaced by B. B's frame must not inherit it: A's answer names
  // the replaced account, so adopting it would leave B with no read of its own.
  const abandoned = Promise.withResolvers<AccountNotificationBatch | null>()
  read.mockReturnValueOnce(abandoned.promise)
  controller.begin()
  await vi.advanceTimersByTimeAsync(0)
  controller.end()
  read.mockResolvedValue(batch('notice-2'))
  controller.begin()
  await Promise.resolve()
  expect(read).toHaveBeenCalledTimes(3)
  expect(latest()).toMatchObject({ id: 'notice-2' })
  if (answer === 'aborted') abandoned.reject(new Error('aborted'))
  else abandoned.resolve(null)
  await vi.advanceTimersByTimeAsync(TIMING.pollIntervalMs)
  // The abandoned answer cannot restore the previous account's card.
  expect(latest()).toMatchObject({ id: 'notice-2' })
  expect(displayed).toHaveBeenCalledTimes(1)
  controller.end()
})

it('refreshes the copy of the notification already on screen when a read offers it again', async () => {
  const { controller, read, latest } = setup()
  read.mockResolvedValue(batch('notice-1'))
  controller.begin()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ id: 'notice-1', body: 'Server copy 5.00' }) })
  // The same notification arrives with new copy: its card updates in place instead of being replaced.
  read.mockResolvedValue({ ...batch('notice-1'), notifications: [{ ...batch('notice-1').notifications[0]!, title: 'Updated title', body: 'Updated copy' }] })
  await controller.refresh()
  expect(latest()).toMatchObject({ id: 'notice-1', title: 'Updated title', body: 'Updated copy' })
  controller.end()
})

it('withdraws a card the user never saw when a read offers no notification', async () => {
  const { controller, read, latest } = setup()
  read.mockResolvedValue(batch('notice-1'))
  controller.begin()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ id: 'notice-1' }) })
  // The card never reported a presented frame, so an empty read withdraws it.
  read.mockResolvedValue({ nextPollAfterSeconds: TIMING.pollIntervalMs / 1_000, notifications: [] })
  await controller.refresh()
  expect(latest()).toBeNull()
  controller.end()
})

it.each(['omitted', 'reordered'] as const)('keeps the displayed card in front when the next read leaves it %s', async (placement) => {
  vi.useFakeTimers()
  const { controller, read, displayed, stacks } = setup()
  try {
    read.mockResolvedValue(batch('first', null))
    controller.begin()
    await vi.advanceTimersByTimeAsync(0)
    controller.shown('first' as AccountNotificationId)
    await vi.advanceTimersByTimeAsync(0)
    const next = ['second', 'third'].flatMap(id => batch(id, null).notifications)
    read.mockResolvedValue({ nextPollAfterSeconds: TIMING.pollIntervalMs / 1_000,
      notifications: placement === 'reordered' ? [...next, ...batch('first', null).notifications] : next })
    await controller.refresh()
    expect(stacks.at(-1)?.map(notice => notice.id)).toEqual(['first', 'second', 'third'])
    controller.shown('first' as AccountNotificationId)
    await vi.advanceTimersByTimeAsync(0)
    expect(displayed).toHaveBeenCalledExactlyOnceWith('first')
    controller.dismiss('first' as AccountNotificationId)
    expect(stacks.at(-1)?.map(notice => notice.id)).toEqual(['second', 'third'])
    controller.shown('second' as AccountNotificationId)
    await vi.advanceTimersByTimeAsync(0)
    expect(displayed).toHaveBeenCalledTimes(2)
    expect(displayed).toHaveBeenLastCalledWith('second')
  } finally {
    controller.end()
  }
})

it.each(['elapsed', 'updated'] as const)('removes a displayed card whose expiration %s before the next read', async (expiration) => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-27T00:00:00Z'))
  const { controller, read, stacks } = setup()
  try {
    read.mockResolvedValue(batch('first', '2026-10-28T00:00:00Z'))
    controller.begin()
    await vi.advanceTimersByTimeAsync(0)
    controller.shown('first' as AccountNotificationId)
    await vi.advanceTimersByTimeAsync(0)
    if (expiration === 'elapsed') vi.setSystemTime(new Date('2026-10-28T00:00:00Z'))
    read.mockResolvedValue({ nextPollAfterSeconds: TIMING.pollIntervalMs / 1_000, notifications: [
      ...expiration === 'updated' ? batch('first', '2026-10-27T00:00:00Z').notifications : [],
      ...batch('second', null).notifications,
    ] })
    await controller.refresh()
    expect(stacks.at(-1)?.map(notice => notice.id)).toEqual(['second'])
  } finally {
    controller.end()
  }
})

it('ignores a dismissal that names a notification the card does not show', async () => {
  const { controller, read, displayed, latest } = setup()
  read.mockResolvedValue(batch('notice-1'))
  controller.begin()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ id: 'notice-1' }) })
  controller.dismiss('notice-2' as AccountNotificationId)
  // The other notification's dismissal neither withdraws this card nor reports its display.
  expect(latest()).toMatchObject({ id: 'notice-1' })
  expect(displayed).not.toHaveBeenCalled()
  controller.end()
})

it('displays a notification offered again after a previous sign-in reported it', async () => {
  const first = setup()
  first.read.mockResolvedValue(batch('notice-1'))
  first.controller.begin()
  await vi.waitFor(() => { expect(first.latest()).toMatchObject({ id: 'notice-1' }) })
  first.controller.shown('notice-1' as AccountNotificationId)
  await vi.waitFor(() => { expect(first.displayed).toHaveBeenCalledTimes(1) })
  first.controller.end()
  // Nothing is remembered, so the same notification the server still offers displays again.
  const second = setup()
  second.read.mockResolvedValue(batch('notice-1'))
  second.controller.begin()
  await vi.waitFor(() => { expect(second.latest()).toMatchObject({ id: 'notice-1' }) })
  second.controller.end()
})

it('discards the previous account card when a credential is replaced without a signed-out frame', async () => {
  const { controller, read, displayed, latest } = setup()
  read.mockResolvedValue(batch('notice-1'))
  displayed.mockResolvedValue(false)
  controller.begin()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ id: 'notice-1' }) })
  controller.shown('notice-1' as AccountNotificationId)
  await vi.waitFor(() => { expect(displayed).toHaveBeenCalledOnce() })
  // The credential is replaced in place: another signed-in frame arrives, the read
  // names the other account, and no signed-out frame ever describes the switch.
  controller.end()
  read.mockResolvedValue(batch('notice-2'))
  controller.begin()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ id: 'notice-2' }) })
  controller.end()
})

it('reports each new display of a notification offered again after dismissal', async () => {
  const { controller, read, displayed, latest } = setup()
  read.mockResolvedValue(batch('notice-1'))
  controller.begin()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ id: 'notice-1' }) })
  controller.shown('notice-1' as AccountNotificationId)
  controller.shown('notice-1' as AccountNotificationId)
  await vi.waitFor(() => { expect(displayed).toHaveBeenCalledTimes(1) })
  // Closing the card withdraws it; the next read of the same notification is a new card.
  controller.dismiss('notice-1' as AccountNotificationId)
  await vi.waitFor(() => { expect(displayed).toHaveBeenCalledTimes(1) })
  await controller.refresh()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ id: 'notice-1' }) })
  controller.shown('notice-1' as AccountNotificationId)
  await vi.waitFor(() => { expect(displayed).toHaveBeenCalledTimes(2) })
  controller.end()
})

it('keeps the visible card when a read offers no notification', async () => {
  const { controller, read, latest } = setup()
  read.mockResolvedValue(batch('notice-1'))
  controller.begin()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ id: 'notice-1' }) })
  // A card the user has already seen keeps its place.
  controller.shown('notice-1' as AccountNotificationId)
  // A Settings entry whose read returns nothing must not pull the card out from under the user.
  read.mockResolvedValue({ nextPollAfterSeconds: TIMING.pollIntervalMs / 1_000, notifications: [] })
  await controller.refresh()
  expect(latest()).toMatchObject({ id: 'notice-1' })
  controller.dismiss('notice-1' as AccountNotificationId)
  await controller.refresh()
  expect(latest()).toBeNull()
  controller.end()
})

it('withdraws the displayed card when the signed-in account changes', async () => {
  const { controller, read, latest } = setup()
  read.mockResolvedValue(batch('notice-1'))
  controller.begin()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ id: 'notice-1' }) })
  controller.end()
  read.mockResolvedValue(batch('notice-2'))
  controller.begin()
  await Promise.resolve()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ id: 'notice-2' }) })
  controller.end()
})

it('never reports display after the plugin unloads', async () => {
  vi.useFakeTimers()
  const { controller, read, displayed } = setup()
  read.mockResolvedValue(batch('notice-1'))
  controller.begin()
  await vi.advanceTimersByTimeAsync(0)
  controller.end()
  controller.shown('notice-1' as AccountNotificationId)
  await vi.advanceTimersByTimeAsync(TIMING.pollIntervalMs)
  expect(displayed).not.toHaveBeenCalled()
})

it('suppresses a notification that expired before its first presented frame', async () => {
  const { controller, read, latest } = setup()
  read.mockResolvedValue(batch('notice-1', '2000-01-01T00:00:00Z'))
  controller.begin()
  await vi.waitFor(() => { expect(read).toHaveBeenCalledTimes(1) })
  expect(latest()).toBeUndefined()
  controller.end()
})

it('does not record a display when the award expired before the card could render', async () => {
  const { controller, read, displayed, latest } = setup()
  read.mockResolvedValue(batch('notice-1'))
  controller.begin()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ id: 'notice-1' }) })
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2100-01-01T00:00:00Z'))
  // The card refuses to render an expired award, so no display is reported.
  controller.shown('notice-1' as AccountNotificationId)
  expect(displayed).not.toHaveBeenCalled()
  controller.end()
})

it('displays and reports a notice without expiration', async () => {
  const { controller, read, displayed, latest } = setup()
  read.mockResolvedValue(batch('notice-1', null))
  controller.begin()
  await vi.waitFor(() => { expect(latest()).toMatchObject({ id: 'notice-1', displayUntil: null }) })
  controller.shown('notice-1' as AccountNotificationId)
  await vi.waitFor(() => { expect(displayed).toHaveBeenCalledWith('notice-1') })
  controller.end()
})

it('publishes every live notice and reports display only for the foreground card', async () => {
  const { controller, read, displayed, dismissed, stacks } = setup()
  const notifications = ['first', 'second', 'third'].flatMap(id => batch(id, null).notifications)
  read.mockResolvedValue({ nextPollAfterSeconds: TIMING.pollIntervalMs / 1_000, notifications })
  controller.begin()
  await vi.waitFor(() => { expect(stacks.at(-1)).toEqual(notifications) })
  controller.shown('second' as AccountNotificationId)
  controller.dismiss('third' as AccountNotificationId)
  expect(displayed).not.toHaveBeenCalled()
  expect(stacks.at(-1)).toEqual(notifications)
  controller.shown('first' as AccountNotificationId)
  await vi.waitFor(() => { expect(displayed).toHaveBeenCalledExactlyOnceWith('first') })
  controller.dismiss('first' as AccountNotificationId)
  expect(stacks.at(-1)).toEqual(notifications.slice(1))
  expect(displayed).toHaveBeenCalledTimes(1)
  controller.shown('second' as AccountNotificationId)
  await vi.waitFor(() => { expect(displayed).toHaveBeenLastCalledWith('second') })
  controller.dismiss('second' as AccountNotificationId)
  expect(stacks.at(-1)).toEqual(notifications.slice(2))
  controller.dismiss('third' as AccountNotificationId)
  expect(stacks.at(-1)).toEqual([])
  expect(displayed.mock.calls).toEqual([['first'], ['second']])
  expect(dismissed.mock.calls).toEqual([['first'], ['second'], ['third']])
  controller.end()
})

it('drops queued notices that expire before promotion without reporting display', async () => {
  const { controller, read, displayed, dismissed, stacks } = setup()
  read.mockResolvedValue({ nextPollAfterSeconds: TIMING.pollIntervalMs / 1_000, notifications: [
    ...batch('first', null).notifications,
    ...batch('expired', '2099-01-01T00:00:00Z').notifications,
    ...batch('last', null).notifications,
  ] })
  controller.begin()
  await vi.waitFor(() => { expect(stacks.at(-1)).toHaveLength(3) })
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2100-01-01T00:00:00Z'))
  controller.dismiss('first' as AccountNotificationId)
  expect(stacks.at(-1)?.map(notice => notice.id)).toEqual(['last'])
  expect(displayed).not.toHaveBeenCalled()
  expect(dismissed).toHaveBeenCalledExactlyOnceWith('first')
  controller.end()
})

it('publishes a title-only refresh without reporting the same display twice', async () => {
  const { controller, read, displayed, latest } = setup()
  read.mockResolvedValue(batch('first', null))
  controller.begin()
  await vi.waitFor(() => { expect(latest()?.id).toBe('first') })
  controller.shown('first' as AccountNotificationId)
  await vi.waitFor(() => { expect(displayed).toHaveBeenCalledTimes(1) })
  read.mockResolvedValue({ nextPollAfterSeconds: TIMING.pollIntervalMs / 1_000,
    notifications: batch('first', null).notifications.map(notice => ({ ...notice, title: 'Updated title' })) })
  await controller.refresh()
  expect(latest()?.title).toBe('Updated title')
  controller.shown('first' as AccountNotificationId)
  expect(displayed).toHaveBeenCalledTimes(1)
  controller.end()
})

it('does not read or report display outside an active account lifecycle', async () => {
  const { controller, read, displayed } = setup()
  await controller.refresh()
  expect(read).not.toHaveBeenCalled()
  expect(displayed).not.toHaveBeenCalled()
})

it('closes the visible notice when the preceding card expires before its display callback', async () => {
  const { controller, read, displayed, dismissed, stacks } = setup()
  read.mockResolvedValue({ nextPollAfterSeconds: TIMING.pollIntervalMs / 1_000, notifications: [
    ...batch('first', '2099-01-01T00:00:00Z').notifications,
    ...batch('second', null).notifications,
  ] })
  controller.begin()
  await vi.waitFor(() => { expect(stacks.at(-1)).toHaveLength(2) })
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2100-01-01T00:00:00Z'))
  controller.dismiss('second' as AccountNotificationId)
  expect(stacks.at(-1)).toEqual([])
  expect(displayed).not.toHaveBeenCalled()
  expect(dismissed).toHaveBeenCalledExactlyOnceWith('second')
  controller.end()
})

it('refreshes a consumed card in place on language changes without another list or display report', async () => {
  vi.useFakeTimers()
  const { controller, read, readContent, displayed, latest } = setup()
  try {
    read.mockResolvedValue(batch('first', null))
    controller.begin()
    await vi.advanceTimersByTimeAsync(0)
    controller.shown('first' as AccountNotificationId)
    await vi.advanceTimersByTimeAsync(0)
    const actions = [{ label: '知道了', style: 'secondary', target: { type: 'dismiss' } }] as const
    readContent.mockResolvedValue(notification('first', { title: '通知', body: '新的中文内容', actions }))
    await controller.setLocale('zh')
    expect(readContent).toHaveBeenCalledExactlyOnceWith('first', 'zh')
    expect(latest()).toMatchObject({ id: 'first', title: '通知', body: '新的中文内容', actions })
    expect(read).toHaveBeenCalledTimes(1)
    controller.shown('first' as AccountNotificationId)
    await vi.advanceTimersByTimeAsync(0)
    expect(displayed).toHaveBeenCalledTimes(1)
    await controller.setLocale('zh')
    expect(readContent).toHaveBeenCalledTimes(1)
  } finally { controller.end() }
})

it('ignores an earlier language response after a later language change', async () => {
  vi.useFakeTimers()
  const { controller, read, readContent, latest } = setup()
  const first = Promise.withResolvers<AccountNotice | null>()
  try {
    read.mockResolvedValue(batch('first', null))
    controller.begin()
    await vi.advanceTimersByTimeAsync(0)
    readContent.mockReturnValueOnce(first.promise)
    const changing = controller.setLocale('zh')
    readContent.mockResolvedValueOnce(notification('first', { body: 'Latest English content' }))
    await controller.setLocale('en')
    first.resolve(notification('first', { body: '过时的中文内容' }))
    await changing
    expect(latest()?.body).toBe('Latest English content')
  } finally { first.resolve(null); controller.end() }
})

it.each(['dismiss', 'sign-out', 'account-change'] as const)('does not restore content after %s', async (change) => {
  vi.useFakeTimers()
  const { controller, read, readContent, latest } = setup()
  const response = Promise.withResolvers<AccountNotice | null>()
  try {
    read.mockResolvedValue(batch('first', null))
    controller.begin()
    await vi.advanceTimersByTimeAsync(0)
    readContent.mockReturnValueOnce(response.promise)
    const changing = controller.setLocale('zh')
    if (change === 'dismiss') controller.dismiss('first' as AccountNotificationId)
    else if (change === 'sign-out') controller.end()
    else {
      controller.end()
      read.mockResolvedValue(batch('second', null))
      controller.begin()
      await Promise.resolve()
    }
    response.resolve(notification('first', { body: '迟到的内容' }))
    await changing
    expect(latest()?.id ?? null).toBe(change === 'account-change' ? 'second' : null)
  } finally { response.resolve(null); controller.end() }
})

it.each(['failure', 'absent'] as const)('retains the current content when localization returns %s', async (outcome) => {
  vi.useFakeTimers()
  const { controller, read, readContent, latest } = setup()
  const output = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  try {
    read.mockResolvedValue(batch('first', null))
    controller.begin()
    await vi.advanceTimersByTimeAsync(0)
    if (outcome === 'failure') readContent.mockRejectedValueOnce(new Error('private-detail'))
    await controller.setLocale('zh')
    expect(latest()?.body).toBe('Server copy 5.00')
    expect(JSON.stringify(output.mock.calls)).not.toContain('private-detail')
    expect(output).toHaveBeenCalledTimes(outcome === 'failure' ? 1 : 0)
  } finally { controller.end() }
})

it('localizes notifications returned by a list request started before the language changed', async () => {
  vi.useFakeTimers()
  const { controller, read, readContent, latest } = setup()
  const response = Promise.withResolvers<AccountNotificationBatch | null>()
  try {
    read.mockReturnValueOnce(response.promise)
    controller.begin()
    await controller.setLocale('zh')
    expect(readContent).not.toHaveBeenCalled()
    readContent.mockResolvedValueOnce(notification('first', { body: '当前语言内容' }))
    response.resolve(batch('first', null))
    await vi.advanceTimersByTimeAsync(0)
    expect(readContent).toHaveBeenCalledExactlyOnceWith('first', 'zh')
    expect(latest()?.body).toBe('当前语言内容')
  } finally { response.resolve(null); controller.end() }
})

it('keeps localized copy while an older list response refreshes other notification fields', async () => {
  vi.useFakeTimers()
  const { controller, read, readContent, latest, published } = setup()
  const response = Promise.withResolvers<AccountNotificationBatch | null>()
  try {
    read.mockResolvedValueOnce(batch('first', null))
    controller.begin()
    await vi.advanceTimersByTimeAsync(0)
    read.mockReturnValueOnce(response.promise)
    const refreshing = controller.refresh()
    readContent.mockResolvedValue(notification('first', { body: '新的中文内容' }))
    await controller.setLocale('zh')
    const count = published.length
    response.resolve(batch('first', null))
    await refreshing
    expect(latest()?.body).toBe('新的中文内容')
    expect(published.slice(count).every(notice => notice?.body === '新的中文内容')).toBe(true)
  } finally { response.resolve(null); controller.end() }
})

it.each(['shown', 'before-frame'] as const)('reports an explicit dismissal once when closed %s', async (presentation) => {
  vi.useFakeTimers()
  const { controller, read, displayed, dismissed, latest } = setup()
  read.mockResolvedValue(batch('first'))
  controller.begin()
  await vi.advanceTimersByTimeAsync(0)
  if (presentation === 'shown') {
    controller.shown('first' as AccountNotificationId)
    await vi.advanceTimersByTimeAsync(0)
    expect(dismissed).not.toHaveBeenCalled()
  }
  controller.dismiss('first' as AccountNotificationId)
  controller.shown('first' as AccountNotificationId)
  controller.dismiss('first' as AccountNotificationId)
  expect(latest()).toBeNull()
  await vi.advanceTimersByTimeAsync(0)
  expect(displayed).toHaveBeenCalledTimes(presentation === 'shown' ? 1 : 0)
  expect(dismissed).toHaveBeenCalledExactlyOnceWith('first')
})

it.each(['expiry', 'account-change', 'sign-out', 'unload'] as const)('does not report dismissal on %s cleanup or from a stale callback', async (cleanup) => {
  vi.useFakeTimers()
  const { controller, read, dismissed } = setup()
  const deadline = new Date(Date.now() + 100).toISOString()
  read.mockResolvedValue(batch('first', cleanup === 'expiry' ? deadline : null))
  controller.begin()
  await vi.advanceTimersByTimeAsync(0)
  controller.shown('first' as AccountNotificationId)
  if (cleanup === 'expiry') await vi.advanceTimersByTimeAsync(100)
  else if (cleanup === 'account-change') {
    controller.end()
    read.mockResolvedValue(batch('second'))
    controller.begin()
    await Promise.resolve()
  } else controller.end()
  controller.dismiss('first' as AccountNotificationId)
  await vi.advanceTimersByTimeAsync(0)
  expect(dismissed).not.toHaveBeenCalled()
})

it.each(['success', 'refused', 'failure'] as const)('attempts each display and dismissal once after %s', async (outcome) => {
  vi.useFakeTimers()
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const { controller, read, displayed, dismissed, latest } = setup()
  read.mockResolvedValue(batch('first', null))
  for (const report of [displayed, dismissed]) {
    if (outcome === 'failure') report.mockRejectedValue(new Error('private-detail'))
    else report.mockResolvedValue(outcome === 'success')
  }
  controller.begin()
  await vi.advanceTimersByTimeAsync(0)
  controller.shown('first' as AccountNotificationId)
  controller.shown('first' as AccountNotificationId)
  await vi.advanceTimersByTimeAsync(TIMING.pollIntervalMs)
  controller.begin()
  await controller.refresh()
  controller.shown('first' as AccountNotificationId)
  expect(latest()?.id).toBe('first')
  expect(displayed).toHaveBeenCalledExactlyOnceWith('first')
  controller.dismiss('first' as AccountNotificationId)
  controller.dismiss('first' as AccountNotificationId)
  expect(latest()).toBeNull()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(dismissed).toHaveBeenCalledExactlyOnceWith('first')
  expect(log).toHaveBeenCalledTimes(outcome === 'failure' ? 2 : 0)
  expect(JSON.stringify(log.mock.calls)).not.toContain('private-detail')
})

it('reports the next card and dismissal without waiting for an earlier display report', async () => {
  vi.useFakeTimers()
  const { controller, read, displayed, dismissed, latest } = setup()
  const pending = Promise.withResolvers<boolean>()
  displayed.mockReturnValueOnce(pending.promise)
  read.mockResolvedValue({ ...batch('first', null), notifications: [notification('first'), notification('second')] })
  try {
    controller.begin()
    await vi.advanceTimersByTimeAsync(0)
    controller.shown('first' as AccountNotificationId)
    controller.dismiss('first' as AccountNotificationId)
    controller.shown('second' as AccountNotificationId)
    expect(latest()?.id).toBe('second')
    expect(displayed.mock.calls).toEqual([['first'], ['second']])
    expect(dismissed).toHaveBeenCalledExactlyOnceWith('first')
  } finally {
    pending.resolve(true)
    await pending.promise
    controller.end()
  }
})

it.each(['success', 'failure'] as const)('ignores a late event %s after changing credentials', async (outcome) => {
  vi.useFakeTimers()
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const { controller, read, displayed, latest } = setup()
  const pending = Promise.withResolvers<boolean>()
  displayed.mockReturnValueOnce(pending.promise)
  read.mockResolvedValue(batch('first', null))
  controller.begin()
  await vi.advanceTimersByTimeAsync(0)
  controller.shown('first' as AccountNotificationId)
  controller.end()
  read.mockResolvedValue(batch('second', null))
  controller.begin()
  await vi.advanceTimersByTimeAsync(0)
  controller.shown('second' as AccountNotificationId)
  if (outcome === 'success') pending.resolve(true)
  else pending.reject(new Error('obsolete'))
  await vi.advanceTimersByTimeAsync(60_000)
  expect(latest()?.id).toBe('second')
  expect(displayed.mock.calls).toEqual([['first'], ['second']])
  expect(log).not.toHaveBeenCalled()
})

it.each(['success', 'refused', 'failure'] as const)('reports a CTA click once without dismissing or retrying after %s', async (outcome) => {
  vi.useFakeTimers()
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const { controller, read, clicked, displayed, dismissed, latest } = setup()
  read.mockResolvedValue(batch('first', null))
  if (outcome === 'failure') clicked.mockRejectedValue(new Error('offline'))
  else clicked.mockResolvedValue(outcome === 'success')
  controller.begin()
  await vi.advanceTimersByTimeAsync(0)
  controller.ctaClicked('first' as AccountNotificationId)
  expect(latest()?.id).toBe('first')
  expect(displayed).not.toHaveBeenCalled()
  expect(dismissed).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(clicked).toHaveBeenCalledExactlyOnceWith('first')
  expect(log).toHaveBeenCalledTimes(outcome === 'failure' ? 1 : 0)
  controller.ctaClicked('first' as AccountNotificationId)
  expect(clicked).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(0)
})

it('keeps dismissal available while a CTA-click report is pending', async () => {
  vi.useFakeTimers()
  const { controller, read, clicked, dismissed, latest } = setup()
  const pending = Promise.withResolvers<boolean>()
  clicked.mockReturnValueOnce(pending.promise)
  read.mockResolvedValue(batch('first', null))
  try {
    controller.begin()
    await vi.advanceTimersByTimeAsync(0)
    controller.ctaClicked('first' as AccountNotificationId)
    expect(latest()?.id).toBe('first')
    controller.dismiss('first' as AccountNotificationId)
    expect(dismissed).toHaveBeenCalledExactlyOnceWith('first')
    expect(latest()).toBeNull()
  } finally {
    pending.resolve(true)
    await pending.promise
  }
})

it.each(['back-card', 'expired', 'signed-out'] as const)('ignores a CTA click from a %s notification', async (state) => {
  vi.useFakeTimers()
  const { controller, read, clicked } = setup()
  read.mockResolvedValue({ ...batch('first', null), notifications: [
    notification('first', { displayUntil: '2099-01-01T00:00:00Z' }), notification('second'),
  ] })
  controller.begin()
  await vi.advanceTimersByTimeAsync(0)
  if (state === 'signed-out') controller.end()
  else if (state === 'expired') vi.setSystemTime(new Date('2100-01-01T00:00:00Z'))
  controller.ctaClicked((state === 'back-card' ? 'second' : 'first') as AccountNotificationId)
  expect(clicked).not.toHaveBeenCalled()
})
