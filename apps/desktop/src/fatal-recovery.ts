/** Native recovery for the first fatal failure in one Desktop process. */

import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron'
import type { CrashReportSource } from './crash-report.ts'
import { formatDesktopMessage, type DesktopMessages } from './locale.ts'
import { desktopErrorState } from './startup-error.ts'

interface RecoveryOperations {
  messages(): DesktopMessages
  show(options: MessageBoxOptions): Promise<MessageBoxReturnValue>
  stop(): Promise<void>
  disablePlugins(): Promise<void>
  exit(): void
  restart(): void
  /** Persist the complete diagnostic; resolves with the file path, or `undefined` when nothing was written. */
  writeReport(error: unknown, source: CrashReportSource): Promise<string | undefined>
}

/** Upper bound on waiting for the crash report before the dialog opens. */
export const CRASH_REPORT_WAIT_MS = 1_000

/** The dialog's `detail` budget in characters, within which the native message box stays readable. */
const DETAIL_BUDGET = 1200

/** Tail lines of the error kept in the dialog; the report file holds the rest. */
const DETAIL_TAIL_LINES = 8

/**
 * Compose the dialog detail: the error's last lines (prefixed by the
 * shortening notice when they are not the whole error), then the report path
 * when one was written, then the reinstall advice. The report line does not
 * depend on shortening: a short error that was persisted names its file too.
 */
function dialogDetail(error: string, messages: DesktopMessages, reportPath: string | undefined): string {
  const advice = `\n\n${messages.startupReinstallAdvice}`
  const report = reportLine(messages, reportPath)
  const tail = error.split(/\r\n|[\n\r\u2028\u2029]/u).slice(-DETAIL_TAIL_LINES).join('\n')
  const budget = DETAIL_BUDGET - advice.length - report.length - messages.diagnosticTruncated.length - 1
  const shortened = tail.slice(-budget).replace(/^[\uDC00-\uDFFF]/u, '')
  return `${shortened === error ? error : `${messages.diagnosticTruncated}\n${shortened}`}${report}${advice}`
}

function reportLine(messages: DesktopMessages, reportPath: string | undefined): string {
  return reportPath === undefined ? '' : `\n${formatDesktopMessage(messages.reportWrittenTo, { path: reportPath })}`
}

/** Deduplicates fatal reports while keeping explicit recovery-operation failures actionable. */
export class DesktopFatalRecovery {
  private reported = false

  /** @param operations - Native presentation, report persistence, and application-owned shutdown operations. */
  constructor(private readonly operations: RecoveryOperations) {}

  /** Whether this process requires a native recovery action before further plugin changes. */
  get active(): boolean { return this.reported }

  /**
   * Show the first fatal error; later reports cannot replace it or open another dialog.
   * The crash report is written first, bounded by {@link CRASH_REPORT_WAIT_MS}, so the dialog can name it;
   * a slow or failed write shows the dialog without a path.
   * @param error - Fatal failure, including nested diagnostic causes.
   * @param source - Where the failure surfaced, recorded in the report.
   * @returns Completion of the user's recovery action; duplicate reports resolve immediately.
   */
  async report(error: unknown, source: CrashReportSource): Promise<void> {
    if (this.reported) return
    this.reported = true
    const messages = this.operations.messages()
    const reportPath = await this.persist(error, source)
    let detail = desktopErrorState(error).message
    let message = messages.fatalSummary
    for (;;) {
      const addressInUse = /\blisten EADDRINUSE\b/u.test(detail)
      const { response } = await this.operations.show({
        type: 'error',
        title: messages.startupFailed,
        message,
        detail: addressInUse
          ? `${messages.startupAddressInUse}${reportLine(messages, reportPath)}`
          : dialogDetail(detail, messages, reportPath),
        buttons: addressInUse
          ? [messages.exitApplication, messages.restartApplication]
          : [messages.exitApplication, messages.restartApplication, messages.disableThirdPartyPlugins],
        defaultId: 1,
        cancelId: 0,
        noLink: true,
      })
      if (response === 0) {
        try { await this.operations.stop() } catch (failure) { console.error(failure) }
        this.operations.exit()
        return
      }
      try {
        await this.operations.stop()
        if (response === 2) await this.operations.disablePlugins()
        this.operations.restart()
        return
      } catch (failure) {
        console.error(failure)
        message = messages.recoveryOperationFailed
        detail = desktopErrorState(failure).message
      }
    }
  }

  private async persist(error: unknown, source: CrashReportSource): Promise<string | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.operations.writeReport(error, source),
        new Promise<undefined>((resolve) => { timer = setTimeout(() => { resolve(undefined) }, CRASH_REPORT_WAIT_MS) }),
      ])
    } catch (failure) {
      console.error('dsh desktop: crash report failed', failure)
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }
}
