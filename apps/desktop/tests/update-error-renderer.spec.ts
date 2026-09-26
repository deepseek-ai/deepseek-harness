import { readFileSync } from 'node:fs'
import { runInContext } from 'node:vm'
import { JSDOM } from 'jsdom'
import { expect, it, onTestFinished, vi } from 'vitest'
import { resolveDesktopLocale } from '../src/locale.ts'
import type { UpdateDialogApi, UpdateDialogView } from '../src/update-dialog.ts'
import type { MandatoryUpdateApi, MandatoryUpdateView } from '../src/mandatory-update-window.ts'

function page(name: string) {
  const dom = new JSDOM(readFileSync(new URL(`../renderer/${name}.html`, import.meta.url), 'utf8'), { runScripts: 'outside-only' })
  onTestFinished(() => {
    dom.window.dispatchEvent(new dom.window.Event('pagehide'))
    dom.window.close()
  })
  const document = dom.window.document
  const element = (id: string): HTMLElement => {
    const result = document.getElementById(id)
    if (result === null) throw new Error(`Missing update element: ${id}`)
    return result
  }
  const run = (): void => { runInContext(readFileSync(new URL(`../renderer/${name}.js`, import.meta.url), 'utf8'), dom.getInternalVMContext()) }
  return { dom, document, element, run }
}

it.each(['en', 'zh-CN'])('keeps ordinary diagnostics folded, text-only, and keyboard-accessible: %s', async (language) => {
  const p = page('update-dialog')
  const locale = resolveDesktopLocale(language)
  const state: UpdateDialogView = { revision: 1, locale: locale.id, title: locale.messages.updateFailedTitle,
    message: locale.messages.updateStopFailed, detail: '', buttons: [locale.messages.updateAcknowledge], cancelId: 0,
    closeLabel: locale.messages.updateClose, technicalDetailsLabel: locale.messages.updateTechnicalDetails,
    technicalDetails: '<img src=x onerror="window.compromised=true">\nexit 0; shutdown acknowledged false' }
  const respond = vi.fn(async () => {})
  let publish!: (view: UpdateDialogView | null) => void
  const api: UpdateDialogApi = { status: async () => state, respond, subscribe: (listener) => { publish = listener; return () => {} } }
  Object.defineProperty(p.dom.window, 'dshUpdateDialog', { value: api })
  p.run()
  await expect.poll(() => p.element('dialog').hidden).toBe(false)
  const disclosure = p.element('technical-details') as HTMLDetailsElement
  expect(disclosure.hidden).toBe(false)
  expect(disclosure.open).toBe(false)
  expect(p.element('title').textContent).toBe(locale.messages.updateStopFailed)
  expect(p.element('detail').textContent).toBe('')
  expect(p.element('technical-details-content').childElementCount).toBe(0)
  expect(p.element('technical-details-content').textContent).toBe(state.technicalDetails)
  const tab = () => p.document.dispatchEvent(new p.dom.window.KeyboardEvent('keydown', { key: 'Tab', cancelable: true }))
  tab()
  expect(p.document.activeElement?.id).toBe('close')
  tab()
  expect(p.document.activeElement?.id).toBe('technical-details-label')
  p.element('technical-details-label').click()
  expect(disclosure.open).toBe(true)
  tab()
  expect(p.document.activeElement?.id).toBe('technical-details-content')
  p.element('technical-details-label').click()
  expect(disclosure.open).toBe(false)
  expect(respond).not.toHaveBeenCalled()
  p.document.dispatchEvent(new p.dom.window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
  expect(respond).toHaveBeenCalledWith(1, 0)
  const backdrop = p.document.body
  const dialog = p.element('dialog')
  dialog.scrollTop = 170
  publish({ ...state, revision: 2, message: locale.messages.updateChecking, technicalDetails: '', buttons: ['OK'] })
  expect(p.document.body).toBe(backdrop)
  expect(p.element('dialog')).toBe(dialog)
  expect(dialog.scrollTop).toBe(0)
  expect(backdrop.classList.contains('visible')).toBe(true)
  expect(p.element('actions').childElementCount).toBe(1)
  expect(disclosure.open).toBe(false)
  expect(p.document.activeElement).toBe(dialog)
  dialog.scrollTop = 80
  publish(state)
  expect(dialog.scrollTop).toBe(80)
  expect(p.element('title').textContent).toBe(locale.messages.updateChecking)
  publish(null)
  expect(backdrop.classList.contains('visible')).toBe(false)
})

it('keeps mandatory diagnostics expandable without clearing the block or authorizing installation', async () => {
  const p = page('mandatory-update')
  const locale = resolveDesktopLocale('zh-CN')
  const initial: MandatoryUpdateView = { locale, deferred: false, policy: { blocking: true, checking: false },
    update: { phase: 'error', failedOperation: 'install', preparationFailure: 'stop-failed', version: '0.1.6-nightly.1',
      message: 'different shell locale', technicalDetails: 'exit 0; shutdown acknowledged false' } }
  const action = vi.fn(async () => {})
  let publish!: (view: MandatoryUpdateView) => void
  const unsubscribe = vi.fn()
  const api: MandatoryUpdateApi = { status: async () => initial, action,
    subscribe: (listener) => { publish = listener; return unsubscribe } }
  Object.defineProperty(p.dom.window, 'dshMandatoryUpdate', { value: api })
  p.run()
  await expect.poll(() => p.element('error').textContent).toBe(locale.messages.updateStopFailed)
  const disclosure = p.element('technical-details') as HTMLDetailsElement
  expect(disclosure.open).toBe(false)
  expect(disclosure.hidden).toBe(false)
  expect([p.element('error').textContent, p.element('technical-details-label').textContent,
    p.element('update').textContent]).toMatchInlineSnapshot(`
      [
        "未能安全停止任务，更新尚未安装，请稍后重试。",
        "查看技术详情",
        "重试更新",
      ]
    `)
  p.element('technical-details-label').click()
  expect(disclosure.open).toBe(true)
  publish(initial)
  expect(disclosure.open).toBe(true)
  const escape = new p.dom.window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
  p.document.dispatchEvent(escape)
  expect(escape.defaultPrevented).toBe(true)
  expect(action).not.toHaveBeenCalled()
  publish({ ...initial, update: { ...initial.update, technicalDetails: '<img src=x onerror="window.compromised=true">' } })
  expect(disclosure.open).toBe(false)
  expect(p.element('technical-details-content').childElementCount).toBe(0)
  publish({ ...initial, error: locale.messages.mandatoryPageFailed })
  expect(disclosure.hidden).toBe(false)
  expect(p.element('technical-details-content').textContent).toBe(initial.update.technicalDetails)
  publish({ ...initial, update: { phase: 'ready', version: '0.1.6-nightly.1' } })
  expect(disclosure.hidden).toBe(true)
  expect(p.element('error').hidden).toBe(true)
  expect(p.document.getElementById('quit')).toBeNull()
  expect(p.document.body.classList.contains('visible')).toBe(true)
  publish({ ...initial, policy: { blocking: false, checking: false } })
  expect(p.document.body.classList.contains('visible')).toBe(false)
  publish(initial)
  expect(p.document.body.classList.contains('visible')).toBe(true)
  p.dom.window.dispatchEvent(new p.dom.window.Event('pagehide'))
  expect(unsubscribe).toHaveBeenCalledOnce()
})

function mandatoryPage(update: MandatoryUpdateView['update']) {
  const p = page('mandatory-update')
  const initial: MandatoryUpdateView = { locale: resolveDesktopLocale('zh'), deferred: false,
    policy: { blocking: true, checking: false, title: '需要更新', page: 'https://downloads.example.com/desktop' }, update }
  const action = vi.fn(async () => {})
  let publish!: (view: MandatoryUpdateView) => void
  Object.defineProperty(p.dom.window, 'dshMandatoryUpdate', { value: {
    status: async () => initial, action, subscribe: (listener: typeof publish) => { publish = listener; return () => {} },
  } satisfies MandatoryUpdateApi })
  p.run()
  return { ...p, initial, action, publish: (view: MandatoryUpdateView) => { publish(view) } }
}

it('uses client copy and retry when optional policy fields are absent', async () => {
  const p = mandatoryPage({ phase: 'idle' })
  p.publish({ ...p.initial, policy: { blocking: true, checking: false } })
  const messages = p.initial.locale.messages
  expect(p.element('title').textContent).toBe(messages.mandatoryTitle)
  expect(p.element('detail').textContent).toBe(messages.mandatoryDetail)
  expect(p.element('error').textContent).toBe(messages.mandatoryNoRelease)
  expect(p.element('refresh').hidden).toBe(false)
  expect(p.element('page').hidden).toBe(true)
})

it('uses the same modal for download, verification, inspected confirmation and task-aware restart', async () => {
  const p = mandatoryPage({ phase: 'available', version: '1.0.1-nightly.1' })
  await expect.poll(() => p.element('update').textContent).toBe('下载更新')
  const modal = p.document.querySelector('main')
  const pending = Promise.withResolvers<undefined>()
  p.action.mockReturnValueOnce(pending.promise)
  p.element('update').focus()
  p.element('update').click()
  p.publish({ ...p.initial, update: { phase: 'verifying', version: '1.0.1-nightly.1' } })
  expect(p.element('status').textContent).toBe('正在校验更新文件…')
  expect(p.element('update').hidden).toBe(true)
  p.publish({ ...p.initial, update: { phase: 'installing', version: '1.0.1-nightly.1' },
    confirmation: { active: false, version: '1.0.1-nightly.1', revision: 1 } })
  expect(p.document.activeElement?.id).not.toBe('update')
  expect(p.element('update').textContent).toBe('安装并重启')
  expect((p.element('update') as HTMLButtonElement).disabled).toBe(false)
  expect(p.element('page').hidden).toBe(true)
  expect(p.element('refresh').hidden).toBe(true)
  expect(p.element('manual-copy').hidden).toBe(true)
  const repeat = new p.dom.window.KeyboardEvent('keydown', { key: 'Enter', repeat: true, cancelable: true })
  p.document.dispatchEvent(repeat)
  expect(repeat.defaultPrevented).toBe(true)
  expect(p.action).toHaveBeenCalledTimes(1)
  p.element('update').dispatchEvent(new p.dom.window.MouseEvent('click', { detail: 2, bubbles: true }))
  expect(p.action).toHaveBeenCalledTimes(1)
  p.element('update').click()
  expect(p.action).toHaveBeenLastCalledWith('install', '1.0.1-nightly.1', 1)
  pending.resolve(undefined)
  p.publish({ ...p.initial, update: { phase: 'installing' }, restart: 'preparing' })
  expect(p.element('detail').textContent).toBe('应用即将重启，请稍候。')
  p.publish({ ...p.initial, update: { phase: 'installing' }, restart: 'stopping-tasks' })
  expect(p.element('detail').textContent).toBe('正在停止任务…')
  expect(p.document.querySelector('main')).toBe(modal)
})

it('reveals the complete selectable address only after copy failure, without replacing updater diagnostics', async () => {
  const p = mandatoryPage({ phase: 'error', failedOperation: 'download', message: 'HASH_MISMATCH' })
  await expect.poll(() => p.element('error').textContent).toBe('更新文件下载或准备失败，请重试。')
  const originalError = p.element('error').textContent
  p.publish({ ...p.initial, navigation: { page: 'requested' } })
  expect(p.element('browser-message').textContent).toBe('页面未打开？')
  expect(p.element('manual-copy').hidden).toBe(true)
  p.publish({ ...p.initial, navigation: { page: 'failed', copy: 'failed' } })
  expect(p.element('manual-copy').hidden).toBe(false)
  expect((p.element('address') as HTMLTextAreaElement).value).toBe(p.initial.policy.page)
  expect((p.element('address') as HTMLTextAreaElement).readOnly).toBe(true)
  expect(p.element('error').textContent).toBe(originalError)
  expect(p.element('technical-details-content').textContent).toBe('HASH_MISMATCH')
  expect(p.element('copy-message').textContent).toBe('复制失败，请手动选择并复制下方链接。')
  p.publish({ ...p.initial, navigation: { page: 'failed', copy: 'copied' } })
  expect(p.element('manual-copy').hidden).toBe(true)
  expect((p.element('address') as HTMLTextAreaElement).value).toBe('')
  expect(p.element('copy').textContent).toBe('链接已复制')
  expect(p.action).not.toHaveBeenCalled()
})

it('renders server markup literally in a dedicated safety case', async () => {
  const p = mandatoryPage({ phase: 'available', version: '1.0.1-nightly.1' })
  await expect.poll(() => p.element('update').textContent).toBe('下载更新')
  p.publish({ ...p.initial, policy: { ...p.initial.policy, title: '<b>请更新</b>', detail: '<img src=x onerror=alert(1)>' } })
  expect(p.element('title').textContent).toBe('<b>请更新</b>')
  expect(p.element('title').childElementCount).toBe(0)
  expect(p.element('detail').childElementCount).toBe(0)
})

it.each(['en', 'zh-CN'])('records mandatory update guidance and actions across its states: %s', async (language) => {
  const p = page('mandatory-update')
  const locale = resolveDesktopLocale(language)
  const base: MandatoryUpdateView = { locale, deferred: false, policy: { blocking: true, checking: false,
    page: 'https://example.invalid/download' }, update: { phase: 'available', version: '0.1.7-alpha.2' } }
  let publish!: (view: MandatoryUpdateView) => void
  const api: MandatoryUpdateApi = { status: async () => base, action: async () => {},
    subscribe: (listener) => { publish = listener; return () => {} } }
  Object.defineProperty(p.dom.window, 'dshMandatoryUpdate', { value: api })
  p.run()
  await expect.poll(() => p.element('title').textContent).toBe(locale.messages.mandatoryTitle)
  const states: MandatoryUpdateView[] = [base,
    { ...base, update: { ...base.update, phase: 'ready' }, confirmation: { active: false, version: '0.1.7-alpha.2', revision: 1 } },
    { ...base, update: { ...base.update, phase: 'ready' }, confirmation: { active: true, version: '0.1.7-alpha.2', revision: 1 } },
    { ...base, update: { ...base.update, phase: 'ready' }, deferred: true },
    { ...base, update: { ...base.update, phase: 'installing' }, restart: 'stopping-tasks' },
    { ...base, update: { ...base.update, phase: 'error', failedOperation: 'install' } },
    { ...base, update: { phase: 'idle' }, navigation: { page: 'failed', copy: 'failed' } },
  ]
  const snapshots = states.map((state) => {
    publish(state)
    return Object.fromEntries(['title', 'detail', 'version', 'error', 'update', 'later', 'page', 'browser-message', 'copy-message']
      .filter(id => !p.element(id).hidden && !p.element(id).closest('[hidden]'))
      .map(id => [id, p.element(id).textContent]))
  })
  await expect(JSON.stringify(snapshots, null, 2) + '\n').toMatchFileSnapshot(`./expected/update-guidance-${language}.json`)
})
