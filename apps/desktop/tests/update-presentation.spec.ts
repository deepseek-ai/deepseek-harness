import { expect, it } from 'vitest'
import { desktopUpdateErrorSummary, presentDesktopUpdate } from '../src/update-presentation.ts'
import { en, zh } from '../src/locale.ts'
import type { DesktopUpdateState, DshDesktopProductApi } from '../src/ipc.ts'
import type { DesktopUpdateBridge } from '@deepseek-ai/dsh-client-ui-settings-general/types'

it('keeps the Electron preload assignable to the product consumer', () => {
  const assign = (bridge: DshDesktopProductApi['updates']): DesktopUpdateBridge => bridge
  expect(assign).toBeTypeOf('function')
})

it('records visible ordinary-update states without authorizing downloads or installation', async () => {
  const phases: DesktopUpdateState['phase'][] = ['idle', 'available', 'downloading', 'verifying', 'ready', 'installing', 'error']
  const states = phases.map(phase => presentDesktopUpdate({ phase, version: '0.1.5-rc.2', percent: 58 }))
  await expect(JSON.stringify(states, null, 2) + '\n').toMatchFileSnapshot('./expected/update-status-zh.json')
})

it('keeps raw diagnostics out of error tooltips in both locales', () => {
  for (const messages of [en, zh]) {
    for (const failedOperation of ['check', 'download', 'install'] as const) {
      const state: DesktopUpdateState = { phase: 'error', failedOperation,
        message: 'net::ERR_CONNECTION_CLOSED\nHeaders: private\n' + 'at internal/path\n'.repeat(1000) }
      const presentation = presentDesktopUpdate(state)
      expect(presentation.failure).toBe(`${failedOperation}-network`)
      expect(JSON.stringify(presentation)).not.toContain('Headers')
      expect(JSON.stringify(presentation)).not.toContain('internal/path')
    }
    expect(desktopUpdateErrorSummary({ phase: 'error', failedOperation: 'check', message: '404 NoSuchKey' }, messages))
      .toBe(messages.updateCheckFailed)
    expect(desktopUpdateErrorSummary({ phase: 'error', failedOperation: 'download' }, messages))
      .toBe(messages.updateDownloadFailed)
    expect(desktopUpdateErrorSummary({ phase: 'error', failedOperation: 'install', preparationFailure: 'stop-failed',
      message: 'translated or changed copy', technicalDetails: 'private diagnostic' }, messages)).toBe(messages.updateStopFailed)
    for (const [preparationFailure, expected] of [
      ['tasks-changed', messages.updateTasksChanged], ['tasks-unavailable', messages.updateTasksUnavailable],
    ] as const) {
      expect(desktopUpdateErrorSummary({ phase: 'error', failedOperation: 'install', preparationFailure,
        message: 'different locale' }, messages)).toBe(expected)
    }
    expect(desktopUpdateErrorSummary({ phase: 'error', failedOperation: 'install', message: messages.updateStopFailed }, messages))
      .toBe(messages.updateInstallFailed)
    expect(desktopUpdateErrorSummary({ phase: 'error', failedOperation: 'install', message: 'internal failure',
      technicalDetails: 'private diagnostic' }, messages)).toBe(messages.updateInstallFailed)
  }
})
