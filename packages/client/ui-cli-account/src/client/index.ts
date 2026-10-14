/**
 * Shared Plugins page pieces of CLI app plugins, browser half. The web app mounts this row once; plugins request it
 * through `dsh.client.external` and import its connection mirror and components from the module table.
 */
export {
  CliAccountActivation, CliAccountBadge, CliAccountConfirm, CliAccountSection, CliAccountToast,
  type CliAccountAction, type CliAccountActivationProps, type CliAccountBadgeProps, type CliAccountConfirmProps, type CliAccountFailure,
  type CliAccountKey, type CliAccountNote, type CliAccountPhase, type CliAccountSectionProps, type CliAccountToastProps,
} from './components.tsx'
export { CliAccountConnection, type CliAccountConnectionOptions, type CliAccountNotice, type CliAccountSnapshot } from './connection.ts'

/** The row has no browser behavior of its own; plugins use its exports. */
export function apply(): void {}
