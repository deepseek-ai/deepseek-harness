/** Resumable desktop onboarding and preference application over Host settings. */
import type { TranscriptViewMode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { createSnapshotStore, shallowEqual } from '@deepseek-ai/dsh-client-store'
import { hasOnboardingCredit } from './onboarding-balance.ts'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsDescribeFace, ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { OnboardingProgress, OnboardingSettings } from '../onboarding-settings.ts'
import type { AccountSnapshot } from './AccountSection.tsx'
import type { DesktopOnboardingState, OnboardingChange } from './onboarding-contract.ts'

function freshProgress(): OnboardingProgress {
  return { version: 1, step: 'welcome', purpose: null, process: null, completion: null, usage: 'compact', developerTools: false }
}

/** Host-backed progress; completing writes active preferences before the durable done marker. */
export class DesktopOnboardingController {
  /** Private observable projected into the shell overlay's framework hook. */
  readonly state = createSnapshotStore<DesktopOnboardingState>({
    status: 'loading', visible: false, progress: freshProgress(), error: null, creditFunded: false,
  })
  private readonly disposers: (() => void)[]
  private saving = false
  private completing = false
  private draft: OnboardingProgress | undefined
  private updates: Promise<boolean> = Promise.resolve(true)
  private disposed = false
  private credentialGeneration = 0
  private hasApiKey: boolean | undefined
  private checkingKeys = false
  private error: 'settings' | null = null
  private failedWrite: { next: OnboardingProgress; applyPreferences: boolean } | undefined
  private creditFunded: boolean | undefined

  /**
   * @param progress - installation-scoped durable progress.
   * @param chat - existing Chat settings owner.
   * @param setDeveloperTools - persist enablement through the shared developer-tools preference.
   * @param account - safe account state, initially unresolved.
   * @param settings - shared settings reader exposing initial failures and retry.
   * @param readApiKeyPresence - reads configured model-credential metadata without secrets.
   */
  constructor(
    private readonly progress: ConfigForm<OnboardingSettings>,
    private readonly chat: ConfigForm<{ transcriptView: TranscriptViewMode; performanceUsage: 'compact' | 'detailed' }>,
    private readonly setDeveloperTools: (enabled: boolean) => Promise<void>,
    private readonly account: HostObservable<AccountSnapshot>,
    private readonly readApiKeyPresence: () => Promise<boolean>,
    private readonly settings: SettingsDescribeFace,
  ) {
    this.disposers = [
      settings.subscribe(() => { this.derive() }),
      progress.subscribe(() => { this.derive() }),
      chat.subscribe(() => { this.derive() }),
      account.subscribe(() => { this.derive() }),
    ]
    this.derive()
  }

  /** Recheck credential metadata after a provider or credential invalidation. */
  invalidateCredentials(): void {
    this.credentialGeneration++
    this.checkingKeys = false
    this.hasApiKey = undefined
    if (this.failedWrite?.next.completion === 'api-key') {
      this.error = null
      this.failedWrite = undefined
    }
    this.derive()
  }

  /**
   * Preview a step or selection immediately and serialize its persistence; the last rejected write restores saved progress.
   * @param change - user-selected progress fields.
   * @returns whether Host settings accepted the complete next progress value.
   */
  async update(change: OnboardingChange): Promise<boolean> {
    if (this.completing || (this.saving && this.draft === undefined) || this.disposed || this.account.getSnapshot().view?.status !== 'credential-stored') return false
    const current = this.draft ?? this.readProgress()
    if (current === undefined || current.step === 'done') return false
    const next = { ...current, ...change }
    this.draft = next
    this.error = null
    const pending = this.updates.then(async () => {
      if (this.disposed || this.account.getSnapshot().view?.status !== 'credential-stored') return false
      return this.save(next, false)
    }).finally(() => {
      if (this.draft === next) this.draft = undefined
      this.derive()
    })
    this.updates = pending
    this.derive()
    return pending
  }

  /**
   * Apply the selected display and developer-tool preferences and finish this installation's introduction.
   * @param reason - ordinary completion or an explicit skip at the current step.
   * @returns whether preferences and the completion marker persisted.
   */
  async complete(reason: 'completed' | 'skipped'): Promise<boolean> {
    if (this.completing || this.disposed || this.account.getSnapshot().view?.status !== 'credential-stored') return false
    this.completing = true
    this.derive()
    try {
      if (!await this.updates) return false
      return await this.finish(reason)
    } finally {
      this.completing = false
      this.derive()
    }
  }

  private async finish(reason: 'completed' | 'skipped'): Promise<boolean> {
    if (this.saving || this.disposed || this.account.getSnapshot().view?.status !== 'credential-stored') return false
    const current = this.readProgress()
    if (current === undefined || current.step === 'done' || current.step === 'welcome') return false
    const office = reason === 'completed' && current.purpose === 'office'
    const development = reason === 'completed' && !office
    if (development && current.process === null) return false
    return this.save({
      ...current, step: 'done', completion: reason,
      process: office ? 'compact' : reason === 'skipped' ? 'standard' : current.process,
      usage: development ? 'detailed' : 'compact', developerTools: development,
    }, true)
  }

  /**
   * Retry an initial settings read or the last failed choice, including active preferences.
   * @returns whether the read or pending write succeeded; false when nothing can be retried.
   */
  async retry(): Promise<boolean> {
    if (this.saving || this.completing || this.draft !== undefined || this.disposed || this.account.getSnapshot().view?.status !== 'credential-stored') return false
    if (this.settings.getSnapshot().error !== null && this.progress.getSnapshot().status === 'loading') {
      await this.settings.ensure()
      return this.progress.getSnapshot().status === 'ready'
    }
    const pending = this.failedWrite
    if (pending === undefined) return false
    const saved = await this.save(pending.next, pending.applyPreferences)
    this.updates = Promise.resolve(saved)
    return saved
  }

  /** Remove subscriptions and prevent delayed metadata reads from writing progress. */
  dispose(): void {
    this.disposed = true
    this.credentialGeneration++
    for (const dispose of this.disposers) dispose()
  }

  private readProgress(): OnboardingProgress | undefined {
    const value = this.progress.getSnapshot().value
    return value === undefined ? undefined : {
      ...value, purpose: value.purpose ?? null, process: value.process ?? null, completion: value.completion ?? null,
    }
  }

  private async save(next: OnboardingProgress, applyPreferences: boolean): Promise<boolean> {
    const accountStatus = this.account.getSnapshot().view?.status
    this.saving = true
    this.error = null
    this.derive()
    try {
      if (applyPreferences) {
        const mode = next.process
        const accepted = await this.chat.mutate([
          { op: 'set', path: ['transcriptView'], value: mode },
          { op: 'set', path: ['performanceUsage'], value: next.usage },
        ])
        const saved = this.chat.getSnapshot().value
        if (!accepted || saved?.transcriptView !== mode || saved.performanceUsage !== next.usage) throw new Error('Chat preferences were not saved')
        if (this.disposed || this.account.getSnapshot().view?.status !== accountStatus) return false
        await this.setDeveloperTools(next.developerTools)
      }
      if (this.disposed || this.account.getSnapshot().view?.status !== accountStatus) return false
      const fields = Object.keys(next) as (keyof OnboardingProgress)[]
      const accepted = await this.progress.mutate(
        fields.map(field => ({ op: 'set' as const, path: [field], value: next[field] })),
      )
      const saved = this.readProgress()
      if (!accepted || saved === undefined
        || Object.entries(next).some(([field, value]) => saved[field as keyof OnboardingProgress] !== value)) {
        throw new Error('onboarding progress was not saved')
      }
      this.failedWrite = undefined
      return true
    } catch {
      // Settings mutations report refusal through recovered snapshots or rejected transport promises.
      this.error = 'settings'
      this.failedWrite = { next, applyPreferences }
      return false
    } finally {
      this.saving = false
      this.derive()
    }
  }

  private derive(): void {
    if (this.disposed) return
    const host = this.progress.getSnapshot()
    const snapshot = this.account.getSnapshot()
    const account = snapshot.view
    const signedIn = account?.status === 'credential-stored'
    const progress = this.draft ?? this.readProgress() ?? freshProgress()
    if (!signedIn) this.creditFunded = undefined
    else if (this.creditFunded === undefined && host.status === 'ready' && progress.step === 'credit') {
      this.creditFunded = hasOnboardingCredit(snapshot.details?.balance)
    }
    if (signedIn && this.failedWrite?.next.completion === 'api-key') {
      this.failedWrite = undefined
      this.error = null
    }
    const done = progress.step === 'done'
    const unavailable = host.status === 'unavailable' || (host.status === 'ready' && !host.writable)
    const readFailed = host.status === 'loading' && this.settings.getSnapshot().error !== null
    const accountFailed = account === undefined && snapshot.failed
    const previous = this.state.getSnapshot()
    const next: DesktopOnboardingState = {
      progress: shallowEqual(previous.progress, progress) ? previous.progress : progress,
      creditFunded: this.creditFunded ?? false,
      visible: !done && signedIn && !unavailable,
      status: this.completing || (this.saving && this.draft === undefined) ? 'saving' : unavailable || readFailed || accountFailed || this.error !== null ? 'error'
        : host.status === 'loading' || account === undefined ? 'loading' : 'ready',
      error: unavailable || readFailed ? 'settings' : this.error,
    }
    if (!shallowEqual(previous, next)) this.state.set(next)
    if (done || this.saving || this.completing || this.draft !== undefined || unavailable || host.status !== 'ready' || this.chat.getSnapshot().status !== 'ready'
      || account?.status !== 'signed-out') return
    if (this.hasApiKey === true && this.error === null) {
      void this.save({ ...progress, step: 'done', process: 'standard', usage: 'detailed', developerTools: true, completion: 'api-key' }, true)
    } else if (this.hasApiKey === undefined && !this.checkingKeys) {
      this.checkingKeys = true
      const generation = this.credentialGeneration
      void this.readApiKeyPresence().then((present) => {
        if (this.disposed || generation !== this.credentialGeneration) return
        this.hasApiKey = present
        this.checkingKeys = false
        this.derive()
      }).catch(() => {
        if (this.disposed || generation !== this.credentialGeneration) return
        this.checkingKeys = false
        this.hasApiKey = false
      })
    }
  }
}
