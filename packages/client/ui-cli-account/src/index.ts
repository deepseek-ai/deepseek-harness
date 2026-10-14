/**
 * Shared Plugins page pieces of CLI app plugins: the connection mirror and the account components. The Web shell links
 * this library statically and shares one copy through its module table; plugins import it like any platform module.
 */
export {
  CliAccountActivation, CliAccountBadge, CliAccountConfirm, CliAccountSection, CliAccountToast,
  type CliAccountAction, type CliAccountActivationProps, type CliAccountBadgeProps, type CliAccountBadgeSubject,
  type CliAccountConfirmProps, type CliAccountFailure,
  type CliAccountKey, type CliAccountNote, type CliAccountPhase, type CliAccountSectionProps, type CliAccountToastProps,
} from './components.tsx'
export { CliAccountConnection, type CliAccountConnectionOptions, type CliAccountNotice, type CliAccountSnapshot } from './connection.ts'
