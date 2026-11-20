/**
 * Recorded differences between the SDK and Desktop standard model context. An entry with `debt` is an inconsistency
 * to fix; fixing it makes the entry stale, so the fix removes it. The entries also apply to the Team-on comparison.
 */
import type { ParityException } from './parity.ts'

const modelSelection = 'Desktop enables subagent model selection and discovery; SDK delegation inherits the caller model by default.'
const cordisInspect = 'Web exposes inspection of its Host and connected Client runtime; the SDK profile does not compose the Cordis inspection providers.'
const webSurface = 'Desktop tells the model about the Web GUI that serves it; the SDK has no graphical surface.'
const harnessSource = 'Desktop composes harness-dev-context to name the Harness checkout that serves its GUI; SDK embedders do not run the GUI.'

/** Every accepted difference; an entry that no longer matches an observed difference fails the comparison. */
export const parityExceptions: readonly ParityException[] = [
  { kind: 'tool', key: 'list_subagent_models', side: 'desktop', reason: modelSelection },
  { kind: 'schema', key: 'subagent:/parameters/properties/provider', reason: modelSelection },
  { kind: 'schema', key: 'subagent:/parameters/properties/model', reason: modelSelection },
  { kind: 'schema', key: 'subagent:/parameters/properties/reasoning_effort', reason: modelSelection },
  { kind: 'config', key: 'tool-subagent:/config/modelSelection', reason: modelSelection },
  { kind: 'config', key: 'tool-subagent:/config/modelDiscovery', reason: modelSelection },
  { kind: 'tool', key: 'cordis_inspect', side: 'desktop', reason: cordisInspect },
  { kind: 'config', key: 'tool-cordis', side: 'desktop', reason: cordisInspect },
  { kind: 'section', key: 'app:web-surface', side: 'desktop', reason: webSurface },
  { kind: 'section', key: 'runtime-context/app:web-surface', side: 'desktop', reason: webSurface },
  { kind: 'section', key: 'harness:source', side: 'desktop', reason: harnessSource },
  { kind: 'section', key: 'runtime-context/harness:source', side: 'desktop', reason: harnessSource },
  { kind: 'config', key: 'tool-plugin-manager:/disabled',
    reason: 'Desktop gates the tool on a profile-backed Host; the SDK always boots a profile, so both expose plugin_manager.' },
  { kind: 'config', key: 'tool-plugin-market', side: 'desktop',
    reason: 'The Desktop preset declares the plugin market tools switched off; the SDK profile omits the row, so neither side exposes the tools.' },
]
