/**
 * Recorded differences between the SDK and Desktop standard model context. An entry with `debt` is an inconsistency
 * to fix; fixing it makes the entry stale, so the fix removes it. The entries also apply to the Team-on comparison.
 */
import type { ParityException } from './parity.ts'

const modelSelection = 'Desktop enables subagent model selection and discovery; SDK delegation inherits the caller model by default.'
const webSurface = 'Desktop tells the model about the Web GUI that serves it; the SDK has no graphical surface.'
const harnessSource = 'Desktop composes harness-dev-context to name the Harness checkout that serves its GUI; SDK embedders do not run the GUI.'
const primaryRuntime = 'Desktop always ships the primary runtime and selects it for the desktop profile; the SDK uses it only when the caller provides DSH_PRIMARY_RUNTIME or downloads it, and otherwise points the Office skills at the user Python.'
const presetRegistry = 'Desktop mounts each Session agent from an agent preset selected through the registry; the SDK composes its agent rows directly, so its base row stays disabled.'
const sdkTransport = 'The SDK serves JSON-RPC over stdio instead of a Web server; the rows contribute no model context.'

/** Every accepted difference; an entry that no longer matches an observed difference fails the comparison. */
export const parityExceptions: readonly ParityException[] = [
  { kind: 'tool', key: 'list_subagent_models', side: 'desktop', reason: modelSelection },
  { kind: 'schema', key: 'subagent:/parameters/properties/provider', reason: modelSelection },
  { kind: 'schema', key: 'subagent:/parameters/properties/model', reason: modelSelection },
  { kind: 'schema', key: 'subagent:/parameters/properties/reasoning_effort', reason: modelSelection },
  { kind: 'config', key: 'tool-subagent:/config/modelSelection', reason: modelSelection },
  { kind: 'config', key: 'tool-subagent:/config/modelDiscovery', reason: modelSelection },
  { kind: 'section', key: 'app:web-surface', side: 'desktop', reason: webSurface },
  { kind: 'section', key: 'runtime-context/app:web-surface', side: 'desktop', reason: webSurface },
  { kind: 'section', key: 'harness:source', side: 'desktop', reason: harnessSource },
  { kind: 'section', key: 'runtime-context/harness:source', side: 'desktop', reason: harnessSource },
  { kind: 'config', key: 'tool-plugin-manager:/disabled',
    reason: 'Desktop gates the tool on a profile-backed Host; the SDK always boots a profile, so both expose plugin_manager.' },
  { kind: 'config', key: 'tool-plugin-market', side: 'desktop',
    reason: 'The Desktop preset declares the plugin market tools switched off; the SDK profile omits the row, so neither side exposes the tools.' },
  { kind: 'config', key: 'workspace-dependencies:/disabled', reason: primaryRuntime },
  { kind: 'config', key: 'workspace-dependencies:/config/source', reason: primaryRuntime },
  { kind: 'config', key: 'workspace-dependencies:/config/root', reason: primaryRuntime },
  { kind: 'config', key: 'skill-office:/config/pythonEnvironment', reason: primaryRuntime },
  { kind: 'config', key: 'hmr:/disabled',
    reason: 'The SDK disables HMR so one stdio connection never observes its server or agent dependencies replaced; plugin_manager changes report restart-required instead of applied.' },
  { kind: 'config', key: 'session-title-llm:/disabled',
    reason: 'The SDK has no title surface and skips the separate title request; the request is outside the agent context.' },
  { kind: 'config', key: 'sdk-app-startup', side: 'sdk', reason: sdkTransport },
  { kind: 'config', key: 'sdk-jsonrpc-server', side: 'sdk', reason: sdkTransport },
  { kind: 'config', key: 'agent-preset-registry:/disabled', reason: presetRegistry },
  { kind: 'config', key: 'agent-preset-registry:/config', reason: presetRegistry },
  { kind: 'config', key: 'connection:/config', reason: 'Desktop passes the trusted hosts of its Web server to the client connection; the SDK has no browser transport.' },
]
