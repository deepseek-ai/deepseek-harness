/** Tool UI slot declarations and their composed component props. */
import type {
  HostObservable, InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime, SlotHookFactory,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteHostFacts } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  AssistantChatData, OpenFileOptions, PreparingToolCall, StartedToolCall,
  ToolResultNode, UseDisclosure,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { MessageImageLoader, MessageImageSource } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * Keyed Tool call view dispatched by wire Tool name. Any name is allowed,
     * including tools registered by your package. Register with
     * `key: '<tool name>'`; a typo never renders.
     *
     * Registering an occupied key replaces its view; unclaimed keys use the
     * generic row. The owner supplies the call identity and frozen running
     * or settled node through explicit phase props. Preparing blocks have no dispatched
     * arguments; useToolCallArgumentsPartial optionally subscribes to their raw prefix.
     */
    'tool.call.toolview': {
      kind: 'keyed'
      scope: 'session'
      owner: ToolCallOwnerProps
      hookContext: ToolCallHookContext
      inject: ToolCallInjected
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

/** Subscribe to this preparing call's raw argument prefix; other phases return an empty string. */
export type UseToolCallArgumentsPartial = () => string

/** Call-local sources supplied by the Tool tree to the slot's Hook binding. */
export interface ToolCallHookContext {
  readonly callId: string
  /** This call's Step source, present only while preparing. */
  readonly assistant: HostObservable<Readonly<AssistantChatData> | undefined> | undefined
}

/** Framework-bound subscriptions available to atomic Tool views on demand. */
export interface ToolCallInjected {
  hooks: {
    toolCallArgumentsPartial: SlotHookFactory<'tool.call.toolview', UseToolCallArgumentsPartial>
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
