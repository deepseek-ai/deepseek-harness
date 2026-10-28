/** Confirmation shown when this page reconnects to a Host running another release. */
import clsx from 'clsx'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientReleaseChange, WebBootRelease } from '@deepseek-ai/dsh-client-modules/client'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls ui-layout's SlotMap merge (the 'shell.overlay' entry).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import css from './HostReleasePrompt.module.css'

/** Registrant-private face: the page's release change and its two decisions. */
export type HostReleasePromptInjected = {
  /** Keep this page at its boot release and stop asking about the connected Host's release. */
  dismissRelease: () => void
  /** Reload the page from the Host. */
  reloadPage: () => void
  hooks: {
    /** Host release change owned by the page's module system. */
    releaseChange: HostObservable<ClientReleaseChange | undefined>
  }
}

/** Overlay props: the root overlay owner share, the `settings` copy, and the injected face. */
export type HostReleasePromptProps =
  PropsRuntime<'shell.overlay'> & PropsLocale<'settings'> & InjectFace<HostReleasePromptInjected>

/**
 * Name both ends of one release transition: their versions when those differ, otherwise their commits.
 * @param from - release the transition starts at.
 * @param to - release the transition ends at.
 * @param unknown - text for a release or field the Host did not publish.
 * @returns the start and end text.
 */
function transitionText(from: WebBootRelease | undefined, to: WebBootRelease | undefined, unknown: string): [string, string] {
  const field = from?.version !== to?.version ? 'version' : 'commit'
  return [from?.[field] ?? unknown, to?.[field] ?? unknown]
}

/**
 * One labelled transition line. A completed transition fades its start; a pending one fades its end.
 * @param props - row label, both ends, and completion.
 * @returns the row's cells for the shared transition grid.
 */
function Transition({ label, from, to, done }: { label: string; from: string; to: string; done: boolean }) {
  return (
    <>
      <span className={css.label}>{label}</span>
      <span className={clsx(css.release, done ? css.faded : css.solid)}>{from}</span>
      <span aria-hidden="true" className={clsx(css.line, done ? css.done : css.pending)} />
      <span className={clsx(css.release, done ? css.solid : css.faded)}>{to}</span>
    </>
  )
}

/**
 * Ask whether to reload after the Host changed releases; closing the dialog keeps the page.
 * The service line shows the Host's completed switch from its previous release; the page line shows the
 * switch from the page's boot release that only a reload completes.
 * @param props - the release change, both decisions, and localized copy.
 * @returns the dialog while a change is announced; otherwise nothing.
 */
export function HostReleasePrompt({ useReleaseChange, dismissRelease, reloadPage, t }: HostReleasePromptProps) {
  const change = useReleaseChange(value => value)
  if (change === undefined) return null
  const unknown = t('hostRelease.unknown')
  const [serviceFrom, serviceTo] = transitionText(change.previous, change.host, unknown)
  const [pageFrom, pageTo] = transitionText(change.page, change.host, unknown)
  return (
    <Modal
      open
      title={t('hostRelease.title')}
      description={t('hostRelease.description')}
      closeLabel={t('hostRelease.later')}
      onClose={dismissRelease}
      className={clsx(css.dialog)}
      footer={(
        <>
          {/* The dialog opens without a user gesture, so focus lands on keeping the page: a pending Enter must not reload it. */}
          <Button variant="outline" data-modal-autofocus onClick={dismissRelease}>{t('hostRelease.later')}</Button>
          <Button variant="primary" onClick={reloadPage}>{t('hostRelease.reload')}</Button>
        </>
      )}
    >
      <div className={css.transitions}>
        <Transition label={t('hostRelease.service')} from={serviceFrom} to={serviceTo} done />
        <Transition label={t('hostRelease.page')} from={pageFrom} to={pageTo} done={false} />
      </div>
    </Modal>
  )
}
