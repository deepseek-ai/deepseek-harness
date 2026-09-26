/** Office preview registration backed by authorized Host rendering and the existing PDF body. */
import type { Context } from '@deepseek-ai/cordis'
import { retainDocumentTabs } from '../document/tab-lifetime.ts'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-office-to-pdf/remote'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-api-workspace-files/remote'
import { failureLine } from '../failure-line.ts'
import { documentTabInfoFactory } from '../document/contract.ts'
import { en, zh, type OfficePreviewKey } from './locales.ts'
import { OfficePreviewCache, type ReadOfficeBytes, type ReadOfficeDocument } from './cache.ts'
import { pdfBodyRegistration } from '../pdf/index.ts'
import { LazyPdfBody } from '../pdf/LazyPdfBody.tsx'
import { OfficeBody, type OfficeBodyInjected } from './OfficeBody.tsx'
import { OfficeFontAction } from './OfficeFontAction.tsx'
import { officeFace } from './face.ts'
import { createOfficeStore } from './store.ts'
import type { Config } from '../../config.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    sidebarOffice: OfficePreviewKey
  }
}

/**
 * Register Office previews with versioned PDF reuse and missing-font notices.
 * @param ctx - Client renderer registry, localized copy, and optional Host Remotes.
 * @param config - Resolved Office preview cache limits.
 */
export function apply(ctx: Context, config: Config['office']): void {
  const id = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/office'
  const extensions = ['doc', 'docx', 'ppt', 'pptx']
  ctx.effect(() => ctx.locale.register('sidebarOffice', { zh, en }))
  const t = ctx.locale.bind('sidebarOffice')
  const unavailable: ReadOfficeDocument = (_file, signal) => {
    signal.throwIfAborted()
    return Promise.reject(new Error(t('unavailable')))
  }
  let read = unavailable
  ctx.effect(() => ctx.documentPreviews.register({
    id,
    extensions, binaryExtensions: extensions, priority: 'builtin',
    title: () => t('title'), loading: 'renderer', wrap: false,
  }))
  const store = createOfficeStore()
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document.action', () => ctx.slots.register({
    name: 'sidebar.right.tab.document.action', key: id, locale: 'sidebarOffice', store,
  }, OfficeFontAction)))
  const retainTab = retainDocumentTabs(ctx)
  const documentT = ctx.locale.bind('sidebarDocumentPreview')
  const face = officeFace(
    (file, signal) => read(file, signal),
    failure => 'code' in failure ? failureLine(documentT, failure) : documentT('error.unavailable', { message: failure.message }),
  )
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({
    name: 'sidebar.right.tab.document', key: id, locale: 'sidebarOffice', store,
    children: { 'sidebar.right.tab.document.office.pdf': {
      kind: 'keyed', scope: 'session', inject: { hooks: { tabInfo: documentTabInfoFactory } },
    } },
    inject: (sessionId, actions): OfficeBodyInjected => ({
      ...face(sessionId, actions),
      retainTab: (tabId, signal) => { retainTab(tabId, signal, actions.forget) },
    }),
  }, OfficeBody)))
  const pdfPresentation = pdfBodyRegistration(ctx)
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document.office.pdf', () => ctx.slots.register({
    name: 'sidebar.right.tab.document.office.pdf', key: id, locale: 'sidebarPdf', ...pdfPresentation,
  }, LazyPdfBody)))
  ctx.inject(['remote', 'remote.officeToPdf', 'remote.workspaceFiles'], (scope) => {
    const convert: ReadOfficeBytes = async (file, signal, priority) => {
      signal.throwIfAborted()
      const result = await scope.remote.officeToPdf.render(file.sessionId, file.path, priority, signal)
      signal.throwIfAborted()
      if (!result.ok && result.error.code === 'document-render/failed') {
        throw new Error(t(conversionErrorKey(result.error.details.reason)), { cause: result.error })
      }
      return result
    }
    const createCache = () => new OfficePreviewCache(
      async (file, signal) => {
        const authorized = await scope.remote.workspaceFiles.readBytes(
          file.sessionId, file.path, { range: { offset: 0, length: 1 } }, signal,
        )
        signal.throwIfAborted()
        if (!authorized.ok) return authorized
        const metadata = await scope.remote.workspaceFiles.stat(file.sessionId, file.path, signal)
        if (metadata.ok && (authorized.value.absolutePath !== metadata.value.absolutePath
          || authorized.value.version !== metadata.value.version)) {
          throw new Error(t('changed'))
        }
        return metadata
      },
      convert, config.maxCachedEntries, config.maxCachedBytes, config.maxPending, config.maxReaders,
      async (signal) => {
        const result = await scope.remote.officeToPdf.generation(signal)
        signal.throwIfAborted()
        if (!result.ok) throw new Error(t('unavailable'), { cause: result.error })
        return result
      }, () => new Error(t('busy')),
    )
    let cache = createCache()
    const retired = new Set<Promise<void>>()
    read = async (file, signal) => {
      const result = await cache.read(file, signal)
      if (!result.ok && (result.error.code === 'gateway/invocation-unavailable' || result.error.code === 'gateway/service-unavailable')) {
        throw new Error(t('unavailable'), { cause: result.error })
      }
      return result
    }
    scope.on('connection/reset', () => {
      const previous = cache
      cache = createCache()
      const closing = previous.dispose().finally(() => { retired.delete(closing) })
      retired.add(closing)
    })
    scope.effect(() => async () => { read = unavailable; await Promise.all([...retired, cache.dispose()]) })
  })
}

function conversionErrorKey(code: string): OfficePreviewKey {
  switch (code) {
    case 'input-too-large': case 'output-too-large': return 'tooLarge'
    case 'invalid-document': case 'unsupported-format': return 'invalid'
    case 'timeout': return 'timeout'
    case 'unavailable': return 'unavailable'
    case 'busy': return 'busy'
    case 'source-changed': return 'changed'
    default: return 'failed'
  }
}
