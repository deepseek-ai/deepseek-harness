import { Context } from '@deepseek-ai/cordis'
import { DeepSeekAccount, type AccountView, type PlatformSession } from '@deepseek-ai/dsh-deepseek-account'
import { expect, it } from 'vitest'
import { installPlatformSessionPublisher } from '../src/platform-session.ts'

const state: AccountView = {
  status: 'credential-stored', attempt: null,
  links: { usageUrl: 'https://platform.example/usage', topUpUrl: 'https://platform.example/top_up' },
}

class Account extends DeepSeekAccount {
  fail = false
  ended = Promise.withResolvers<undefined>()
  reading = Promise.withResolvers<undefined>()
  finished = Promise.withResolvers<undefined>()
  read: () => Promise<PlatformSession | null> = async () => ({ origin: 'https://platform.example', userId: null, token: 'test' })
  override async getState() { return state }
  override async getProfile() { return null }
  override async getBalance() { return null }
  override async getUnnotifiedBonuses() { return null }
  override async ackBonusNotified() { return false }
  override async startSignIn() { return state }
  override async cancelSignIn() { return state }
  override async signOut() { return state }
  override async rejectToken() {}
  override async resolveToken() { return undefined }
  override async getPlatformSession() { this.reading.resolve(undefined); return this.read() }
  override async *watch(signal: AbortSignal) {
    const abort = () => { this.ended.resolve(undefined) }
    signal.addEventListener('abort', abort, { once: true })
    try {
      yield state
      await this.ended.promise
      if (this.fail) throw new Error('fixture subscription failure')
    } finally {
      signal.removeEventListener('abort', abort)
      this.finished.resolve(undefined)
    }
  }
}

it('clears removed credentials and publishes the replacement provider session', async () => {
  const ctx = new Context()
  const sessions: (PlatformSession | null)[] = []
  let delivered = Promise.withResolvers<undefined>()
  installPlatformSessionPublisher(ctx, (session) => { sessions.push(session); delivered.resolve(undefined) })
  try {
    const first = await ctx.plugin(Account)
    await delivered.promise
    expect(sessions.at(-1)?.token).toBe('test')
    await first.dispose()
    expect(sessions.at(-1)).toBeNull()
    delivered = Promise.withResolvers<undefined>()
    await ctx.plugin((scope) => {
      const replacement = new Account(scope)
      replacement.read = async () => ({ origin: 'https://platform.example', userId: null, token: 'replacement' })
    })
    await delivered.promise
    expect(sessions.at(-1)?.token).toBe('replacement')
  } finally {
    await ctx.fiber.dispose()
  }
})

it.each([false, true])('clears credentials when the account stream ends (failure: %s)', async (fail) => {
  const ctx = new Context()
  const cleared = Promise.withResolvers<undefined>()
  installPlatformSessionPublisher(ctx, (session) => { if (session === null) cleared.resolve(undefined) })
  try {
    await ctx.plugin(Account)
    const account = ctx.get('deepseekAccount')
    expect(account).toBeInstanceOf(Account)
    if (!(account instanceof Account)) throw new Error('missing account fixture')
    await account.reading.promise
    account.fail = fail
    account.ended.resolve(undefined)
    await cleared.promise
    await account.finished.promise
  } finally {
    await ctx.fiber.dispose()
  }
})

it('suppresses a credential read that completes during provider disposal', async () => {
  const ctx = new Context()
  const pending = Promise.withResolvers<PlatformSession | null>()
  const cleared = Promise.withResolvers<undefined>()
  const sessions: (PlatformSession | null)[] = []
  installPlatformSessionPublisher(ctx, (session) => { sessions.push(session); if (session === null) cleared.resolve(undefined) })
  try {
    const provider = await ctx.plugin((scope) => {
      const account = new Account(scope)
      account.read = () => pending.promise
    })
    const account = ctx.deepseekAccount
    if (!(account instanceof Account)) throw new Error('missing account fixture')
    await account.reading.promise
    const disposed = provider.dispose()
    await cleared.promise
    pending.resolve({ origin: 'https://platform.example', userId: null, token: 'stale' })
    await disposed
    expect(sessions).toEqual([null])
    await account.finished.promise
  } finally {
    pending.resolve(null)
    await ctx.fiber.dispose()
  }
})
