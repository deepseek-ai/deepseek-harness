/** Native command-management dialogs; only fixed installation locations reach the worker. */

import { execFile } from 'node:child_process'
import { isAbsolute, join, normalize, win32 } from 'node:path'
import { userInfo } from 'node:os'
import { promisify } from 'node:util'
import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron'
import type { DesktopMessages } from './locale.ts'
import type { UpdateDialogOptions } from './update-dialog.ts'

interface CommandState {
  fingerprint: string
  managed: boolean
  available: boolean
  destination: string
  launcher: string
  target?: string
  activeCommand?: string
  backup?: string
  preservedBackup?: string
  occupied: boolean
  selectionUnknown?: boolean
}

/** Data required to render one command-management decision. */
export interface CommandPresentation {
  readonly managed: boolean
  readonly available: boolean
  readonly destination: string
  readonly activeCommand?: string
  readonly target?: string
  readonly selectionUnknown?: boolean
}

/** Shell-owned access to installed resources, locale and native dialogs. */
export interface CommandManagerOptions {
  readonly resources: string
  readonly isPackaged: boolean
  readonly isInstalledLocation: () => boolean
  readonly isInstalling: () => boolean
  readonly isQuitting: () => boolean
  readonly messages: () => DesktopMessages
  readonly show: (options: UpdateDialogOptions) => Promise<MessageBoxReturnValue>
}

class CommandWorkerError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseState(value: unknown, platform: NodeJS.Platform): CommandState {
  if (!object(value) || typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(value.fingerprint)
    || typeof value.managed !== 'boolean' || typeof value.available !== 'boolean') throw new Error('Invalid command-manager response.')
  const destination = platform === 'win32' && typeof value.directory === 'string'
    ? join(value.directory, 'dsh.cmd') : value.destination
  const launcher = platform === 'win32' ? destination : value.launcher
  if (typeof destination !== 'string' || !isAbsolute(destination) || typeof launcher !== 'string' || !isAbsolute(launcher)) {
    throw new Error('Invalid command-manager locations.')
  }
  for (const name of ['target', 'activeCommand', 'backup', 'preservedBackup']) {
    if (value[name] !== undefined && value[name] !== null && typeof value[name] !== 'string') throw new Error('Invalid command-manager detail.')
  }
  return {
    fingerprint: value.fingerprint, managed: value.managed, available: value.available,
    destination, launcher,
    occupied: platform === 'win32' ? typeof value.activeCommand === 'string' : value.kind !== 'missing',
    ...typeof value.target === 'string' ? { target: value.target } : {},
    ...typeof value.activeCommand === 'string' ? { activeCommand: value.activeCommand } : {},
    ...typeof value.backup === 'string' ? { backup: value.backup } : {},
    ...typeof value.preservedBackup === 'string' ? { preservedBackup: value.preservedBackup } : {},
  }
}

function format(text: string, path: string): string { return text.replace('{path}', path) }

function sameCommand(left: string, right: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase() : normalize(left) === normalize(right)
}

/**
 * Describe installation state using Desktop-owned copy.
 * @param state - Observed link or PATH selection.
 * @param messages - Current Desktop locale.
 * @param platform - Command lookup semantics of the host operating system.
 * @returns Native dialog with stable Close/Repair/Remove or Install/Cancel indices.
 */
export function presentCommandManagement(
  state: CommandPresentation, messages: DesktopMessages, platform: NodeJS.Platform,
): MessageBoxOptions {
  const other = state.activeCommand !== undefined && !sameCommand(state.activeCommand, state.destination, platform)
  const detail = [
    format(messages.cliCommandLocation, state.destination),
    ...state.activeCommand === undefined ? [] : [format(messages.cliCommandSelected, state.activeCommand)],
    ...state.target === undefined ? [] : [format(messages.cliCommandTarget, state.target)],
    ...other ? [messages.cliCommandShadowed] : [],
    ...state.selectionUnknown ? [messages.cliCommandSelectionUnknown] : [],
  ].join('\n\n')
  return {
    type: other ? 'warning' : 'info', title: messages.cliCommandTitle,
    message: state.managed ? (state.available ? messages.cliCommandInstalled : messages.cliCommandBroken) : messages.cliCommandNotInstalled,
    detail,
    buttons: state.managed
      ? [messages.cliCommandClose, messages.cliCommandRepair, messages.cliCommandRemove]
      : [messages.cliCommandInstall, messages.cancel],
    defaultId: 0, cancelId: state.managed ? 0 : 1,
  }
}

async function shellCommand(): Promise<{ activeCommand?: string; selectionUnknown?: boolean }> {
  const shell = userInfo().shell
  if (shell === null) return { selectionUnknown: true }
  const script = "printf '\\0DSH_COMMAND\\0'; command -v dsh; printf '\\0'"
  const { stdout } = await promisify(execFile)(shell, ['-ilc', script], { timeout: 5000, maxBuffer: 65536 })
  const value = stdout.split('\0DSH_COMMAND\0')[1]?.split('\0')[0]?.trim()
  if (value === undefined) return { selectionUnknown: true }
  if (value === '') return {}
  return isAbsolute(value) && !/[\r\n]/u.test(value) ? { activeCommand: value } : { selectionUnknown: true }
}

/** One visible operation; updater preparation waits for its started worker to finish. */
export class DesktopCommandManager {
  private operation: Promise<void> | undefined

  /** @param options - Installed resources and shell-owned UI callbacks. */
  constructor(private readonly options: CommandManagerOptions) {}

  /** Open or join the command-management operation. */
  show(): Promise<void> {
    return this.operation ??= this.run().finally(() => { this.operation = undefined })
  }

  /** Wait for a command operation already started by the user. */
  async idle(): Promise<void> { await this.operation }

  private async worker(operation: string, expected?: string, elevated = false): Promise<CommandState> {
    const node = join(this.options.resources, 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
    const entry = join(this.options.resources, 'runtime', 'cli', 'command-manager.js')
    let stdout: string
    try {
      if (elevated) {
        const appleScript = 'on run argv\nset cmd to "/usr/bin/env -i " & quoted form of (item 1 of argv) & " " & quoted form of (item 2 of argv) & " " & quoted form of (item 3 of argv) & " " & quoted form of (item 4 of argv)\ndo shell script cmd with administrator privileges\nend run'
        stdout = (await promisify(execFile)('/usr/bin/osascript', ['-e', appleScript, node, entry, operation, expected ?? ''],
          { maxBuffer: 65536 })).stdout
      } else {
        const env = Object.fromEntries(Object.entries(process.env)
          .filter(([name]) => !/KEY|SECRET|TOKEN|PASSWORD|^NODE_OPTIONS$|^NODE_PATH$/iu.test(name)))
        stdout = (await promisify(execFile)(node, [entry, operation, ...expected === undefined ? [] : [expected]],
          { timeout: 30000, maxBuffer: 65536, windowsHide: true, env })).stdout
      }
    } catch (error) {
      if (elevated && object(error) && typeof error.stderr === 'string' && /\(-128\)\s*$/u.test(error.stderr)) {
        throw new CommandWorkerError('ECANCELED', 'Command authorization was cancelled.')
      }
      if (object(error) && typeof error.stdout === 'string' && error.stdout.trim().startsWith('{')) stdout = error.stdout
      else throw new CommandWorkerError('EIO', 'Command-manager process failed.')
    }
    const response: unknown = JSON.parse(stdout.trim())
    if (!object(response) || typeof response.ok !== 'boolean') throw new Error('Invalid command-manager response.')
    if (!response.ok) {
      const code = typeof response.code === 'string' ? response.code : 'EIO'
      if (!elevated && process.platform === 'darwin' && operation !== 'inspect' && ['EACCES', 'EPERM'].includes(code)) {
        return this.worker(operation, expected, true)
      }
      throw new CommandWorkerError(code, typeof response.message === 'string' ? response.message : 'Command management failed.')
    }
    return parseState(response.state, process.platform)
  }

  private async inspect(): Promise<CommandState> {
    const state = await this.worker('inspect')
    if (process.platform !== 'darwin') return state
    try {
      return { ...state, ...await shellCommand() }
    } catch {
      // A custom login shell can fail or wait for interaction; its output is not a diagnostic.
      return { ...state, selectionUnknown: true }
    }
  }

  private async run(): Promise<void> {
    const messages = this.options.messages()
    if (!this.options.isPackaged || !this.options.isInstalledLocation()) {
      await this.options.show({ type: 'info', title: messages.cliCommandTitle, message: messages.cliCommandInstallApp, buttons: [messages.cliCommandClose] })
      return
    }
    if (this.options.isInstalling()) {
      await this.options.show({ type: 'info', title: messages.cliCommandTitle, message: messages.cliCommandUpdating, buttons: [messages.cliCommandClose] })
      return
    }
    try {
      const state = await this.inspect()
      const choice = await this.options.show(presentCommandManagement(state, messages, process.platform))
      if (this.options.isQuitting()) return
      const operation = state.managed ? (choice.response === 1 ? 'install' : choice.response === 2 ? 'remove' : undefined)
        : choice.response === 0 ? 'install' : undefined
      if (operation === undefined) return
      const ownsSelection = state.managed
        && (state.activeCommand === undefined || sameCommand(state.activeCommand, state.destination, process.platform))
      if (operation === 'install' && (state.selectionUnknown || (!ownsSelection && (state.occupied || state.activeCommand !== undefined)))) {
        const confirmation = await this.options.show({
          type: 'warning', title: messages.cliCommandTitle, message: messages.cliCommandSwitch,
          detail: (state.selectionUnknown ? messages.cliCommandSelectionUnknown
            : format(messages.cliCommandSelected, state.activeCommand ?? state.destination))
            + '\n\n' + messages.cliCommandPreserve,
          buttons: [messages.cliCommandContinue, messages.cancel], defaultId: 1, cancelId: 1,
        })
        if (confirmation.response !== 0 || this.options.isQuitting()) return
      }
      const result = await this.worker(operation, state.fingerprint)
      if (this.options.isQuitting()) return
      const current = await this.inspect()
      const shadowed = current.activeCommand !== undefined && !sameCommand(current.activeCommand, current.destination, process.platform)
      await this.options.show({
        type: shadowed && operation === 'install' ? 'warning' : 'info', title: messages.cliCommandTitle,
        message: operation === 'remove' ? messages.cliCommandRemoved : messages.cliCommandInstalled,
        detail: [operation === 'install' ? messages.cliCommandNewTerminal : state.backup !== undefined && state.managed ? messages.cliCommandPreviousRestored : messages.cliCommandOtherKept,
          ...shadowed && operation === 'install' && current.activeCommand !== undefined
            ? [format(messages.cliCommandSelected, current.activeCommand), messages.cliCommandShadowed] : [],
          ...current.selectionUnknown && operation === 'install' ? [messages.cliCommandSelectionUnknown] : [],
          ...result.preservedBackup === undefined ? [] : [format(messages.cliCommandBackupKept, result.preservedBackup)],
        ].join('\n\n'),
        buttons: [messages.cliCommandClose],
      })
    } catch (error) {
      if (this.options.isQuitting()) return
      const code = error instanceof CommandWorkerError ? error.code : 'EIO'
      if (code === 'ECANCELED') return
      await this.options.show({
        type: 'error', title: messages.cliCommandTitle,
        message: code === 'ESTALE' ? messages.cliCommandChanged : code === 'EOWNERSHIP' ? messages.cliCommandOwnershipError : messages.cliCommandFailed,
        technicalDetails: error instanceof Error ? error.message : '',
        buttons: [messages.cliCommandClose],
      })
    }
  }
}
