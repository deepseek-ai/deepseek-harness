// @vitest-environment jsdom
// InputBar behavior over the editor + submit-machine wiring: Enter-send
// semantics (IME guard, Shift newline, busy Enter policy, Ctrl/Meta steering,
// repeat suppression), running semantics (input stays free; continuable
// children keep Send beside Stop), the machine pending lock, chip decorators,
// error banners, status strips, and the focus-keeping mousedown. Keyboard
// gestures dispatch real KeyboardEvents at the contenteditable (the Lexical
// root listener routes them through the keymap commands); draft writes drive
// the shell (jsdom's beforeinput lacks the ranges Lexical needs).

import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { $getRoot, $isTextNode } from 'lexical'
import {
  bindSnapshotSelector, conversationSnapshot as conversationFixture, makeTranslate, RemoteError,
  sessionSnapshot as sessionFixture,
} from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionListState, SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubmitOutcome } from '../src/client/contract/input.ts'
import { SessionInputShell } from '../src/client/input/facade.ts'
import { $replaceDetectSpanWithText, $selectDetectSpan } from '../src/client/input/editor/span-map.ts'
import type {
  ComposerAttachment, ComposerAttachmentsOwnerProps,
} from '../src/client/contract/slots.ts'
import type { DraftAttachmentId } from '../src/client/contract/input.ts'
import { InputBar } from '../src/client/skeleton/InputBar.tsx'
import type { InputBarProps } from '../src/client/skeleton/InputBar.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

// jsdom implements no Range geometry at all — `Range.prototype.getBoundingClientRect`
// is absent — and the composer measures the caret with one when it restores the
// selection after an edit it performed itself. Every case here runs against a
// zero rect; the reveal case below substitutes its own and restores this one.
const ZERO_RECT = (): DOMRect => ({ top: 0, bottom: 0 }) as DOMRect
Range.prototype.getBoundingClientRect = ZERO_RECT

const SCTX = {} as Context
const SID = 's1' as SessionId

function snapshotOf(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return { ...sessionFixture(SID), ...overrides }
}

interface BenchOptions {
  planEntry?: React.ReactNode
  /** The `plan` projection value the standard-kit useProjection serves. */
  plan?: { active: boolean; pending: boolean }
  /** The `goal` projection value used only to prove attachment intake remains ordinary. */
  goal?: { phase: 'active'; objective: string }
  modelEntry?: React.ReactNode
  /** Hot text-ref lexicon (injects a minimal slash stub exposing only lexicon()). */
  lexicon?: ReadonlyMap<'/' | '@', readonly string[]>
  permissions?: { options: { value: string; name: string; description?: string }[]; currentValue: string }
  /** The `imageLimits` projection value (absent = no attachment service). */
  imageLimits?: {
    maxImageBytes: number
    maxImagesPerMessage: number
    maxMessageImageBytes: number
    maxImagePixels: number
    maxImageDimension: number
    mediaTypes: readonly ('image/png' | 'image/jpeg' | 'image/webp' | 'image/gif')[]
  }
  draft?: string
  running?: boolean
  subagent?: Exclude<SessionSnapshot['subagent'], null>
  disabled?: boolean
  inert?: boolean
  blocked?: { readonly reason: string }
  workspacePickerOpen?: boolean
  onRequestWorkspace?: () => void
  promptError?: SessionSnapshot['promptError']
  /** Authoritative queue rows served to the machine overlay (empty = none). */
  queue?: SessionSnapshot['queue']
  /** The hub's steer-all face (empty-draft accelerated Enter). */
  steerQueue?: () => void
  variant?: 'hero' | 'composer'
  placeholder?: string
  t?: InputBarProps['t']
  command?: (line: string) => Promise<boolean>
  accessory?: React.ReactNode
  overlay?: React.ReactNode
  leftItems?: React.ReactNode
  rightItems?: React.ReactNode
  footer?: React.ReactNode
  attachments?: readonly ComposerAttachment[]
  addFiles?: (files: readonly File[]) => string | null
  commandMenuOpen?: boolean
  busyEnter?: 'queue' | 'steer'
  toggleCommandMenu?: (selection: { start: number; end: number }) => void
}

/** One pending queue row (the runtime snapshot shape, as the dock tests build it). */
function row(id: string): SessionSnapshot['queue'][number] {
  return {
    id: id as never, messageId: `message-${id}` as never, placement: 'queued',
    content: [{ type: 'text', text: id }], preview: id, text: id,
  }
}

/** Real machine behind the bar entry: sink spy, no slash pipeline (plain text goes straight to the sink). */
function bench(over?: BenchOptions) {
  const sink = vi.fn<(
    text: string,
    attachmentIds: readonly DraftAttachmentId[],
    mode: 'queue' | 'steer',
    signal: AbortSignal,
  ) => Promise<SubmitOutcome>>(() => Promise.resolve({ kind: 'success' }))
  const lex = over?.lexicon
  const session = createSnapshotStore<SessionSnapshot>(snapshotOf({
    running: over?.running ?? false,
    subagent: over?.subagent ?? null,
    removed: over?.disabled ?? false,
    promptError: over?.promptError ?? null,
    queue: over?.queue ?? [],
  }))
  type ShellDeps = ConstructorParameters<typeof SessionInputShell>[0]
  const shell = new SessionInputShell({
    actx: SCTX,
    defaultSink: sink,
    commandAttachments: { serialize: () => Promise.resolve([]), release: () => {}, unsupportedNotice: (token: string) => `${token.trim()} attachments-unsupported` },
    queue: {
      getSnapshot: () => session.getSnapshot().queue,
      subscribe: fn => session.subscribe(fn),
    },
    ...(over?.steerQueue !== undefined ? { steerQueue: over.steerQueue } : {}),
    // Lexicon-only stub: adjudication untouched (undefined slash methods are
    // never reached — these benches drive plain-draft flows only).
    ...(lex !== undefined
      ? {
        inputTriggers: (() => ({
          track: () => {},
          lexicon: { getSnapshot: () => lex, subscribe: () => () => {} },
        })) as unknown as NonNullable<ShellDeps['inputTriggers']>,
      }
      : {}),
  })
  if (over?.draft !== undefined && over.draft !== '') shell.setDraft(over.draft)
  if (over?.attachments !== undefined) shell.addAttachments(over.attachments.map(attachment => attachment.id))
  const stop = vi.fn()
  const removeAttachment = vi.fn((id: DraftAttachmentId) => { shell.removeAttachment(id) })
  const menuLauncher = createSnapshotStore<string | null>(over?.commandMenuOpen === true ? 'command' : null)
  const slotCalls: { key: string; owner: unknown }[] = []
  const renderSlot = ((key: string, owner: object) => {
    slotCalls.push({ key, owner })
    if (key === 'conversation.input.overlay') return over?.overlay ?? null
    if (key === 'conversation.input.left') return over?.leftItems ?? null
    if (key === 'conversation.input.right') return over?.rightItems ?? null
    if (key === 'conversation.composer.dock') return over?.footer ?? null
    if (key === 'conversation.input.plan') return over?.planEntry ?? null
    if (key === 'conversation.input.model') return over?.modelEntry ?? null
    return null
  }) as never
  const props: InputBarProps = {
    sessionId: SID,
    SessionProvider: ({ children }) => children,
    useSession: bindSnapshotSelector(session),
    useConversation: bindSnapshotSelector(createSnapshotStore(conversationFixture())),
    useSessionPendingInteraction: bindSnapshotSelector(createSnapshotStore(new Map())),
    useSessions: bindSnapshotSelector(createSnapshotStore<SessionListState>({
      ids: [], byId: {}, current: undefined, phase: 'ready',
      subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
    })),
    useWorkspaces: bindSnapshotSelector(createSnapshotStore({
      items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
    })),
    useProjection: ((key: string, selector?: (v: unknown) => unknown) =>
      (selector ?? (v => v))(key === 'permissions'
        ? over?.permissions
        : key === 'plan' ? over?.plan
          : key === 'goal' ? over?.goal
            : key === 'imageLimits' ? over?.imageLimits : undefined)),
    useInput: bindSnapshotSelector(shell.state),
    inputActions: shell.actions,
    keyboard: shell,
    addFiles: over?.addFiles ?? (() => null),
    useFileUploads: bindSnapshotSelector(createSnapshotStore({})),
    retryFileUpload: undefined,
    removeAttachment,
    resolveDraftAttachments: ids => ids.flatMap((id) => {
      const attachment = over?.attachments?.find(candidate => candidate.id === id)
      return attachment === undefined ? [] : [attachment]
    }),
    resolveSubmitMode: (running, gesture, steeringAvailable) => {
      if (!running || !steeringAvailable) return 'queue'
      const preferred = over?.busyEnter ?? 'queue'
      return gesture === 'enter' ? preferred : preferred === 'queue' ? 'steer' : 'queue'
    },
    toggleCommandMenu: over?.toggleCommandMenu ?? vi.fn(),
    useNotices: bindSnapshotSelector(shell.notices),
    useLexicon: bindSnapshotSelector(shell.lexicon),
    useMenuLauncher: bindSnapshotSelector(menuLauncher),
    stop,
    command: over?.command ?? (() => Promise.resolve(true)),
    // Mirrors the real lookup chain (conversation namespace, then common).
    t: over?.t ?? makeTranslate(zh, commonZh),
    renderSlot,
    variant: over?.variant ?? 'composer',
    ...(over?.inert === true ? { disabled: true } : {}),
    ...(over?.blocked !== undefined ? { blocked: over.blocked } : {}),
    ...(over?.workspacePickerOpen !== undefined ? { workspacePickerOpen: over.workspacePickerOpen } : {}),
    ...(over?.onRequestWorkspace !== undefined ? { onRequestWorkspace: over.onRequestWorkspace } : {}),
    ...(over?.placeholder !== undefined ? { placeholder: over.placeholder } : {}),
    ...(over?.accessory !== undefined ? { accessory: over.accessory } : {}),
  }
  const view = render(<InputBar {...props} />)
  const textarea = view.container.querySelector<HTMLDivElement>('[data-composer-input]')!
  const sendableDraft = (over?.draft?.trim() ?? '') !== '' || (over?.attachments?.length ?? 0) > 0
  const primaryStops = over?.running === true && over.subagent === undefined
    && (!sendableDraft || over.blocked !== undefined)
  const button = view.container.querySelector<HTMLButtonElement>(
    `button[aria-label="${primaryStops ? '停止生成' : '发送消息'}"]`,
  )!
  const interruptButton = view.container.querySelector<HTMLButtonElement>('button[aria-label="停止生成"]')
  return {
    view, textarea, button, interruptButton, props, sink, shell, wiring: shell, session, stop, removeAttachment, slotCalls,
    menuLauncher,
    steerQueue: over?.steerQueue,
    get placeholder() { return placeholderOf(view.container) },
    get inputDisabled() { return textarea.getAttribute('aria-disabled') === 'true' },
  }
}

function attachmentOwner(slotCalls: readonly { key: string; owner: unknown }[]): ComposerAttachmentsOwnerProps {
  for (let i = slotCalls.length - 1; i >= 0; i -= 1) {
    const call = slotCalls[i]
    if (call?.key === 'conversation.input.attachments') return call.owner as ComposerAttachmentsOwnerProps
  }
  throw new Error('attachment slot was not rendered')
}

/** The state's placeholder copy (the textarea.placeholder equivalent; the visible layer renders it only while empty). */
function placeholderOf(container: HTMLElement): string {
  return container.querySelector('[data-composer-input]')?.getAttribute('data-placeholder') ?? ''
}

/** Whether the composer surface accepts edits right now (setEditable's DOM face). */
function editableOf(input: HTMLElement): boolean {
  return input.getAttribute('contenteditable') === 'true'
}

/** Write the draft through the shell inside act (the seed path; caret lands at the end). */
function writeDraft(shell: SessionInputShell, text: string): void {
  act(() => { shell.setDraft(text) })
}

describe('image draft rail', () => {
  it('collects clipboard files while preserving text from a mixed paste', async () => {
    const addFiles = vi.fn(() => null)
    const { textarea, shell } = bench({ addFiles })
    const image = new File([Uint8Array.of(1, 2, 3)], 'pixel.png', { type: 'image/png' })
    fireEvent.paste(textarea, {
      clipboardData: {
        items: [
          { kind: 'string', type: 'text/plain', getAsFile: () => null },
          { kind: 'file', type: 'image/png', getAsFile: () => image },
        ],
        getData: () => '同时粘贴的文字',
      },
    })
    expect(addFiles).toHaveBeenCalledWith([image])
    // The paste lands inside the PASTE_COMMAND update; its commit is a microtask away.
    await vi.waitFor(() => { expect(shell.snapshot.draft).toBe('同时粘贴的文字') })
  })

  it('pre-checks projected limits at intake: whole-batch refusal with product copy, none added', () => {
    const limits = {
      maxImageBytes: 1024 * 1024,
      maxImagesPerMessage: 2,
      maxMessageImageBytes: 2 * 1024 * 1024,
      maxImagePixels: 40_000_000,
      maxImageDimension: 2000,
      mediaTypes: ['image/png'] as const,
    }
    const png = (bytes: number, name: string) => new File([new ArrayBuffer(bytes)], name, { type: 'image/png' })
    const intake = (result: ReturnType<typeof bench>, files: File[]) => {
      act(() => { attachmentOwner(result.slotCalls).onAddFiles(files) })
    }
    // Count: three at once over a two-image limit → the whole batch refused.
    const overCount = bench({ addFiles: vi.fn(() => null), imageLimits: limits })
    intake(overCount, [png(8, 'a.png'), png(8, 'b.png'), png(8, 'c.png')])
    expect(overCount.view.getByRole('alert').textContent).toContain('一条消息最多添加 2 张图片')
    expect(overCount.props.addFiles).not.toHaveBeenCalled()
    cleanup()
    // Per-file bytes.
    const overFile = bench({ addFiles: vi.fn(() => null), imageLimits: limits })
    intake(overFile, [png(1024 * 1024 + 1, 'big.png')])
    expect(overFile.view.getByRole('alert').textContent).toContain('单张图片不能超过 1MB')
    expect(overFile.props.addFiles).not.toHaveBeenCalled()
    cleanup()
    // Aggregate bytes across the existing rail plus the new batch.
    const held = new File([new ArrayBuffer(1024 * 1024 * 1.5)], 'held.png', { type: 'image/png' })
    const attachment = { kind: 'image' as const, id: 'draft-1' as DraftAttachmentId, file: held, previewUrl: 'blob:held' }
    const overTotal = bench({ addFiles: vi.fn(() => null), imageLimits: limits, attachments: [attachment] })
    intake(overTotal, [png(1024 * 1024, 'more.png')])
    expect(overTotal.view.getByRole('alert').textContent).toContain('图片总大小超过 2MB')
    expect(overTotal.props.addFiles).not.toHaveBeenCalled()
    cleanup()
    // Within every limit: the batch passes through to addFiles.
    const within = bench({ addFiles: vi.fn(() => null), imageLimits: limits })
    const fits = png(16, 'fits.png')
    intake(within, [fits])
    expect(within.props.addFiles).toHaveBeenCalledWith([fits])
    expect(within.view.queryByRole('alert')).toBeNull()
  })

  it('announces the format problem before any limit when the batch holds a non-image', () => {
    const addFiles = vi.fn(() => '仅支持 PNG、JPG、WebP、GIF 格式的图片')
    const result = bench({
      addFiles,
      imageLimits: {
        maxImageBytes: 8,
        maxImagesPerMessage: 1,
        maxMessageImageBytes: 8,
        maxImagePixels: 40_000_000,
        maxImageDimension: 2000,
        mediaTypes: ['image/png'] as const,
      },
    })
    // Oversized AND over-count AND wrong type: the format rejection wins.
    const files = [
      new File([new ArrayBuffer(64)], 'a.pdf', { type: 'application/pdf' }),
      new File([new ArrayBuffer(64)], 'b.pdf', { type: 'application/pdf' }),
    ]
    act(() => { attachmentOwner(result.slotCalls).onAddFiles(files) })
    expect(addFiles).toHaveBeenCalledWith(files)
    expect(result.view.getByRole('alert').textContent).toContain('仅支持 PNG、JPG、WebP、GIF 格式的图片')
  })

  it('projects display-ready limits into the attachment slot', () => {
    const result = bench({
      addFiles: vi.fn(() => null),
      imageLimits: {
        maxImageBytes: 5 * 1024 * 1024,
        maxImagesPerMessage: 20,
        maxMessageImageBytes: 100 * 1024 * 1024,
        maxImagePixels: 40_000_000,
        maxImageDimension: 2000,
        mediaTypes: ['image/png'] as const,
      },
    })
    expect(attachmentOwner(result.slotCalls).dropLimits).toEqual({ count: 20, size: '5MB' })
  })

  it('announces server attachment rejections as product copy, other codes as developer text', () => {
    const attachmentError = (reason: string): SessionSnapshot['promptError'] => ({
      op: 'send',
      error: new RemoteError('session/attachment-invalid', 'raw wire text', { reason }),
    })
    const model = bench({ promptError: attachmentError('MODEL_DOES_NOT_SUPPORT_IMAGES') })
    expect(model.view.getByRole('alert').textContent).toContain('当前模型不支持图片，请切换支持图片的模型')
    cleanup()
    const unknown = bench({ promptError: attachmentError('ATTACHMENT_NOT_REFERENCED') })
    expect(unknown.view.getByRole('alert').textContent).toContain('图片发送失败（ATTACHMENT_NOT_REFERENCED）')
    cleanup()
    // A subagent refusal uses the same product copy for the same reason.
    const subagent = bench({
      promptError: {
        op: 'send',
        error: new RemoteError('subagent/attachment-invalid', 'raw wire text', {
          reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES',
        }),
      },
    })
    expect(subagent.view.getByRole('alert').textContent).toContain('当前模型不支持图片，请切换支持图片的模型')
    cleanup()
    const other = bench({
      promptError: { op: 'send', error: new RemoteError('gateway/internal', 'boom', {}) },
    })
    expect(other.view.getByRole('alert').textContent).toContain('boom (gateway/internal)')
  })

  it('marks the attachment slot unavailable while the composer is locked', () => {
    const result = bench({ addFiles: vi.fn(() => null), inert: true })
    expect(attachmentOwner(result.slotCalls).canAcceptDrop).toBe(false)
  })

  it('sends an image-only draft and exposes removal through the attachment slot', async () => {
    const file = new File([Uint8Array.of(1)], 'pixel.png', { type: 'image/png' })
    const extra = new File([Uint8Array.of(2)], 'extra.png', { type: 'image/png' })
    const attachments = [
      { kind: 'image' as const, id: 'draft-1' as DraftAttachmentId, file, previewUrl: 'blob:draft-1' },
      { kind: 'image' as const, id: 'draft-2' as DraftAttachmentId, file: extra, previewUrl: 'blob:draft-2' },
    ]
    const result = bench({ attachments })
    const { view, textarea, sink, removeAttachment } = result
    expect((view.getByRole('button', { name: '发送消息' }) as HTMLButtonElement).disabled).toBe(false)
    const owner = attachmentOwner(result.slotCalls)
    act(() => { owner.onRemoveAttachment('draft-2' as DraftAttachmentId) })
    expect(removeAttachment).toHaveBeenCalledWith('draft-2')
    let settle!: (outcome: SubmitOutcome) => void
    sink.mockImplementationOnce(() => new Promise<SubmitOutcome>((resolve) => { settle = resolve }))
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(sink).toHaveBeenCalledWith('', ['draft-1'], 'queue', expect.any(AbortSignal))
    // Optimistic commit: the rail clears at submit, before the admission settles.
    expect(attachmentOwner(result.slotCalls).attachments).toEqual([])
    await act(async () => { settle({ kind: 'success' }) })
    expect(attachmentOwner(result.slotCalls).attachments).toEqual([])
  })

  it('returns an image-only draft to the rail when its admission fails', async () => {
    const file = new File([Uint8Array.of(1)], 'pixel.png', { type: 'image/png' })
    const attachments = [
      { kind: 'image' as const, id: 'draft-1' as DraftAttachmentId, file, previewUrl: 'blob:draft-1' },
    ]
    const result = bench({ attachments })
    const { textarea, sink } = result
    let fail!: (outcome: SubmitOutcome) => void
    sink.mockImplementationOnce(() => new Promise<SubmitOutcome>((resolve) => { fail = resolve }))
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(attachmentOwner(result.slotCalls).attachments).toEqual([])
    await act(async () => { fail({ kind: 'error', text: '图片发送失败' }) })
    await vi.waitFor(() => {
      expect(attachmentOwner(result.slotCalls).attachments).toEqual([attachments[0]])
    })
    expect(result.view.getByRole('alert').textContent).toContain('图片发送失败')
  })

  it('announces an image-intake rejection as a fading toast, repeatable for the same reason', () => {
    vi.useFakeTimers()
    try {
      const addFiles = vi.fn(() => '仅支持 PNG、JPG、WebP、GIF 格式的图片')
      const { view, textarea } = bench({ addFiles })
      const paste = () => {
        fireEvent.paste(textarea, {
          clipboardData: {
            items: [{ kind: 'file', type: 'text/plain', getAsFile: () => new File(['x'], 'note.txt', { type: 'text/plain' }) }],
            getData: () => '',
          },
        })
      }
      paste()
      expect(view.getByRole('alert').textContent).toContain('仅支持 PNG、JPG、WebP、GIF 格式的图片')
      act(() => { vi.advanceTimersByTime(4000) })
      expect(view.queryByRole('alert')).toBeNull()
      // The identical rejection re-announces: the toast is keyed per show.
      paste()
      expect(view.getByRole('alert').textContent).toContain('仅支持 PNG、JPG、WebP、GIF 格式的图片')
    } finally {
      vi.useRealTimers()
    }
  })

  it('announces a rejected attachment-slot intake through the same toast', () => {
    const addFiles = vi.fn(() => '图片读取服务不可用')
    const result = bench({ addFiles })
    act(() => {
      attachmentOwner(result.slotCalls).onAddFiles([
        new File([Uint8Array.of(1)], 'x.png', { type: 'image/png' }),
      ])
    })
    expect(result.view.getByRole('alert').textContent).toContain('图片读取服务不可用')
  })
})

describe('Enter semantics', () => {
  it('advertises the empty-draft whole-queue steering gesture when it is available', () => {
    const { placeholder } = bench({ running: true, queue: [row('q-1')], steerQueue: vi.fn() })
    expect(placeholder).toBe('Cmd/Ctrl+Enter 插话发送全部排队消息')
    expect(bench({
      running: true,
      queue: [row('q-1')],
      subagent: {
        address: { parentSessionId: 'parent' as SessionId, childSessionId: SID, mode: 'continuable' },
        parentAvailable: true,
      },
    }).placeholder).toBe('Cmd/Ctrl+Enter 插话发送全部排队消息')
  })

  it('keeps the owning placeholder or ordinary guidance when whole-queue steering is unavailable', () => {
    expect(bench({ running: true }).placeholder).toBe('发消息或做任务… / 调用指令 @ 文件或对话')
    expect(bench({ queue: [row('q-1')] }).placeholder).toBe('发消息或做任务… / 调用指令 @ 文件或对话')
    expect(bench({ running: true, queue: [row('q-1')], draft: '消息' }).placeholder).toBe('发消息或做任务… / 调用指令 @ 文件或对话')
    expect(bench({
      running: true,
      queue: [row('q-1')],
      placeholder: '上层指定提示',
    }).placeholder).toBe('上层指定提示')
    // The command menu owns Enter while open: neither the hint nor the
    // gesture may claim the chord.
    expect(bench({
      running: true,
      queue: [row('q-1')],
      commandMenuOpen: true,
    }).placeholder).toBe('发消息或做任务… / 调用指令 @ 文件或对话')
    // The steer hint intentionally outranks the plan placeholder: while it
    // shows, the whole-queue gesture is genuinely available in plan mode.
    expect(bench({
      running: true,
      queue: [row('q-1')],
      plan: { active: true, pending: false },
    }).placeholder).toBe('Cmd/Ctrl+Enter 插话发送全部排队消息')
  })

  it('an open command menu withholds the whole-queue steering gesture', () => {
    const steerQueue = vi.fn()
    const { textarea, sink } = bench({
      running: true,
      queue: [row('q-1')],
      commandMenuOpen: true,
      steerQueue,
    })
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true })
    expect(steerQueue).not.toHaveBeenCalled()
    expect(sink).not.toHaveBeenCalled()
  })

  it('plain Enter submits queue mode through the machine; repeat and empty are suppressed', () => {
    const { textarea, sink } = bench({ draft: 'hello' })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(sink).toHaveBeenCalledWith('hello', [], 'queue', expect.any(AbortSignal))
    // The submitting-phase lock, not draft emptiness, suppresses the repeat:
    // the draft is still uncleared while the sink round-trip is in flight.
    fireEvent.keyDown(textarea, { key: 'Enter', repeat: true })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(sink).toHaveBeenCalledTimes(1)
    const empty = bench({ draft: '   ' })
    fireEvent.keyDown(empty.textarea, { key: 'Enter' })
    expect(empty.sink).not.toHaveBeenCalled()
  })

  it('non-Enter keys and Shift+Enter fall through to native behavior', () => {
    const { textarea, sink } = bench({ draft: 'hello' })
    fireEvent.keyDown(textarea, { key: 'a' })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })
    expect(sink).not.toHaveBeenCalled()
  })

  it('Shift+Enter newline wins even inside IME composition (unconditional precedence)', () => {
    const { textarea, sink } = bench({ draft: 'hello' })
    fireEvent.compositionStart(textarea)
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })
    expect(sink).not.toHaveBeenCalled() // and not preventDefault'd: native newline
  })

  it('Ctrl/Meta+Enter sends normally while idle and steers while running', () => {
    const idle = bench({ draft: 'hello' })
    fireEvent.keyDown(idle.textarea, { key: 'Enter', metaKey: true })
    expect(idle.sink).toHaveBeenCalledWith('hello', [], 'queue', expect.any(AbortSignal))

    const busyCtrl = bench({ running: true, draft: 'steer with ctrl' })
    fireEvent.keyDown(busyCtrl.textarea, { key: 'Enter', ctrlKey: true })
    expect(busyCtrl.sink).toHaveBeenCalledWith('steer with ctrl', [], 'steer', expect.any(AbortSignal))

    const busyMeta = bench({ running: true, draft: 'steer with cmd' })
    fireEvent.keyDown(busyMeta.textarea, { key: 'Enter', metaKey: true })
    expect(busyMeta.sink).toHaveBeenCalledWith('steer with cmd', [], 'steer', expect.any(AbortSignal))
  })

  it('empty-draft Cmd/Ctrl+Enter steers the whole queue instead of submitting', () => {
    const steerQueue = vi.fn()
    const queue = [row('q-1'), row('q-2')]
    const meta = bench({ running: true, queue, steerQueue })
    fireEvent.keyDown(meta.textarea, { key: 'Enter', metaKey: true })
    expect(meta.steerQueue).toHaveBeenCalledTimes(1)
    expect(meta.sink).not.toHaveBeenCalled()

    const ctrl = bench({ running: true, queue, steerQueue: vi.fn() })
    fireEvent.keyDown(ctrl.textarea, { key: 'Enter', ctrlKey: true })
    expect(ctrl.steerQueue).toHaveBeenCalledTimes(1)
    expect(ctrl.sink).not.toHaveBeenCalled()
  })

  it('queue steering stays gated by activity, gesture, capability, and queued rows', () => {
    // Idle: the gesture falls through to the machine's empty-draft no-op.
    const idle = bench({ queue: [row('q-1')], steerQueue: vi.fn() })
    fireEvent.keyDown(idle.textarea, { key: 'Enter', metaKey: true })
    expect(idle.steerQueue).not.toHaveBeenCalled()
    expect(idle.sink).not.toHaveBeenCalled()

    // Plain Enter never steers the queue, even under the busy Steer preference.
    const plain = bench({ running: true, busyEnter: 'steer', queue: [row('q-1')], steerQueue: vi.fn() })
    fireEvent.keyDown(plain.textarea, { key: 'Enter' })
    expect(plain.steerQueue).not.toHaveBeenCalled()
    expect(plain.sink).not.toHaveBeenCalled()

    // Continuable children expose the same steering face as ordinary Sessions.
    const subagent = {
      address: {
        parentSessionId: 'parent' as SessionId,
        childSessionId: SID,
        mode: 'continuable' as const,
      },
      parentAvailable: true,
    }
    const childSteerQueue = vi.fn()
    const child = bench({ running: true, subagent, queue: [row('q-1')], steerQueue: childSteerQueue })
    fireEvent.keyDown(child.textarea, { key: 'Enter', metaKey: true })
    expect(childSteerQueue).toHaveBeenCalledTimes(1)
    expect(child.sink).not.toHaveBeenCalled()

    // No queued rows: the empty draft stays a no-op.
    const none = bench({ running: true, steerQueue: vi.fn() })
    fireEvent.keyDown(none.textarea, { key: 'Enter', metaKey: true })
    expect(none.steerQueue).not.toHaveBeenCalled()
    expect(none.sink).not.toHaveBeenCalled()

    // Pending steering rows are not the queue: nothing to flush.
    const steering = bench({
      running: true,
      queue: [{ ...row('s-1'), placement: 'steering' }],
      steerQueue: vi.fn(),
    })
    fireEvent.keyDown(steering.textarea, { key: 'Enter', metaKey: true })
    expect(steering.steerQueue).not.toHaveBeenCalled()
    expect(steering.sink).not.toHaveBeenCalled()
  })

  it('draft content outranks the queue: accelerated Enter steers the draft only', () => {
    const steerQueue = vi.fn()
    const { textarea, sink } = bench({ running: true, queue: [row('q-1')], draft: '插话', steerQueue })
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })
    expect(sink).toHaveBeenCalledWith('插话', [], 'steer', expect.any(AbortSignal))
    expect(steerQueue).not.toHaveBeenCalled()
  })

  it('empty-draft accelerated Enter without a steerQueue face stays a silent no-op', () => {
    const { textarea, sink } = bench({ running: true, queue: [row('q-1')] })
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true })
    expect(sink).not.toHaveBeenCalled()
  })

  it('platform undo/redo chords drive the Lexical history stack, never the browser one', () => {
    const { textarea, shell } = bench({ draft: '' })
    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })
    writeDraft(shell, 'first')
    vi.advanceTimersByTime(1100) // beyond the history merge window: a separate undo step
    act(() => {
      shell.editor.update(() => {
        const first = $getRoot().getAllTextNodes()[0]
        if ($isTextNode(first)) first.select(5, 5).insertText(' second')
      }, { discrete: true })
    })
    expect(shell.snapshot.draft).toBe('first second')
    // Lexical's chord detection reads keyCode (90 = z); a history restore
    // commits on the next flush (setEditorState defers inside the command
    // update).
    const flush = (): void => { act(() => { shell.editor.update(() => {}, { discrete: true }) }) }
    fireEvent.keyDown(textarea, { key: 'z', keyCode: 90, ctrlKey: true })
    flush()
    expect(shell.snapshot.draft).toBe('first')
    fireEvent.keyDown(textarea, { key: 'z', keyCode: 90, ctrlKey: true, shiftKey: true })
    flush()
    expect(shell.snapshot.draft).toBe('first second')
  })

  it('a paste inside the typing merge window is its own undo step', async () => {
    const { textarea, shell } = bench({ draft: '' })
    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })
    writeDraft(shell, 'typed')
    vi.advanceTimersByTime(1100) // separate the seed from the typing step
    act(() => {
      shell.editor.update(() => {
        const first = $getRoot().getAllTextNodes()[0]
        if ($isTextNode(first)) first.select(5, 5).insertText(' one')
      }, { discrete: true })
    })
    // No timer advance: the paste lands inside the history merge window, and
    // PASTE_TAG still gives it its own undo entry. The paste commits inside
    // the PASTE_COMMAND update, a microtask away.
    fireEvent.paste(textarea, {
      clipboardData: { items: [], getData: () => ' two' },
    })
    await vi.waitFor(() => { expect(shell.snapshot.draft).toBe('typed one two') })
    const flush = (): void => { act(() => { shell.editor.update(() => {}, { discrete: true }) }) }
    fireEvent.keyDown(textarea, { key: 'z', keyCode: 90, ctrlKey: true })
    flush()
    expect(shell.snapshot.draft).toBe('typed one')
  })

  it('caret-only commits advance neither draftRev nor the published state', () => {
    const { shell } = bench({ draft: 'hello' })
    const before = shell.snapshot
    act(() => {
      shell.editor.update(() => {
        const first = $getRoot().getAllTextNodes()[0]
        if ($isTextNode(first)) first.select(1, 1)
      }, { discrete: true })
    })
    expect(shell.snapshot).toBe(before) // publish skipped: the snapshot reference is unchanged
    act(() => {
      shell.editor.update(() => {
        const first = $getRoot().getAllTextNodes()[0]
        if ($isTextNode(first)) first.select(1, 1).insertText('x')
      }, { discrete: true })
    })
    expect(shell.snapshot.draftRev).toBe(before.draftRev + 1)
    expect(shell.snapshot.draft).toBe('hxello')
  })

  it('composition Enter never sends: ref guard, isComposing, and keyCode 229 paths', () => {
    vi.useFakeTimers()
    try {
      const { textarea, sink } = bench({ draft: 'hello' })
      fireEvent.compositionStart(textarea)
      fireEvent.keyDown(textarea, { key: 'Enter' })
      expect(sink).not.toHaveBeenCalled()
      fireEvent.compositionEnd(textarea)
      // Safari delivers the closing keydown before the deferred clear.
      fireEvent.keyDown(textarea, { key: 'Enter' })
      expect(sink).not.toHaveBeenCalled()
      vi.advanceTimersByTime(20)
      fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 229 })
      expect(sink).not.toHaveBeenCalled()
      fireEvent.keyDown(textarea, { key: 'Enter' })
      expect(sink).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('running and lock semantics', () => {
  it('running switches the primary between Stop and Queue Send with the draft', async () => {
    const { textarea, button, stop, sink, shell } = bench({ running: true, busyEnter: 'steer' })
    expect(textarea.getAttribute('aria-disabled')).not.toBe('true')
    expect(button.getAttribute('aria-label')).toBe('停止生成')
    fireEvent.click(button)
    expect(stop).toHaveBeenCalledTimes(1)

    writeDraft(shell, '排队消息')
    expect(button.getAttribute('aria-label')).toBe('发送消息')
    writeDraft(shell, '   ')
    expect(button.getAttribute('aria-label')).toBe('停止生成')
    writeDraft(shell, '排队消息2')
    expect(button.getAttribute('aria-label')).toBe('发送消息')
    fireEvent.click(button)
    expect(sink).toHaveBeenCalledWith('排队消息2', [], 'queue', expect.any(AbortSignal))
    await vi.waitFor(() => { expect(button.getAttribute('aria-label')).toBe('停止生成') })
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('running treats an attachment-only draft as Send', async () => {
    const attachment = {
      kind: 'image' as const,
      id: 'draft-1' as DraftAttachmentId,
      file: new File([Uint8Array.of(1)], 'pixel.png', { type: 'image/png' }),
      previewUrl: 'blob:pixel',
    }
    const { button, sink } = bench({ running: true, attachments: [attachment] })
    expect(button.getAttribute('aria-label')).toBe('发送消息')
    fireEvent.click(button)
    expect(sink).toHaveBeenCalledWith('', ['draft-1'], 'queue', expect.any(AbortSignal))
    await vi.waitFor(() => { expect(button.getAttribute('aria-label')).toBe('停止生成') })
  })

  it('running blocked composer keeps Stop with a retained draft', () => {
    const { button, sink, stop, textarea } = bench({
      running: true,
      draft: '保留的草稿',
      blocked: { reason: '请选择可用模型' },
      placeholder: '请选择可用模型',
    })
    expect(textarea.getAttribute('aria-disabled')).toBe('true')
    expect(textarea.getAttribute('data-placeholder')).toBe('请选择可用模型')
    expect(button.getAttribute('aria-label')).toBe('停止生成')
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(sink).not.toHaveBeenCalled()
  })

  it('running plain Enter follows the busy-state Steer preference', () => {
    const { textarea, sink } = bench({ running: true, busyEnter: 'steer', draft: '直接插话' })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(sink).toHaveBeenCalledWith('直接插话', [], 'steer', expect.any(AbortSignal))
  })

  it('running Cmd/Ctrl+Enter uses the opposite of the busy-state Enter preference', () => {
    const meta = bench({ running: true, busyEnter: 'steer', draft: '排到下一轮' })
    fireEvent.keyDown(meta.textarea, { key: 'Enter', metaKey: true })
    expect(meta.sink).toHaveBeenCalledWith('排到下一轮', [], 'queue', expect.any(AbortSignal))

    const ctrl = bench({ running: true, busyEnter: 'steer', draft: 'also queue' })
    fireEvent.keyDown(ctrl.textarea, { key: 'Enter', ctrlKey: true })
    expect(ctrl.sink).toHaveBeenCalledWith('also queue', [], 'queue', expect.any(AbortSignal))
  })

  it('running continuable subagent keeps Send beside an independent Stop', () => {
    const { button, interruptButton, textarea, sink, stop, view, slotCalls } = bench({
      running: true,
      draft: '后续消息',
      subagent: {
        address: {
          parentSessionId: 'parent' as SessionId,
          childSessionId: SID,
          mode: 'continuable',
        },
        parentAvailable: true,
      },
    })
    expect(button.getAttribute('aria-label')).toBe('发送消息')
    expect(interruptButton).not.toBeNull()
    expect(textarea.getAttribute('aria-disabled')).not.toBe('true')
    expect((view.getByLabelText('添加附件') as HTMLButtonElement).disabled).toBe(true)
    expect(view.container.querySelector<HTMLInputElement>('input[type="file"]')?.disabled).toBe(true)
    expect(attachmentOwner(slotCalls).canAcceptDrop).toBe(false)
    fireEvent.click(button)
    expect(sink).toHaveBeenCalledWith('后续消息', [], 'queue', expect.any(AbortSignal))
    fireEvent.click(interruptButton!)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['active plan', { plan: { active: true, pending: false } }],
    ['active goal', { goal: { phase: 'active' as const, objective: 'inspect files' } }],
  ])('%s keeps ordinary generic-file intake enabled', (_name, projection) => {
    const added = vi.fn(() => null)
    const { view, slotCalls } = bench({ ...projection, addFiles: added })
    expect((view.getByLabelText('添加附件') as HTMLButtonElement).disabled).toBe(false)
    expect(view.container.querySelector<HTMLInputElement>('input[type="file"]')?.disabled).toBe(false)
    expect(attachmentOwner(slotCalls).canAcceptDrop).toBe(true)
  })

  it('parent-offline running continuable locks Send but keeps independent Stop usable', () => {
    const { button, interruptButton, textarea, stop, view } = bench({
      running: true,
      draft: '',
      subagent: {
        address: {
          parentSessionId: 'parent' as SessionId,
          childSessionId: SID,
          mode: 'continuable',
        },
        parentAvailable: false,
      },
    })
    expect(textarea.getAttribute('aria-disabled')).toBe('true')
    expect(placeholderOf(view.container)).toBe('父会话已离线，无法继续发送；仍可停止当前运行')
    expect((view.getByLabelText('指令') as HTMLButtonElement).disabled).toBe(true)
    expect(button.getAttribute('aria-label')).toBe('发送消息')
    expect(button.disabled).toBe(true)
    expect(interruptButton?.disabled).toBe(false)
    fireEvent.click(interruptButton!)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('running one-shot subagent never exposes Stop', () => {
    const { button, interruptButton, stop } = bench({
      running: true,
      draft: '不可停止',
      subagent: {
        address: {
          parentSessionId: 'parent' as SessionId,
          childSessionId: SID,
          mode: 'one-shot',
        },
        parentAvailable: true,
      },
    })
    expect(button.getAttribute('aria-label')).toBe('发送消息')
    expect(interruptButton).toBeNull()
    expect(stop).not.toHaveBeenCalled()
  })

  it('applies the ordinary Queue/Steer preference to a running continuable child', () => {
    const subagent = {
      address: {
        parentSessionId: 'parent' as SessionId,
        childSessionId: SID,
        mode: 'continuable' as const,
      },
      parentAvailable: true,
    }
    const plain = bench({ running: true, busyEnter: 'steer', draft: 'plain', subagent })
    fireEvent.keyDown(plain.textarea, { key: 'Enter' })
    expect(plain.sink).toHaveBeenCalledWith('plain', [], 'steer', expect.any(AbortSignal))

    const accelerated = bench({ running: true, draft: 'accelerated', subagent })
    fireEvent.keyDown(accelerated.textarea, { key: 'Enter', metaKey: true })
    expect(accelerated.sink).toHaveBeenCalledWith('accelerated', [], 'steer', expect.any(AbortSignal))

    const opposite = bench({ running: true, busyEnter: 'steer', draft: 'opposite', subagent })
    fireEvent.keyDown(opposite.textarea, { key: 'Enter', metaKey: true })
    expect(opposite.sink).toHaveBeenCalledWith('opposite', [], 'queue', expect.any(AbortSignal))
  })

  it('disabled (session removed) locks the textarea and chrome', () => {
    const { textarea, view } = bench({ disabled: true })
    expect(textarea.getAttribute('aria-disabled')).toBe('true')
    expect(placeholderOf(view.container)).toBe('会话不可用')
    expect((view.getByLabelText('指令') as HTMLButtonElement).disabled).toBe(true)
  })

  it('idle primary sends and disables on empty draft', () => {
    const { button, sink } = bench({ draft: 'go' })
    fireEvent.click(button)
    expect(sink).toHaveBeenCalledWith('go', [], 'queue', expect.any(AbortSignal))
    const empty = bench()
    expect(empty.button.disabled).toBe(true)
  })

  it('unlock refocuses the surface; mousedown on the button keeps focus', () => {
    const first = bench({ disabled: true, draft: 'x' })
    const textarea = first.view.container.querySelector<HTMLDivElement>('[data-composer-input]')!
    const focused: (boolean | undefined)[] = []
    textarea.focus = (options?: FocusOptions) => { focused.push(options?.preventScroll) }
    act(() => { first.session.set(snapshotOf({ removed: false })) })
    expect(focused).toEqual([true])
    fireEvent.mouseDown(first.view.container.querySelector('button[aria-label="发送消息"]')!)
    expect(focused).toEqual([true, true])
  })

  it('a programmatic draft write echoes back through the state and the editor DOM', () => {
    const { textarea, wiring, shell } = bench()
    writeDraft(shell, 'typed')
    expect(wiring.state.getSnapshot().draft).toBe('typed')
    expect(textarea.textContent).toBe('typed')
  })

  it('wheel over a non-overflowing draft forwards to the conversation host', () => {
    const host = document.createElement('div')
    host.setAttribute('data-conversation-scroll', '')
    Object.defineProperty(host, 'scrollTop', { value: 40, writable: true, configurable: true })
    const { view, textarea } = bench()
    host.appendChild(view.container)
    document.body.appendChild(host)
    try {
      const wheeled = fireEvent.wheel(textarea, { deltaY: 30 })
      expect(wheeled).toBe(false) // preventDefault
      expect(host.scrollTop).toBe(70)
    } finally {
      host.remove()
    }
  })

  it('wheel chains: long drafts scroll inside the draft scrollport until each edge, then the host', () => {
    const host = document.createElement('div')
    host.setAttribute('data-conversation-scroll', '')
    Object.defineProperty(host, 'scrollTop', { value: 40, writable: true, configurable: true })
    const { view, textarea } = bench()
    host.appendChild(view.container)
    document.body.appendChild(host)
    const scrollport = view.container.querySelector<HTMLElement>('[data-input-scroll]')!
    Object.defineProperty(scrollport, 'clientHeight', { value: 100, configurable: true })
    Object.defineProperty(scrollport, 'scrollHeight', { value: 400, configurable: true })
    let scrollTop = 150
    Object.defineProperty(scrollport, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value },
    })
    try {
      // Mid-draft: both directions stay local — host must not move.
      expect(fireEvent.wheel(textarea, { deltaY: 30 })).toBe(true)
      expect(fireEvent.wheel(textarea, { deltaY: -30 })).toBe(true)
      expect(host.scrollTop).toBe(40)
      // At the bottom edge, further down-scroll forwards to the host.
      scrollTop = 300
      expect(fireEvent.wheel(textarea, { deltaY: 30 })).toBe(false)
      expect(host.scrollTop).toBe(70)
      // At the top edge, further up-scroll forwards to the host.
      scrollTop = 0
      host.scrollTop = 70
      expect(fireEvent.wheel(textarea, { deltaY: -20 })).toBe(false)
      expect(host.scrollTop).toBe(50)
    } finally {
      host.remove()
    }
  })

  it('one editable surface rides the scrollport (no mirror or backdrop layers)', () => {
    const { view, textarea } = bench({ draft: 'line\n'.repeat(40).trimEnd() })
    const scroll = view.container.querySelector<HTMLElement>('[data-input-scroll]')!
    expect(scroll.contains(textarea)).toBe(true)
    // The three-layer stack is gone: the editable surface owns glyphs, caret,
    // and height at once.
    expect(view.container.querySelector('[data-input-backdrop]')).toBeNull()
    expect(view.container.querySelector('[data-input-mirror]')).toBeNull()
    // DOM textContent joins paragraphs without separators; the projection
    // carries the newlines.
    expect(textarea.textContent).toBe('line'.repeat(40))
    expect(bench({ draft: 'a\nb' }).shell.snapshot.draft).toBe('a\nb')
  })

  it('a session switch refocuses the editable surface with preventScroll', () => {
    const { view, textarea, props } = bench({ draft: 'line one' })
    const focused: (boolean | undefined)[] = []
    textarea.focus = (options?: FocusOptions) => { focused.push(options?.preventScroll) }
    act(() => { view.rerender(<InputBar {...props} sessionId={'s2' as SessionId} />) })
    expect(focused).toEqual([true])
  })

  it('a persisted draft adopted after mount does not steal focus from another control', () => {
    const { shell } = bench()
    const other = document.createElement('input')
    document.body.appendChild(other)
    onTestFinished(() => { other.remove() })
    other.focus()
    act(() => { shell.setDraft('restored\n'.repeat(40)) })
    expect(document.activeElement).toBe(other)
    expect(shell.snapshot.draft).toBe('restored\n'.repeat(40))
  })

  it('disabled state shows the unavailable placeholder; custom placeholder wins', () => {
    expect(bench({ disabled: true }).placeholder).toBe('会话不可用')
    const live = bench()
    expect(live.placeholder).toBe('发消息或做任务… / 调用指令 @ 文件或对话')
    const custom = bench({ placeholder: 'Custom placeholder' })
    expect(custom.placeholder).toBe('Custom placeholder')
  })

  it('the inert textarea opens the Workspace picker by pointer or keyboard', () => {
    const onRequestWorkspace = vi.fn()
    const { view, textarea } = bench({
      inert: true,
      workspacePickerOpen: false,
      onRequestWorkspace,
      placeholder: '选择一个工作区开始',
    })
    expect(textarea.getAttribute('aria-disabled')).not.toBe('true')
    expect(editableOf(textarea)).toBe(false)
    expect(textarea.getAttribute('aria-haspopup')).toBe('menu')
    expect(textarea.getAttribute('aria-expanded')).toBe('false')
    expect((view.getByLabelText('指令') as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(textarea)
    fireEvent.keyDown(textarea, { key: 'Enter' })
    fireEvent.keyDown(textarea, { key: ' ' })
    expect(onRequestWorkspace).toHaveBeenCalledTimes(3)

    // The WHOLE capsule is the pick target, and its pointerdown never reaches
    // the document — the open picker's outside-close must not race the reopen.
    const card = view.container.querySelector('[data-composer-card]') as HTMLElement
    fireEvent.click(card)
    expect(onRequestWorkspace).toHaveBeenCalledTimes(4)
    const onDocumentPointerDown = vi.fn()
    document.addEventListener('pointerdown', onDocumentPointerDown)
    try {
      fireEvent.pointerDown(card)
    } finally {
      document.removeEventListener('pointerdown', onDocumentPointerDown)
    }
    expect(onDocumentPointerDown).not.toHaveBeenCalled()
  })

  it('the plan projection swaps the placeholder while its effective target is plan mode', () => {
    const active = bench({ plan: { active: true, pending: false } })
    expect(active.placeholder).toBe('描述你的任务以生成计划')
    // /plan just ran: pending entry already reads as the plan target.
    const entering = bench({ plan: { active: false, pending: true } })
    expect(entering.placeholder).toBe('描述你的任务以生成计划')
    // Pending exit: target is default again.
    const leaving = bench({ plan: { active: true, pending: true } })
    expect(leaving.placeholder).toBe('发消息或做任务… / 调用指令 @ 文件或对话')
    // Owner placeholder outranks the plan swap.
    const custom = bench({ plan: { active: true, pending: false }, placeholder: 'Custom placeholder' })
    expect(custom.placeholder).toBe('Custom placeholder')
  })
})

describe('machine pending lock', () => {
  it('submitting renders read-only textarea, pending dot, and a disabled primary', () => {
    const { view, shell } = bench()
    // Drive the machine into submitting through a claim + enter.
    act(() => {
      shell.setDraft('/goal ')
      shell.beginCommand(
        {
          token: '/goal ',
          submit: () => new Promise<never>(() => {}), // never settles: stays submitting
        },
        { start: 0, end: 6, draftRev: shell.snapshot.draftRev },
      )
      shell.submit()
    })
    expect(shell.snapshot.phase).toBe('submitting')
    const textarea = view.container.querySelector<HTMLDivElement>('[data-composer-input]')!
    expect(editableOf(textarea)).toBe(false)
    expect(view.container.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]')!.disabled).toBe(true)
  })
})

describe('decorations', () => {
  /** The claim-token styled leaf (the transform's inline warn color). */
  function tokenSpanOf(container: HTMLElement): HTMLElement | null {
    return container.querySelector('[data-lexical-text][style*="warn-label"]')
  }

  it('claimed token styles the leading leaf and sets the blank-args hint variable', () => {
    // Dictionary-less stub: an unmatched hint key keeps the machine's raw hint.
    const { view, shell, textarea } = bench({ t: makeTranslate({}) })
    act(() => {
      shell.setDraft('/goal ')
      shell.beginCommand(
        { token: '/goal ', hint: '目标内容', submit: () => Promise.resolve({ kind: 'success' as const }) },
        { start: 0, end: 6, draftRev: shell.snapshot.draftRev },
      )
      shell.editor.update(() => {}, { discrete: true }) // flush the queued decoration refresh
    })
    expect(tokenSpanOf(view.container)?.textContent).toBe('/goal ')
    expect(textarea.style.getPropertyValue('--dsh-composer-hint')).toBe(JSON.stringify('目标内容'))
    // Args typed: the hint disappears, the token style stays.
    act(() => { shell.setDraft('/goal 发布') })
    act(() => { shell.editor.update(() => {}, { discrete: true }) }) // flush the queued decoration refresh
    expect(textarea.style.getPropertyValue('--dsh-composer-hint')).toBe('')
    expect(tokenSpanOf(view.container)).not.toBeNull()
  })

  it('a locale entry for the claimed command overrides the raw claim hint (trailing-space token)', () => {
    const { shell, textarea } = bench()
    act(() => {
      shell.setDraft('/goal ')
      shell.beginCommand(
        { token: '/goal ', hint: '[<objective>|clear|edit <objective>|pause|resume]', submit: () => Promise.resolve({ kind: 'success' as const }) },
        { start: 0, end: 6, draftRev: shell.snapshot.draftRev },
      )
    })
    expect(textarea.style.getPropertyValue('--dsh-composer-hint')).toBe(JSON.stringify('输入目标，智能体将持续执行'))
  })

  it('an inserted reference renders a real chip capsule with its icon and label', () => {
    const { view, shell } = bench()
    const reference = {
      source: 'reference', ref: 'w1', label: '会话一', appearance: 'session' as const, clipboardText: '@w1',
    }
    act(() => {
      shell.setDraft('参考 @w1 内容')
      shell.insertReference(
        reference,
        { start: 3, end: 6, draftRev: shell.snapshot.draftRev },
      )
    })
    const chip = view.container.querySelector('[data-composer-chip]')
    expect(chip?.textContent).toBe('会话一')
    expect(chip?.querySelector('svg')).not.toBeNull()
    expect(chip?.getAttribute('contenteditable')).toBe('false')
    expect(shell.snapshot.occurrences).toHaveLength(1)
    // The draft IS the clipboard projection; the label lives in the chip DOM.
    expect(shell.snapshot.draft).toBe('参考 @w1 内容')
    expect(shell.snapshot.occurrences[0]).toMatchObject({ offset: 3, length: 3 })
  })

  it('keeps the chip decorator mounted when the session becomes disabled', () => {
    const { view, shell, session, textarea } = bench()
    act(() => {
      shell.setDraft('@w1')
      shell.insertReference({
        source: 'reference', ref: 'w1', label: '会话一', appearance: 'session', clipboardText: '@w1',
      }, { start: 0, end: 3, draftRev: shell.snapshot.draftRev })
    })
    const chip = view.container.querySelector('[data-composer-chip]')
    expect(chip?.querySelector('svg')).not.toBeNull()
    act(() => { session.set(snapshotOf({ removed: true })) })
    expect(textarea.getAttribute('aria-disabled')).toBe('true')
    expect(view.container.querySelector('[data-composer-chip]')).toBe(chip)
  })

  it('a chip leaves the document as one unit (keyboard deletion is asserted in the browser lane)', () => {
    // jsdom lacks the non-standard Selection.modify Lexical's character
    // deletion crosses nodes with, so the Backspace/Delete gesture itself is
    // an e2e assertion; the structural unit — one span covering the chip
    // removes the whole occurrence — is checkable here.
    const { shell } = bench()
    act(() => {
      shell.setDraft('前 @w1 后')
      shell.insertReference({
        source: 'reference', ref: 'w1', label: '会话一', appearance: 'session', clipboardText: '@w1',
      }, { start: 2, end: 5, draftRev: shell.snapshot.draftRev })
    })
    expect(shell.snapshot.occurrences).toHaveLength(1)
    act(() => {
      shell.editor.update(() => {
        expect($replaceDetectSpanWithText({ start: 2, end: 3 }, '')).toBe(true)
      }, { discrete: true })
    })
    expect(shell.snapshot).toMatchObject({ draft: '前  后', occurrences: [] })
  })

  it('copy and cut expand a selected chip to its clipboard projection natively', async () => {
    const { shell, textarea } = bench()
    act(() => {
      shell.setDraft('前 @w1 后')
      shell.insertReference({
        source: 'reference', ref: 'w1', label: '会话一', appearance: 'session', clipboardText: '@w1',
      }, { start: 2, end: 5, draftRev: shell.snapshot.draftRev })
      // Select the chip plus its flanking spaces: detect [1, 4).
      shell.editor.update(() => { $selectDetectSpan({ start: 1, end: 4 }) }, { discrete: true })
    })
    const setData = vi.fn()
    fireEvent.copy(textarea, { clipboardData: { setData, getData: () => '' } })
    expect(setData).toHaveBeenCalledWith('text/plain', ' @w1 ')
    expect(shell.snapshot.draft).toBe('前 @w1 后')

    act(() => {
      shell.editor.update(() => { $selectDetectSpan({ start: 1, end: 4 }) }, { discrete: true })
    })
    fireEvent.cut(textarea, { clipboardData: { setData, getData: () => '' } })
    await vi.waitFor(() => {
      expect(shell.snapshot).toMatchObject({ draft: '前后', occurrences: [] })
    })
    expect(setData).toHaveBeenLastCalledWith('text/plain', ' @w1 ')
  })

  it('a lexicon-matched plain token renders the text-ref node', () => {
    const lexicon = new Map<'/' | '@', readonly string[]>([['/', ['fixture-demo']]])
    const { view, shell } = bench({ lexicon })
    act(() => { shell.setDraft('use /fixture-demo now') })
    const mark = view.container.querySelector('[data-composer-text-ref]')
    expect(mark?.textContent).toBe('/fixture-demo')
    // Editing the token out of match shape drops the decoration.
    act(() => { shell.setDraft('use /fixture-dem now') })
    expect(view.container.querySelector('[data-composer-text-ref]')).toBeNull()
  })

  it('a directory completion decorates color-only: literal text, no icon seat', () => {
    const { view, shell } = bench()
    act(() => { shell.setDraft('see @src/components/') })
    const mark = view.container.querySelector('[data-composer-text-ref]')
    expect(mark?.textContent).toBe('@src/components/')
    // The trigger character marks editable text; the domain icon is the
    // settled chip's alone.
    expect(mark?.getAttribute('data-ref-appearance')).toBeNull()
    expect(shell.snapshot.draft).toBe('see @src/components/')
  })

  it('a plain-text reference keeps its DOM node while typing ahead of it (bug #2793 regression)', () => {
    const { view, shell } = bench()
    act(() => { shell.setDraft('see @src/components/ here') })
    const mark = view.container.querySelector('[data-composer-text-ref]')!
    // Type ahead through the node API (the transaction path typing takes).
    act(() => {
      shell.editor.update(() => {
        const first = $getRoot().getAllTextNodes()[0]
        if ($isTextNode(first)) first.spliceText(0, 0, 'X ')
      }, { discrete: true })
    })
    // Node identity, not text: the entity node survives edits ahead of it.
    expect(view.container.querySelector('[data-composer-text-ref]')).toBe(mark)
    expect(mark.textContent).toBe('@src/components/')
    expect(shell.snapshot.draft).toBe('X see @src/components/ here')
    // A token edited out of match shape still loses its decoration.
    act(() => { shell.setDraft('X see X@src/components/ here') })
    expect(view.container.querySelector('[data-composer-text-ref]')).toBeNull()
  })
})

describe('insertText (scoped event body)', () => {
  it('splices plain text over the span and reports success as true', () => {
    const { shell } = bench({ draft: '/fix' })
    const ok = shell.insertText('/fixture-demo ', { start: 0, end: 4, draftRev: shell.snapshot.draftRev })
    expect(ok).toBe(true)
    expect(shell.snapshot.draft).toBe('/fixture-demo ')
    expect(shell.snapshot.occurrences).toEqual([])
  })

  it('a stale draftRev refuses whole: false, draft untouched', () => {
    const { shell } = bench({ draft: '/fix' })
    const span = { start: 0, end: 4, draftRev: shell.snapshot.draftRev }
    act(() => { shell.setDraft('/fixX') })
    expect(shell.insertText('/fixture-demo ', span)).toBe(false)
    expect(shell.snapshot.draft).toBe('/fixX')
  })
})

describe('strips and variants', () => {
  it('announces promptError as a fading toast (ordinary failure — no transaction UI, no Retry)', () => {
    vi.useFakeTimers()
    try {
      const send = bench({
        promptError: { op: 'send', error: new RemoteError('session/agent-busy', 'boom', { reason: 'boom' }) },
      })
      // The toast body-portals (transformed ancestors must not trap it), so
      // queries go through the view's document-bound helpers.
      expect(send.view.getByRole('alert').textContent).toContain('boom (session/agent-busy)')
      expect(send.view.queryByRole('button', { name: 'Retry' })).toBeNull()
      act(() => { vi.advanceTimersByTime(4000) })
      expect(send.view.queryByRole('alert')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('announces an error notice from the machine store as a fading toast', () => {
    vi.useFakeTimers()
    try {
      const { view, shell } = bench()
      act(() => { shell.notify('error', '命令失败了') })
      expect(view.getByRole('alert').textContent).toContain('命令失败了')
      expect(view.queryByRole('status')).toBeNull()
      act(() => { vi.advanceTimersByTime(4000) })
      expect(view.queryByRole('alert')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('renders an information notice from the machine store as a status strip', () => {
    const { view, shell } = bench()
    act(() => { shell.notify('info', '命令完成了') })
    expect(view.getByRole('status').textContent).toBe('命令完成了')
    expect(view.queryByRole('alert')).toBeNull()
  })

  it('hero variant adds the hero class and accessory row renders', () => {
    const { view } = bench({ variant: 'hero', accessory: <i data-testid="acc" /> })
    expect(view.getByTestId('acc')).toBeTruthy()
    expect(view.container.querySelector('[class*="hero"]')).not.toBeNull()
  })

  it('renders overlay, left/right, and footer slots at their layout positions', () => {
    const { view } = bench({
      overlay: <i data-testid="ov" />,
      leftItems: <i data-testid="li" />,
      rightItems: <i data-testid="ri" />,
      footer: <i data-testid="foot" />,
    })
    expect(view.getByTestId('ov')).toBeTruthy()
    expect(view.getByTestId('li')).toBeTruthy()
    expect(view.getByTestId('ri')).toBeTruthy()
    expect(view.getByTestId('foot')).toBeTruthy()
  })
})

describe('command launcher chrome and control seats', () => {
  it('renders the command launcher; the Access chip is absent without the permissions projection; the control seats render EMPTY without entries', () => {
    const { view, slotCalls } = bench()
    expect(view.getByLabelText('指令')).toBeTruthy()
    // Capability absent (no projection value): the chip renders nothing.
    expect(view.queryByLabelText(/^访问模式/)).toBeNull()
    // Every seat dispatched, nothing rendered (render passes may repeat; the
    // seat set is the contract).
    expect([...new Set(slotCalls.map(c => c.key))]).toEqual([
      'conversation.input.overlay', 'conversation.input.attachments',
      'conversation.input.plan', 'conversation.input.left',
      'conversation.input.right', 'conversation.input.model',
      'conversation.composer.dock',
    ])
    expect(view.queryByLabelText('Plan mode')).toBeNull()
    expect(view.queryByLabelText('Model')).toBeNull()
  })

  it('passes the textarea selection to the command menu launcher and reflects its expanded state', () => {
    const toggleCommandMenu = vi.fn()
    const { view, shell, menuLauncher } = bench({ draft: 'draft text', toggleCommandMenu })
    act(() => { shell.editor.update(() => { $selectDetectSpan({ start: 2, end: 7 }) }, { discrete: true }) })
    const launcher = view.getByLabelText('指令')
    expect(launcher.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(launcher)
    expect(toggleCommandMenu).toHaveBeenCalledExactlyOnceWith({ start: 2, end: 7 })
    act(() => { menuLauncher.set('command') })
    expect(launcher.getAttribute('aria-expanded')).toBe('true')
  })

  it('the Access chip renders the projection value and submits a non-Full-access pick directly', async () => {
    const command = vi.fn(() => Promise.resolve(true))
    const permissions = {
      options: [
        { value: 'read-only', name: 'read-only' },
        { value: 'workspace-write', name: 'workspace-write' },
        { value: 'danger-full-access', name: 'danger-full-access' },
      ],
      currentValue: 'read-only',
    }
    const { view } = bench({ permissions, command })
    const trigger = view.getByLabelText(/^访问模式/) as HTMLButtonElement
    // Product-label display is presentation only; the menu ids stay machine names.
    expect(trigger.textContent).toBe('仅可查看')
    expect([...trigger.querySelectorAll('svg')]
      .every(icon => icon.closest('[aria-hidden="true"]') !== null)).toBe(true)
    fireEvent.click(trigger)
    const items = view.getAllByRole('menuitem')
    expect(items.map(o => o.textContent)).toEqual(['仅可查看', '工作区内修改', '完全权限'])
    fireEvent.click(items[1]!)
    // Optimistic pick + disable until admission resolves (command stub resolves true).
    const busy = view.getByLabelText(/^访问模式/) as HTMLButtonElement
    expect(busy.textContent).toBe('工作区内修改')
    expect(busy.disabled).toBe(true)
    expect(command).toHaveBeenCalledWith('/permission workspace-write')
    await act(async () => {})
    expect((view.getByLabelText(/^访问模式/) as HTMLButtonElement).disabled).toBe(false)
  })

  it('the Access chip preserves host labels for built-in preset values', () => {
    const permissions = {
      options: [
        { value: 'read-only', name: 'Review Only' },
        { value: 'workspace-write', name: 'Project Files' },
        { value: 'danger-full-access', name: 'Operator Mode' },
        { value: 'custom-mode', name: 'custom-mode' },
        { value: '__proto__', name: '__proto__' },
      ],
      currentValue: 'workspace-write',
    }
    const { view } = bench({ permissions })
    const trigger = view.getByLabelText(/^访问模式/) as HTMLButtonElement
    expect(trigger.textContent).toBe('Project Files')
    fireEvent.click(trigger)
    expect(view.getAllByRole('menuitem').map(item => item.textContent))
      .toEqual(['Review Only', 'Project Files', 'Operator Mode', 'Custom Mode', '__proto__'])
  })

  it('requires explicit risk acknowledgement before submitting full access', async () => {
    const command = vi.fn(() => Promise.resolve(true))
    const permissions = {
      options: [
        { value: 'workspace-write', name: 'workspace-write' },
        { value: 'danger-full-access', name: 'danger-full-access' },
      ],
      currentValue: 'workspace-write',
    }
    const { view } = bench({ permissions, command })
    fireEvent.click(view.getByLabelText(/^访问模式/))
    fireEvent.click(view.getByRole('menuitem', { name: '完全权限' }))

    expect(command).not.toHaveBeenCalled()
    expect(view.getByRole('dialog', { name: '确认启用完全权限？' })).toBeTruthy()
    const enable = view.getByRole('button', { name: '启用完全权限' }) as HTMLButtonElement
    expect(enable.disabled).toBe(true)

    fireEvent.click(view.getByRole('checkbox', { name: '我已了解风险，并愿意继续' }))
    expect(enable.disabled).toBe(false)
    fireEvent.click(enable)

    expect(command).toHaveBeenCalledOnce()
    expect(command).toHaveBeenCalledWith('/permission danger-full-access')
    expect(view.queryByRole('dialog')).toBeNull()
    expect((view.getByLabelText(/^访问模式/) as HTMLButtonElement).textContent).toBe('完全权限')
    await act(async () => {})
  })

  it('cancels a full access selection without changing permission and resets acknowledgement', () => {
    const command = vi.fn(() => Promise.resolve(true))
    const permissions = {
      options: [
        { value: 'workspace-write', name: 'workspace-write' },
        { value: 'danger-full-access', name: 'danger-full-access' },
      ],
      currentValue: 'workspace-write',
    }
    const { view } = bench({ permissions, command })
    const openConfirmation = () => {
      fireEvent.click(view.getByLabelText(/^访问模式/))
      fireEvent.click(view.getByRole('menuitem', { name: '完全权限' }))
    }

    openConfirmation()
    fireEvent.click(view.getByRole('checkbox'))
    fireEvent.click(view.getByRole('button', { name: '取消' }))
    expect(command).not.toHaveBeenCalled()
    expect((view.getByLabelText(/^访问模式/) as HTMLButtonElement).textContent).toBe('工作区内修改')

    openConfirmation()
    expect((view.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
    expect((view.getByRole('button', { name: '启用完全权限' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('revokes an open full access confirmation when the task locks', () => {
    const command = vi.fn(() => Promise.resolve(true))
    const permissions = {
      options: [
        { value: 'workspace-write', name: 'workspace-write' },
        { value: 'danger-full-access', name: 'danger-full-access' },
      ],
      currentValue: 'workspace-write',
    }
    const { view, session } = bench({ permissions, command })
    fireEvent.click(view.getByLabelText(/^访问模式/))
    fireEvent.click(view.getByRole('menuitem', { name: '完全权限' }))
    fireEvent.click(view.getByRole('checkbox'))
    act(() => { session.set(snapshotOf({ removed: true })) })
    expect(view.queryByRole('dialog')).toBeNull()
    expect(command).not.toHaveBeenCalled()
  })

  it('resets an open full access confirmation when switching tasks', () => {
    const command = vi.fn(() => Promise.resolve(true))
    const permissions = {
      options: [
        { value: 'workspace-write', name: 'workspace-write' },
        { value: 'danger-full-access', name: 'danger-full-access' },
      ],
      currentValue: 'workspace-write',
    }
    const { view, props } = bench({ permissions, command })
    fireEvent.click(view.getByLabelText(/^访问模式/))
    fireEvent.click(view.getByRole('menuitem', { name: '完全权限' }))
    fireEvent.click(view.getByRole('checkbox'))
    view.rerender(<InputBar {...props} sessionId={'s2' as SessionId} />)
    expect(view.queryByRole('dialog')).toBeNull()
    expect(command).not.toHaveBeenCalled()
  })

  it('a registered entry fills its seat and receives the locked owner prop', () => {
    const { view, slotCalls } = bench({
      disabled: true,
      planEntry: <i data-testid="plan-entry" />,
      modelEntry: <i data-testid="model-entry" />,
    })
    expect(view.getByTestId('plan-entry')).toBeTruthy()
    expect(view.getByTestId('model-entry')).toBeTruthy()
    // The bar hands its chrome disable state to the filling entry.
    const controlKeys = new Set(['conversation.input.plan', 'conversation.input.model'])
    const controls = slotCalls.filter(call => controlKeys.has(call.key))
    expect(controls.every(c => (c.owner as { locked: boolean }).locked)).toBe(true)
    expect(attachmentOwner(slotCalls).canAcceptDrop).toBe(false)
    cleanup()
    const live = bench({ running: true })
    const liveControls = live.slotCalls.filter(call => controlKeys.has(call.key))
    expect(liveControls.every(c => !(c.owner as { locked: boolean }).locked)).toBe(true)
    expect(attachmentOwner(live.slotCalls).canAcceptDrop).toBe(true)
  })

  it('disabled locks the Access chip and command launcher (running does not)', () => {
    const permissions = { options: [{ value: 'workspace-write', name: 'workspace-write' }], currentValue: 'workspace-write' }
    const { view } = bench({ disabled: true, permissions })
    expect((view.getByLabelText('指令') as HTMLButtonElement).disabled).toBe(true)
    expect((view.getByLabelText(/^访问模式/) as HTMLButtonElement).disabled).toBe(true)
    cleanup()
    const live = bench({ running: true, permissions })
    expect((live.view.getByLabelText(/^访问模式/) as HTMLButtonElement).disabled).toBe(false)
  })
})
