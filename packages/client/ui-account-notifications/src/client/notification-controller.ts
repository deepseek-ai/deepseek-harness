/**
 * Lifecycle of account notifications: one foreground card in a stack, one read result in
 * force at a time, and independent display, action-click, and dismissal reports. Account activation
 * and Settings entry replace the polling cycle with an immediate read. Each read
 * settles before the next delay begins; the server owns unconsumed notifications.
 *
 * A displayed event is sent once the foreground card reports a presented frame: the card has
 * a position, the document is visible, and it painted one frame. The card measures
 * no cover, so a card painted under the open Settings overlay reports like any
 * other. Business-action clicks report without waiting or closing the card.
 * Explicit dismissal sends only a dismissed event.
 * Expiry and account cleanup do not report dismissal.
 *
 * One lifecycle covers one signed-in session. Login-progress updates retain the
 * card and active poll. Credential and connection changes end
 * that lifecycle before another begins. Signing out and unloading also clear
 * the cards; a later sign-in shows whatever the server offers.
 * @module @deepseek-ai/dsh-client-ui-account-notifications/src/client/notification-controller
 */
import type {
  AccountNotification, AccountNotificationBatch, AccountNotificationEvent, AccountNotificationId,
} from '@deepseek-ai/dsh-deepseek-account/types'

/** Notification content currently available to the sidebar presentation. */
export type AccountNotice = AccountNotification

/** Collaborators and polling interval of one account notification lifecycle. */
export interface NotificationControllerOptions {
  /** Initial delay for each poll, retained until the server provides a new one. */
  readonly pollIntervalMs: number
  /** UI language in effect when the controller starts. */
  readonly locale: string
  /** Read the signed-in account's unconsumed notifications. @returns the batch, or null when no account is signed in. */
  read: (locale: string) => Promise<AccountNotificationBatch | null>
  /**
   * Query localized content for an existing card without changing consumption.
   * @param id - notification requested by stable identity.
   * @param locale - language captured for this request.
   * @returns content, or null when the account changed; failures reject.
   */
  readContent: (id: AccountNotificationId, locale: string) => Promise<AccountNotification | null>
  /**
   * Report one notification interaction.
   * @param id - notification the user interacted with.
   * @param event - displayed frame, business-action click, or explicit dismissal.
   * @returns false when the account changed or signed out; a protocol failure rejects.
   */
  reportEvent: (id: AccountNotificationId, event: AccountNotificationEvent) => Promise<boolean>
  /** @param notices - notices in front-to-back order; empty when none are shown. */
  publish: (notices: readonly AccountNotice[]) => void
}

/** Commands the account plugin issues to the account notification lifecycle. */
export interface NotificationController {
  /**
   * Start the signed-in lifecycle and restart polling with an immediate read.
   * Re-entry retains cards; the caller ends the lifecycle on credential or connection changes.
   */
  begin(): void
  /** Stop the lifecycle, drop the displayed notice, and ignore late event failures. */
  end(): void
  /**
   * Restart polling with an immediate read, retaining cards.
   * @returns after the immediate read settles, without waiting for later polls.
   */
  refresh(): Promise<void>
  /**
   * Refresh current cards in a new UI language, retaining order and consumption.
   * @param locale - active UI language; an unchanged value issues no request.
   * @returns after content requests settle; failures retain the previous content.
   */
  setLocale(locale: string): Promise<void>
  /** @param id - notice whose card passed a presented frame while visible. */
  shown(id: AccountNotificationId): void
  /** @param id - foreground notice whose non-dismiss action was clicked; reports without removing the card. */
  ctaClicked(id: AccountNotificationId): void
  /** @param id - foreground notice the user explicitly closed; reports only a dismissed event. */
  dismiss(id: AccountNotificationId): void
}

/** One replaceable query cycle; an obsolete request cannot publish or schedule another read. */
interface NotificationPoll {
  intervalMs: number
  timer?: ReturnType<typeof setTimeout>
}

/**
 * @param displayUntil - server expiration timestamp.
 * @param at - milliseconds since epoch.
 * @returns whether the notification can no longer be shown.
 */
function expired(displayUntil: string | null, at: number): boolean {
  if (displayUntil === null) return false
  const expires = Date.parse(displayUntil)
  // An unparsable timestamp is not evidence of expiry, so the notice still shows.
  return !Number.isNaN(expires) && expires <= at
}

/**
 * Own the read, display, and interaction reporting lifecycle of account notifications.
 * @param options - collaborators and timings.
 * @returns the controller the account plugin drives from account and settings state.
 */
export function createNotificationController(options: NotificationControllerOptions): NotificationController {
  let scope: object | undefined
  let locale = options.locale
  let contentGeneration = 0
  /** Notice currently published to the sidebar, including the expiration checked at display time. */
  let current: readonly AccountNotice[] = []
  let poll: NotificationPoll | undefined
  /** Notifications the card on screen already reported, so one mount cannot report display twice. */
  const reported = new Set<AccountNotificationId>()
  const setCurrent = (notices: readonly AccountNotice[]): void => {
    if (notices.length === current.length && notices.every((notice, index) => {
      return JSON.stringify(notice) === JSON.stringify(current[index])
    })) return
    const retained = new Set(notices.map(notice => notice.id))
    for (const id of reported) if (!retained.has(id)) reported.delete(id)
    current = notices
    options.publish(notices)
  }
  /**
   * Keep a presented foreground card until dismissal or expiration, refreshing
   * its copy when offered again; other live candidates follow in server order.
   */
  const apply = (batch: AccountNotificationBatch, preserveCopy: boolean): void => {
    const notifications = batch.notifications.map((notice) => {
      const previous = preserveCopy ? current.find(value => value.id === notice.id) : undefined
      return previous === undefined ? notice : { ...notice, title: previous.title, body: previous.body, actions: previous.actions }
    })
    const foreground = current[0]
    const retained = foreground !== undefined && reported.has(foreground.id)
      ? notifications.find(notice => notice.id === foreground.id) ?? foreground
      : undefined
    const at = Date.now()
    const candidates = notifications.filter(notice => !expired(notice.displayUntil, at))
    setCurrent(retained !== undefined && !expired(retained.displayUntil, at)
      ? [retained, ...candidates.filter(notice => notice.id !== retained.id)]
      : candidates)
  }

  /** Refresh only cards that still belong to this account and language when the replies settle. */
  async function refreshContent(): Promise<void> {
    const scopeAtCall = scope
    if (scopeAtCall === undefined || current.length === 0) return
    const generation = ++contentGeneration
    const requestedLocale = locale
    const responses = await Promise.allSettled(current.map(async notice => options.readContent(notice.id, requestedLocale)))
    if (scope !== scopeAtCall || generation !== contentGeneration) return
    if (responses.some(response => response.status === 'rejected')) console.error('[deepseek-account] notification content read failed')
    const updates = responses.flatMap(response => response.status === 'fulfilled' && response.value !== null ? [response.value] : [])
    setCurrent(current.map((notice) => {
      const update = updates.find(value => value.id === notice.id)
      return update == null ? notice : { ...notice, title: update.title, body: update.body, actions: update.actions }
    }))
  }

  /**
   * Read once for the active poll, retaining cards on failure. Replacement and
   * sign-out discard late replies and prevent another read from being scheduled.
   * @param pollAtRead - query cycle that owns this read.
   * @returns after this read settles.
   */
  async function runRead(pollAtRead: NotificationPoll): Promise<void> {
    const requestedLocale = locale
    let batch: AccountNotificationBatch | null
    try { batch = await options.read(requestedLocale) }
    catch (_error) {
      if (poll !== pollAtRead) return
      console.error('[deepseek-account] notification read failed; retaining cards and retrying on the next poll')
      batch = null
    }
    if (poll !== pollAtRead) return
    if (batch !== null) {
      pollAtRead.intervalMs = batch.nextPollAfterSeconds * 1_000
      apply(batch, requestedLocale !== locale)
      if (requestedLocale !== locale) await refreshContent()
    }
    if (poll !== pollAtRead) return
    pollAtRead.timer = setTimeout(() => { void runRead(pollAtRead) }, pollAtRead.intervalMs)
  }

  const stopPolling = (): void => {
    if (poll?.timer !== undefined) clearTimeout(poll.timer)
    poll = undefined
  }
  const restartPolling = (): Promise<void> => {
    stopPolling()
    poll = { intervalMs: options.pollIntervalMs }
    return runRead(poll)
  }

  /** Attempt each interaction once without changing the card on failure. */
  const report = async (id: AccountNotificationId, event: AccountNotificationEvent): Promise<void> => {
    const scopeAtReport = scope
    if (scopeAtReport === undefined || current[0]?.id !== id || (event === 'displayed' && reported.has(id))) return
    if (event === 'displayed') reported.add(id)
    try { await options.reportEvent(id, event) }
    catch (_error) {
      if (scope === scopeAtReport) {
        console.error('[deepseek-account] notification event report failed; keeping local state without retry', { event })
      }
    }
  }

  const endLifecycle = (): void => {
    if (scope === undefined) return
    stopPolling()
    scope = undefined
    contentGeneration++
    reported.clear()
    setCurrent([])
  }

  return {
    begin() {
      scope ??= {}
      void restartPolling()
    },
    end: endLifecycle,
    refresh(): Promise<void> {
      if (scope === undefined) return Promise.resolve()
      return restartPolling()
    },
    async setLocale(value) {
      if (value === locale) return
      locale = value
      contentGeneration++
      await refreshContent()
    },
    shown(id) {
      setCurrent(current.filter(notice => !expired(notice.displayUntil, Date.now())))
      if (current[0]?.id !== id) return
      void report(id, 'displayed')
    },
    ctaClicked(id) {
      setCurrent(current.filter(notice => !expired(notice.displayUntil, Date.now())))
      if (current[0]?.id !== id) return
      void report(id, 'cta_clicked')
    },
    dismiss(id) {
      setCurrent(current.filter(notice => !expired(notice.displayUntil, Date.now())))
      if (current[0]?.id !== id) return
      void report(id, 'dismissed')
      setCurrent(current.slice(1).filter(notice => !expired(notice.displayUntil, Date.now())))
    },
  }
}
