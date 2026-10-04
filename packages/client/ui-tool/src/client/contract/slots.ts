/** Tool UI slot declarations and their composed component props. */
import type {
  HostObservable, InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime, SessionIdOf,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteHostFacts } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  OpenFileOptions, PreparingToolCall, StartedToolCall,
  ToolResultNode, UseDisclosure,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { MessageImageLoader, MessageImageSource } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import type {} from '@deepseek-ai/dsh-client-locale/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * Keyed Tool call view dispatched by wire Tool name. Any name is allowed,
     * including tools registered by your package. Register with
     * `key: '<tool name>'`; a typo never renders.
     *
     * Registering an occupied key replaces its view; unclaimed keys use the
     * generic row. The owner supplies the call identity and running
     * or settled node through explicit phase props. Every stage supplies
     * `name` and a lazy `args` view; preparing arguments may be incomplete.
     */
    'tool.call.toolview': {
      kind: 'keyed'
      scope: 'session'
      owner: ToolCallOwnerProps
    }
    /**
     * Durable images of a settled image-bearing Tool call, rendered through
     * the attachment presentation plugin. The Tool layer never imports an
     * attachment implementation: a toolview declares this slot as a child and
     * renders it with the image card's references plus the session-authorized
     * loader it received in its owner, and the attachment plugin fills the
     * gallery. Composing no attachment presentation plugin renders nothing,
     * which is why the image card keeps its own envelope text beside the
     * gallery. A child slot is declared by exactly one entry: registering a
     * second toolview that declares the same child throws at load, so a
     * future image-bearing tool must reuse this entry or own a distinct
     * slot.
     */
    'tool.call.images': { kind: 'single'; scope: 'session'; owner: ToolImagesOwnerProps }
  }
}

/** Owner currency of the Tool image gallery slot: references plus the loader. */
export interface ToolImagesOwnerProps {
  /** Durable references or submission-echo previews in result order. */
  images: readonly MessageImageSource[]
  /** Session-authorized image URL loader for the durable arm. */
  loadImage: MessageImageLoader
  /** Horizontal placement inside the owning record. */
  align: 'start' | 'end'
}

/** Standard owner currency supplied to every atomic Tool view. */
export interface ToolCallCommonProps {
  /** Stable Hook; each invocation owns its open state and subscribes to enclosing-Turn resets. */
  useDisclosure: UseDisclosure
  /** Call identity, stable across all stages. */
  callId: string
  /** Wire Tool name and keyed dispatch value. */
  toolName: string
  /** Session workspace root for relative summaries. */
  cwd?: string | undefined
  /** Host account home; POSIX home-rooted summaries display as `~`. */
  home?: string | undefined
  /** Open an argument path at its optional requested line. */
  openFile: (path: string, options?: OpenFileOptions) => void
  /** Chat-supplied, session-authorized loader for durable images; Tool views do not manage attachment URLs. */
  loadImage: MessageImageLoader
  /** Inspect this call in the trajectory view when available. */
  inspect?: (() => void) | undefined
}

/** Stage-specific tool data; only start/result expose the dispatched call material. */
export type ToolCallPhaseProps =
  | { readonly phase: 'preparing'; readonly block: PreparingToolCall }
  | { readonly phase: 'start'; readonly block: StartedToolCall }
  | { readonly phase: 'result'; readonly block: ToolResultNode }

/** Common owner callbacks and the data admitted at the current tool stage. */
export type ToolCallOwnerProps = ToolCallCommonProps & ToolCallPhaseProps

/** Full props of a registered atomic Tool view. */
export type ToolCallViewProps = PropsRuntime<'tool.call.toolview'>

/** Existing argument/result business components exclude the preparation stage. */
export type StartedToolCallViewProps = Exclude<ToolCallViewProps, { readonly phase: 'preparing' }>

/**
 * One settled `ask_user_question` call as its transcript row read it. The row
 * reads the questions from the recorded call JSON, and the answers from
 * whichever recorded them: its own result when the answer arrived in time, or
 * the `userQuestions` projection when a late reply settled the call.
 */
export interface UserQuestionRecord {
  /** The call's questions, with the option lists the panel renders. */
  readonly questions: readonly AskUserQuestionItem[]
  /** The recorded answer batch; an item with no selection and no custom text was skipped. */
  readonly answers: readonly AskUserQuestionAnswerItem[]
}

/**
 * Optional answer-panel provider consumed by the ask-question row. A timed
 * `ask_user_question` call stays answerable after its result is recorded, and
 * its panel can be closed, so the transcript row is the way back to it. A
 * composition without a question UI has no panel to show.
 */
export interface UserQuestionPanels {
  /**
   * Put one call's answer panel back in the composer, ahead of any other
   * pending question.
   * @param sessionId - Session the call belongs to.
   * @param callId - `ask_user_question` call whose panel to show.
   * @returns whether a panel for that call was there to show.
   */
  reveal(sessionId: SessionIdOf, callId: string): boolean
  /**
   * Show one settled call's recorded answers as a read-only panel, ahead of
   * any other pending question. Closing that panel drops it for good; the row
   * builds it again from the same record.
   * @param sessionId - Session the call belongs to.
   * @param callId - `ask_user_question` call whose record to show.
   * @param record - the call's questions and recorded answers.
   * @returns whether the panel was shown.
   */
  review(sessionId: SessionIdOf, callId: string, record: UserQuestionRecord): boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional user-question answer-panel provider. */
    userQuestionPanels: UserQuestionPanels
  }
}

/** Injected Host description for POSIX home-path display. */
export type ToolHostInfoInjected = {
  hooks: {
    /**
     * Fixed Host facts, reached through a hook rather than injected as values:
     * the renderer memoizes an entry's inject result for the registration's
     * lifetime, so facts read there would freeze at whatever the first render
     * saw. Select the field the view needs (`info => info.home`).
     */
    hostInfo: HostObservable<RemoteHostFacts>
  }
}

/** Full props of the Tool call-tree renderer registered as a tool-call Chat Node. */
export type ToolTreeProps = PropsRuntime<'conversation.chat.node', 'tool-call'>
  & PropsRenderSlots<'tool.call.toolview'>
  & PropsLocale<'conversation'>
  & InjectFace<ToolHostInfoInjected>
