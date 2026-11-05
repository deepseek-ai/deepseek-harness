/** Consumer-owned navigation for Markdown links. */
import { createContext, useContext, useMemo } from 'react'
import type { HTMLAttributes, ReactNode } from 'react'
import type { FileDragActions } from '../file-drag-actions.ts'
import type { ImageLightboxLabels } from '../ImageLightbox.tsx'

/**
 * Handle one sanitized absolute HTTP(S) URL selected from Markdown.
 * @param href - destination URL.
 */
export type MarkdownExternalLinkHandler = (href: string) => void

/** Explicit object and viewport coordinates from the element owning a context gesture. */
export type MarkdownMenuTarget =
  | { kind: 'file'; path: string; line?: number }
  | { kind: 'url'; url: string }
  | { kind: 'image'; url: string; path?: string; name?: string; mediaType?: string }

/** One Markdown code fence whose language is final, as {@link MarkdownDelegate.renderCode} receives it. */
export interface MarkdownDelegateFenceInfo {
  /**
   * The info string's language word, cut at its first character outside
   * letters, digits, `_`, and `-`, then lowercased (`c++` yields `c`).
   */
  readonly lang: string
  /** The fence body without its closing newline. */
  readonly code: string
  /** The surrounding document is still streaming, so `code` may still change. */
  readonly streaming: boolean
  /** The info string after the language word, as the author wrote it; absent when the fence names only a language. */
  readonly meta?: string | undefined
}

/** Navigation capabilities supplied by the nearest Markdown owner. */
export interface MarkdownDelegate {
  /** Open an object menu without executing its normal activation. */
  readonly getTriggerProps?: ((target: MarkdownMenuTarget) => Pick<HTMLAttributes<HTMLElement>, 'onContextMenu' | 'onKeyDown' | 'tabIndex'>) | undefined
  /**
   * Image previews for decoded local paths in this owner's workspace. The renderer
   * appends a per-mount `load` query parameter to `api/file` route URLs.
   */
  readonly fileImages?: {
    fileDrag: FileDragActions
    resolve: (path: string) => string | undefined
    resourceAddress?: ((path: string) => string) | undefined
    labels: ImageLightboxLabels & { open: string; loading: string; failed: string }
  } | undefined
  /** Ordinary HTTP(S) activation; absent handlers retain native anchor behavior. */
  readonly openExternalLink?: MarkdownExternalLinkHandler | undefined
  /**
   * Open a decoded local destination from settled Markdown; absent handlers leave plain text.
   * @param path - Absolute or workspace-relative file path.
   * @param options - First line to reveal when the destination specifies a line or range.
   */
  readonly openFile?: ((path: string, options?: { line?: number }) => void) | undefined
  /**
   * Render one fence whose language is final: it has a language and content.
   * Absent, the document renders fences with its built-in code and math blocks;
   * present, the owner renders every such fence, including `diff` and `math`.
   * @param fence - language, body, and streaming state.
   * @returns the rendered block.
   */
  readonly renderCode?: ((fence: MarkdownDelegateFenceInfo) => ReactNode) | undefined
}

const MarkdownDelegateContext = createContext<MarkdownDelegate>({})

/** Props for one Markdown navigation scope. */
export interface MarkdownDelegateProviderProps extends MarkdownDelegate {
  readonly children: ReactNode
}

/**
 * Scope Markdown navigation without threading callbacks through renderers.
 * Nested providers replace the enclosing capabilities. Handler changes reach cached links.
 * @param props - Child tree and its file and HTTP(S) link handlers.
 * @returns the scoped child tree.
 */
export function MarkdownDelegateProvider({
  children,
  openExternalLink,
  openFile,
  fileImages,
  getTriggerProps,
  renderCode,
}: MarkdownDelegateProviderProps): ReactNode {
  const delegate = useMemo(() => ({ openExternalLink, openFile, fileImages, getTriggerProps, renderCode }),
    [openExternalLink, openFile, fileImages, getTriggerProps, renderCode])
  return (
    <MarkdownDelegateContext.Provider value={delegate}>
      {children}
    </MarkdownDelegateContext.Provider>
  )
}

/**
 * Read the nearest Markdown navigation capabilities.
 * @returns Owner callbacks, or an empty delegate outside a provider.
 */
export function useMarkdownDelegate(): MarkdownDelegate {
  return useContext(MarkdownDelegateContext)
}
