/**
 * Recorded differences between the SDK and Desktop model context. An entry with `debt` is an inconsistency to fix;
 * fixing it makes the entry stale, so the fix removes it. Team mode is not compared until #7172 is fixed.
 */
import type { ParityException } from './parity.ts'

const both = ['standard', 'ptc'] as const

const modelSelection = 'Desktop enables subagent model selection and discovery; SDK delegation inherits the caller model by default.'
const webSurface = 'Desktop tells the model about the Web GUI that serves it; the SDK has no graphical surface.'
const harnessSource = 'Desktop composes harness-dev-context to name the Harness checkout that serves its GUI; SDK embedders do not run the GUI.'
const ptcWorkflow = 'The SDK PTC overlay changes only the executor so existing base workflow callers keep working; Desktop PTC uses run_code orchestration and omits the separate workflow surface.'
const pluginMarket = 'Both Desktop presets declare the plugin market tools switched off; the SDK profile omits the row, so neither side exposes the tools.'

/** Every accepted difference; an entry that no longer matches an observed difference fails the comparison. */
export const parityExceptions: readonly ParityException[] = [
  // Intended differences.
  { kind: 'tool', key: 'list_subagent_models', side: 'desktop', modes: both, reason: modelSelection },
  { kind: 'schema', key: 'subagent:/parameters/properties/provider', modes: both, reason: modelSelection },
  { kind: 'schema', key: 'subagent:/parameters/properties/model', modes: both, reason: modelSelection },
  { kind: 'schema', key: 'subagent:/parameters/properties/reasoning_effort', modes: both, reason: modelSelection },
  { kind: 'config', key: 'tool-subagent:/config/modelSelection', modes: both, reason: modelSelection },
  { kind: 'config', key: 'tool-subagent:/config/modelDiscovery', modes: both, reason: modelSelection },
  { kind: 'tool', key: 'cordis_inspect', side: 'desktop', modes: ['standard'],
    reason: 'Web exposes inspection of its Host and connected Client runtime; the SDK profile does not compose the Cordis inspection providers.' },
  { kind: 'config', key: 'tool-cordis', side: 'desktop', modes: ['standard'],
    reason: 'Web exposes inspection of its Host and connected Client runtime; the SDK profile does not compose the Cordis inspection providers.' },
  { kind: 'section', key: 'app:web-surface', side: 'desktop', modes: both, reason: webSurface },
  { kind: 'section', key: 'runtime-context/app:web-surface', side: 'desktop', modes: both, reason: webSurface },
  { kind: 'section', key: 'harness:source', side: 'desktop', modes: both, reason: harnessSource },
  { kind: 'section', key: 'runtime-context/harness:source', side: 'desktop', modes: both, reason: harnessSource },
  { kind: 'config', key: 'tool-plugin-manager:/disabled', modes: ['standard'],
    reason: 'Desktop gates the tool on a profile-backed Host; the SDK always boots a profile, so both expose plugin_manager.' },
  { kind: 'tool', key: 'plugin_manager', side: 'sdk', modes: ['ptc'],
    reason: 'SDK PTC changes are persisted for restart without replacing active bindings because HMR is disabled; Desktop PTC excludes management in its HMR-enabled preset.' },
  { kind: 'config', key: 'tool-plugin-manager:/disabled', modes: ['ptc'],
    reason: 'SDK PTC changes are persisted for restart without replacing active bindings because HMR is disabled; Desktop PTC excludes management in its HMR-enabled preset.' },
  { kind: 'config', key: 'tool-plugin-market', side: 'desktop', modes: both, reason: pluginMarket },
  { kind: 'tool', key: 'workflow', side: 'sdk', modes: ['ptc'], reason: ptcWorkflow },
  { kind: 'section', key: 'tool:workflow', side: 'sdk', modes: ['ptc'], reason: ptcWorkflow },
  { kind: 'config', key: 'workflow-ptc:/disabled', modes: ['ptc'], reason: ptcWorkflow },
  { kind: 'config', key: 'tool-workflow:/disabled', modes: ['ptc'], reason: ptcWorkflow },
  { kind: 'section', key: 'tools:sdk', modes: ['ptc'],
    reason: 'The section renders every admitted tool as a TypeScript binding, so it carries the subagent model selection and SDK workflow differences recorded above.' },

  // Inconsistencies to fix.
  { kind: 'config', key: 'plan-mode:/config/section', modes: both,
    reason: 'The base row the SDK inherits keeps an older plan mode text ("remain listed only to keep the request shape stable") than the Desktop presets ("remain listed to keep the tool catalog unchanged").',
    debt: { issue: '#8556' } },
  { kind: 'config', key: 'skill-filesystem:/config', modes: ['standard'],
    reason: 'The Desktop standard preset adds the agent-preset skills directory, which carries dsh-doc; the SDK profile does not.',
    debt: { issue: '#8557' } },
  { kind: 'skill', key: 'dsh-doc', side: 'desktop', modes: ['standard'],
    reason: 'The Desktop standard preset adds the agent-preset skills directory, which carries dsh-doc; the SDK profile does not.',
    debt: { issue: '#8557' } },
]
