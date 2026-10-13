/** Keyed Workspace notices and the shared Toast Factory's display data. */
import type {
  FactoryComponentPropsOf, InjectFace, PropsLocale, PropsRenderFactories, PropsRuntime, PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { RowToastState, WorkspaceViewStoreHandle } from './slots.ts'

/** Business key of one existing Workspace notice. */
export type ToastKind = RowToastState['kind']
/** Notice payload selected by the keyed registration. */
export type ToastNotice<K extends ToastKind> = Extract<RowToastState, { kind: K }>
/** Plain display fields consumed by the shared Factory. */
export interface ToastDisplay {
  text: string
  tone: 'plain' | 'warning' | 'success'
  holdMs?: number
  actions?: readonly { label: string; prefix?: string; onClick: () => void }[]
}
/** Per-display identity and dismissal; neither changes when localized content updates. */
export interface ToastOccurrence extends ToastDisplay {
  seq: number
  onDone: () => void
}
/** Pure localized display mapping owned by a keyed notice registration. */
export interface ToastDisplayInjected<K extends ToastKind> {
  display: (notice: ToastNotice<K>, t: PropsLocale<'workspace'>['t'], dismiss: () => void) => ToastDisplay
}
/** Shared adapter props; each registration narrows its notice payload. */
export type ToastEntryProps<P extends PropsRuntime<'workspace.toast'>> =
  P & PropsLocale<'workspace'> & PropsRenderFactories & InjectFace<{
    display: (notice: P, t: PropsLocale<'workspace'>['t'], dismiss: () => void) => ToastDisplay
  }>
/** Archive adapters additionally read the existing viewing store. */
export interface ArchiveToastInjected extends ToastDisplayInjected<'archived' | 'stoppedAndArchived'> {
  filterAction: (t: PropsLocale<'workspace'>['t'], dismiss: () => void) => NonNullable<ToastDisplay['actions']>[number]
}
/** Archive adapter props with its injected action and viewing-state seats. */
export type ArchiveToastEntryProps =
  PropsRuntime<'workspace.toast', 'archived' | 'stoppedAndArchived'> & PropsLocale<'workspace'> & PropsRenderFactories
  & PropsStore<WorkspaceViewStoreHandle> & InjectFace<ArchiveToastInjected>

/** Complete props of the shared Workspace Toast Factory. */
export type WorkspaceToastProps = FactoryComponentPropsOf<'workspace.toast.content'>

/** Owner operations available to every keyed Workspace notice. */
export interface WorkspaceToastOwnerProps {
  /** Dismiss the displayed notice. */
  dismissToast: () => void
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Workspace notices selected by their existing business discriminator. */
    'workspace.toast': {
      kind: 'keyed'
      scope: 'root'
      owner: WorkspaceToastOwnerProps
      keyProps: { [K in ToastKind]: ToastNotice<K> }
    }
  }
  interface SlotFactoryMap {
    /** Shared Toast presentation; business registrations supply only display data and callbacks. */
    'workspace.toast.content': { scope: 'root'; props: ToastOccurrence }
  }
}
