/** Pi's native SDK loads for plugin metadata, but agent and tool operations require a Node Host. */
import { notImplementedFail } from '../notImplementedFail.ts'

const MODULE = '@earendil-works/pi-coding-agent'

/** Agent directory discovery (unavailable). */
export const getAgentDir = notImplementedFail(MODULE, 'getAgentDir')

/** Theme initialization (unavailable). */
export const initTheme = notImplementedFail(MODULE, 'initTheme')

/** Agent session service creation (unavailable). */
export const createAgentSessionServices = notImplementedFail(MODULE, 'createAgentSessionServices')

/** Agent session creation from services (unavailable). */
export const createAgentSessionFromServices = notImplementedFail(MODULE, 'createAgentSessionFromServices')

/** Bash tool definition creation (unavailable). */
export const createBashToolDefinition = notImplementedFail(MODULE, 'createBashToolDefinition')

/** MCP extension creation (unavailable). */
export const createMcpExtension = notImplementedFail(MODULE, 'createMcpExtension')

/** Tool definition (unavailable). */
export const defineTool = notImplementedFail(MODULE, 'defineTool')

/** CLI model selection (unavailable). */
export const resolveCliModel = notImplementedFail(MODULE, 'resolveCliModel')

/** Model registry construction (unavailable). */
export const ModelRegistry = notImplementedFail(MODULE, 'ModelRegistry')

/** Project trust store construction (unavailable). */
export const ProjectTrustStore = notImplementedFail(MODULE, 'ProjectTrustStore')

/** Model runtime construction and creation (unavailable). */
export const ModelRuntime = Object.assign(notImplementedFail(MODULE, 'ModelRuntime'), {
  create: notImplementedFail(MODULE, 'ModelRuntime.create'),
})

/** Settings manager construction and creation (unavailable). */
export const SettingsManager = Object.assign(notImplementedFail(MODULE, 'SettingsManager'), {
  create: notImplementedFail(MODULE, 'SettingsManager.create'),
})

/** Session manager construction and storage operations (unavailable). */
export const SessionManager = Object.assign(notImplementedFail(MODULE, 'SessionManager'), {
  create: notImplementedFail(MODULE, 'SessionManager.create'),
  open: notImplementedFail(MODULE, 'SessionManager.open'),
  inMemory: notImplementedFail(MODULE, 'SessionManager.inMemory'),
  list: notImplementedFail(MODULE, 'SessionManager.list'),
})

/** CommonJS interop marker: the worker loader hands `default` to default imports. */
export const __esModule = true

/** CommonJS default export: the members `require()` hands a caller of this module. */
export default {
  getAgentDir, initTheme, createAgentSessionServices, createAgentSessionFromServices,
  createBashToolDefinition, createMcpExtension, defineTool, resolveCliModel,
  ModelRegistry, ProjectTrustStore, ModelRuntime, SettingsManager, SessionManager,
}
