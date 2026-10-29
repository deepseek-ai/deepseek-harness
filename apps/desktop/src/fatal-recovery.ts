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
  /** Reveal an existing report in the system file manager; reject if it is no longer available. */
  revealReport(path: string): Promise<void>
  /** Persist the complete diagnostic; resolves with the file path, or `undefined` when nothing was written. */
  writeReport(error: unknown, source: CrashReportSource): Promise<string | undefined>
}

type ReportState = { kind: 'pending' } | { kind: 'failed' } | { kind: 'ready'; path: string }

/** Upper bound on waiting for the crash report before the dialog opens. */
export const CRASH_REPORT_WAIT_MS = 1_000

/** The dialog's `detail` budget in characters, within which the native message box stays readable. */
const DETAIL_BUDGET = 1200

/** Tail lines of the error kept in the dialog; the report file holds the rest. */
const DETAIL_TAIL_LINES = 8

/** At most eight error-tail lines; status, advice and truncation notice share the detail character budget.
 * The message heading has its own field.
 */
function dialogDetail(error: string, messages: DesktopMessages, reportState: ReportState): string {
  const advice = `\n\n${messages.startupReinstallAdvice}`
  const report = reportLine(messages, reportState)
  const tail = error.split(/\r\n|[\n\r\u2028\u2029]/u).slice(-DETAIL_TAIL_LINES).join('\n')
  const budget = DETAIL_BUDGET - advice.length - report.length - messages.diagnosticTruncated.length - 1
  const shortened = tail.slice(-budget).replace(/^[\uDC00-\uDFFF]/u, '')
  return `${shortened === error ? error : `${messages.diagnosticTruncated}\n${shortened}`}${report}${advice}`
}

function reportLine(messages: DesktopMessages, state: ReportState): string {
  if (state.kind === 'pending') return `\n${messages.reportPending}`
  if (state.kind === 'failed') return `\n${messages.reportUnavailable}`
  return `\n${formatDesktopMessage(messages.reportWrittenTo, { path: state.path })}`
}

/** Deduplicates fatal reports while keeping explicit recovery-operation failures actionable. */
export class DesktopFatalRecovery {
  private reported = false
  private reportState: ReportState = { kind: 'pending' }

  /** @param operations - Native presentation, report persistence, and application-owned shutdown operations. */
  constructor(private readonly operations: RecoveryOperations) {}

  /** Whether this process requires a native recovery action before further plugin changes. */
  get active(): boolean { return this.reported }

  /**
   * Show the first fatal error; later reports cannot replace it or open another dialog.
   * The crash report is written first, bounded by {@link CRASH_REPORT_WAIT_MS}, so the dialog can name it;
   * a slow or failed write shows its status. Retrieving a report rechecks the same write.
   * @param error - Fatal failure, including nested diagnostic causes.
   * @param source - Where the failure surfaced, recorded in the report.
   * @returns Completion of the user's recovery action; duplicate reports resolve immediately.
   */
  async report(error: unknown, source: CrashReportSource): Promise<void> {
    if (this.reported) return
    this.reported = true
    const messages = this.operations.messages()
    const report = this.persist(error, source)
    await this.waitForReport(report)
    let detail = desktopErrorState(error).message
    let message = messages.fatalSummary
    for (;;) {
      const addressInUse = /\blisten EADDRINUSE\b/u.test(detail)
      const buttons = addressInUse
        ? [messages.exitApplication, messages.restartApplication]
        : [messages.exitApplication, messages.restartApplication, messages.disableThirdPartyPlugins]
      const reportButton = this.reportState.kind === 'failed' ? undefined : buttons.length
      if (reportButton !== undefined) buttons.push(messages.getDiagnosticReport)
      const { response } = await this.operations.show({
        type: 'error',
        title: messages.startupFailed,
        message,
        detail: addressInUse
          ? `${messages.startupAddressInUse}${reportLine(messages, this.reportState)}`
          : dialogDetail(detail, messages, this.reportState),
        buttons,
        defaultId: 1,
        cancelId: 0,
        noLink: true,
      })
      if (response === reportButton) {
        await this.waitForReport(report)
        if (this.reportState.kind === 'ready') {
          try {
            await this.operations.revealReport(this.reportState.path)
            message = messages.reportShareHint
          } catch (failure) {
            console.error('dsh desktop: could not reveal crash report', failure)
            message = messages.reportRevealFailed
          }
        }
        continue
      }
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

  private async persist(error: unknown, source: CrashReportSource): Promise<void> {
    try {
      const path = await this.operations.writeReport(error, source)
      this.reportState = path === undefined ? { kind: 'failed' } : { kind: 'ready', path }
    } catch (failure) {
      console.error('dsh desktop: crash report failed', failure)
      this.reportState = { kind: 'failed' }
    }
  }

  private async waitForReport(report: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        report,
        new Promise<void>((resolve) => { timer = setTimeout(resolve, CRASH_REPORT_WAIT_MS) }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
}
