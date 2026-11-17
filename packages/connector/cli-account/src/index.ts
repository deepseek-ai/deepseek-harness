/**
 * Host Service of CLI app plugins: a plugin registers its third-party CLI, which owns the user's account, once. The
 * Service tells the model the CLI's absolute path in runtime context, runs the plugin's account operations one at a
 * time, and shows the account on the Plugins page. Each plugin keeps its own commands, parsing, and states.
 * @module @deepseek-ai/dsh-cli-account
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-client-ui-connector-account'
import type { ConnectorAccountDisplay } from '@deepseek-ai/dsh-client-ui-connector-account/types'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { registerCliPathContext } from './context.ts'
import { CliCommandExecutor } from './executor.ts'
import { CliAccountRuntime, failureDetails } from './runtime.ts'
import { accountText } from './text.ts'
import type { CliAccountHandle, CliAccountRegistration, CliAccountView } from './types.ts'

export type { CliPathContext } from './context.ts'
export type { CliCommandResult, CliRunOptions } from './executor.ts'
export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The vendor CLIs and accounts CLI app plugins register. */
    cliAccounts: CliAccounts
  }
}

/** Settings that apply to every registered CLI. */
export interface Config {
  /** Deadline in milliseconds for a command that does not wait for the user, including executable lookup. */
  commandTimeoutMs: number
}

/**
 * Holds what CLI app plugins register: for each plugin, the CLI path the model reads in runtime context, the account
 * operations that run one at a time, and the account the Plugins page shows.
 */
export default class CliAccounts extends Service {
  static inject = ['subprocess', 'systemPrompt']

  static Config: z<Partial<Config>, Config> = z.object({
    commandTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(30_000),
  })

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'cliAccounts')
  }

  /**
   * Register the calling plugin's CLI and account: add the CLI's absolute path to required runtime context, run the
   * plugin's account operations one at a time, and show the account on the Plugins page while `connectorAccounts` is
   * loaded. The registration belongs to the calling plugin: unloading that plugin withdraws it, after the active
   * operation and the CLI processes it started have stopped.
   * @param registration - the plugin's CLI, account operations, and Plugins page text.
   * @returns the handle for the plugin's own reads and updates of the account.
   * @throws when the runtime-context name `<name>:cli` is already registered.
   */
  register<Account, Kind extends string, Phase extends string, Command extends string, Key extends string>(
    registration: CliAccountRegistration<Account, Kind, Phase, Command, Key>,
  ): CliAccountHandle<Account, Kind, Phase, Command> {
    const caller = this.ctx
    const { name, packageName, cli } = registration
    const text = accountText(registration.dictionaries)
    const runtime = new CliAccountRuntime<Account, Kind, Phase, Command>({
      name,
      account: registration.account,
      check: registration.check,
      cancellable: registration.cancellable,
      authorizationHosts: registration.authorizationHosts,
      perform: (kind, control, signal) => registration.perform(kind, control, signal),
      executor: new CliCommandExecutor(caller.subprocess, {
        program: cli.program, executable: cli.executable, commandTimeoutMs: this.config.commandTimeoutMs,
      }),
      logger: caller.logger,
    })
    const operations = registration.operations(text)
    const copy = registration.copy(text)
    const present = (view: CliAccountView<Account, Kind, Phase, Command>): ConnectorAccountDisplay => {
      const display = registration.present(view, text)
      const failure = view.result?.failure
      if (display.failure === undefined || failure === undefined) return display
      return { ...display, failure: { ...display.failure, details: failureDetails(failure) } }
    }
    // One effect orders the teardown: the page account goes first, then the operation and its processes stop, and
    // the path context goes last.
    const withdraw = caller.effect(function* () {
      yield registerCliPathContext(caller, `${name}:cli`, cli)
      yield () => runtime.dispose()
      const page = caller.inject(['connectorAccounts'], (scope) => {
        scope.effect(
          () => scope.connectorAccounts.register({ key: packageName, packageName, source: runtime, operations, copy, present }),
          `${name}: Plugins page account`,
        )
      })
      yield page.dispose
    }, `cliAccounts.register(${name})`)
    let withdrawn: Promise<void> | undefined
    return {
      snapshot: () => runtime.snapshot(),
      publish: (account) => { runtime.publish(account) },
      refresh: () => { runtime.refresh() },
      // The effect disposer returns nothing once the plugin's unload has run it.
      dispose: () => withdrawn ??= Promise.resolve(withdraw()),
    }
  }
}
