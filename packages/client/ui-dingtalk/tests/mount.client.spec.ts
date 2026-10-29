/** The browser half mounts the DingTalk Remote, registers its account, and withdraws both on disposal or failure. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { CliOperationId } from '@deepseek-ai/dsh-cli-account/types'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { CliAccountPage, CliAccountRegistration } from '@deepseek-ai/dsh-client-ui-cli-account/client'
import type { DingtalkState } from '@deepseek-ai/dsh-dingtalk-cli/types'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, vi } from 'vitest'
import { apply as hostApply } from '../src/index.ts'
import { en } from '../src/client/locales.ts'

const REMOTE: TypertRemoteContribution = { package: '@deepseek-ai/dsh-dingtalk-cli', descriptors: [] }
const OP = 'op' as CliOperationId

async function fixture() {
  const ctx = new Context()
  const unmount = vi.fn(async () => {})
  const remote = { follow: vi.fn(), cancel: vi.fn(), check: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }
  class Remote extends Service {
    constructor() { super(ctx, 'remote') }
    async $mount(contribution: TypertRemoteContribution) {
      expect(contribution).toBe(REMOTE)
      ctx.provide('remote.dingtalk', remote)
      return unmount
    }
  }
  new Remote()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  const unregister = vi.fn()
  const register = vi.fn((_account: CliAccountRegistration<DingtalkState>) => unregister)
  ctx.provide('cliAccounts', { register })
  vi.doMock('@deepseek-ai/dsh-dingtalk-cli/remote', () => ({ default: REMOTE }))
  const browser = await import('../src/client/index.ts')
  return { ctx, locale, unmount, remote, register, unregister, browser }
}

it('registers the DingTalk account over its Remote, then withdraws it and the Remote', async () => {
  hostApply()
  const b = await fixture()
  try {
    const fiber = b.ctx.plugin({ inject: [...b.browser.inject], apply: b.browser.apply })
    await fiber
    b.locale.setLocale('en')
    expect(b.register).toHaveBeenCalledOnce()
    const account = b.register.mock.calls[0]![0]
    expect(account).toMatchObject({ packageName: '@deepseek-ai/dsh-dingtalk', locale: 'dingtalk' })
    const signal = new AbortController().signal
    void account.follow(signal)
    void account.cancel(OP)
    expect(b.remote.follow).toHaveBeenCalledWith(signal)
    expect(b.remote.cancel).toHaveBeenCalledWith(OP)
    expect(account.notices['sign-in']?.()).toBe(en['notice.connected'])
    expect(account.notices['sign-out']?.()).toBe(en['notice.signed-out'])
    expect(account.notices.check).toBeUndefined()

    const page: CliAccountPage = { start: vi.fn<CliAccountPage['start']>((call) => { void call() }), cancel: vi.fn(), openAuthorization: vi.fn(), retry: vi.fn() }
    const snapshot = { linked: true, stopped: false, busy: false, notice: undefined }
    const press = (view: DingtalkState, label: string) => {
      const found = account.present({ ...snapshot, view }, page).actions?.find(item => item.label === label)
      expect(found).toBeDefined()
      found!.onClick()
    }
    press({ account: { state: 'signed-out' } }, en['action.connect'])
    press({ account: { state: 'unverified' } }, en['action.retry'])
    press({ account: { state: 'connected' } }, en['action.signOut'])
    expect(b.remote.signIn).toHaveBeenCalledOnce()
    expect(b.remote.check).toHaveBeenCalledOnce()
    expect(b.remote.signOut).toHaveBeenCalledOnce()

    await fiber.dispose()
    expect(b.unregister).toHaveBeenCalledOnce()
    expect(b.unmount).toHaveBeenCalledOnce()
  } finally {
    await b.ctx.fiber.dispose()
    vi.doUnmock('@deepseek-ai/dsh-dingtalk-cli/remote')
  }
})

it('withdraws the Remote when the account fails to register', async () => {
  const b = await fixture()
  b.register.mockImplementationOnce(() => { throw new Error('register failed') })
  try {
    await expect(b.browser.apply(b.ctx)).rejects.toThrow('register failed')
    expect(b.unmount).toHaveBeenCalledOnce()
  } finally {
    await b.ctx.fiber.dispose()
    vi.doUnmock('@deepseek-ai/dsh-dingtalk-cli/remote')
  }
})
