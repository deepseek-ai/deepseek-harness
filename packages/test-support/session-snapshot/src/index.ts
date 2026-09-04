/**
 * Session-log snapshot support behind the keyless snapshot tier
 * (`pnpm run test:snapshot`). The current ACP adapter has four layers: the
 * shared subprocess/client launcher ({@link launchAcpTestAgent}), the scripted
 * scenario harness ({@link runScenario}), the pure expected-output normalizers
 * ({@link normalizeStdout} / {@link normalizeSessionLog} /
 * {@link scrubRequestHeaders} / {@link scrubSystemPrompts}), and the suite
 * factory ({@link defineAcpSnapshotSuite}) that registers a scenario table as a
 * full describe/it tree. Transport-neutral normalizers and fixture invariants
 * remain reusable by other profile adapters. Ordinary ACP e2e tests can use the launcher directly;
 * the ACP corpus adapter supplies only its {@link AgentUnderTest} paths,
 * snapshots directory, and {@link Scenario} table.
 *
 * NOTE: ./suite.ts imports vitest, so this package is importable only inside a
 * vitest run — a support-tier constraint stated in the README.
 *
 * @module @deepseek-ai/dsh-session-snapshot
 */

export {
  redactSessionSnapshotIds,
} from './identity.ts'
export {
  runScenario,
  snapshotSpillRoot,
  type HarvestedLog,
  type InputScript,
  type InputStep,
  type PermissionAnswer,
  type RunOptions,
  type RunResult,
} from './harness.ts'
export {
  launchAcpTestAgent,
  materializeProfilePatch,
  type AcpTestLaunchOptions,
  type AgentUnderTest,
  type LaunchedAcpTestAgent,
} from './launcher.ts'
export {
  extractSnapshotSpillPaths,
  normalizeSessionFormatProvenance,
  normalizeSessionLog,
  normalizeSessionSnapshot,
  normalizeSessionSnapshots,
  normalizeStdout,
  scrubRequestHeaders,
  scrubSessionSnapshot,
  scrubSystemPrompts,
  scrubToolSchemas,
  tokenizeSessionFixtureCwd,
  type CwdPathMode,
  type NormalizeContext,
  type NormalizeOptions,
} from './normalize.ts'
export {
  parseSnapshotManifest,
  writesCurrentSessionFixtures,
  type SnapshotHeaderManifest,
  type SnapshotInputAttachment,
  type SnapshotInputManifest,
  type SnapshotManifest,
  type SnapshotPermission,
  type SnapshotPlatform,
  type SnapshotProfile,
  type SnapshotRecording,
  type SnapshotReplayManifest,
  type SnapshotSessionReference,
  type SnapshotSessionFormatCoverage,
  type SnapshotSessionFormatManifest,
  type SnapshotSessionWriteMode,
  type SnapshotWorkspaceManifest,
} from './manifest.ts'
export {
  assertPersistedSessionVersion,
  assertSessionFixtureVersion,
  latestPersistedSessionPaths,
  parsePersistedSessionFilename,
  parseSessionFixtureName,
  persistedSessionFilename,
  sessionFixtureFiles,
  sessionFixtureName,
  sessionFixtureNames,
  sessionHeaderVersion,
  type PersistedSessionFile,
  type SessionFixtureFile,
} from './session-files.ts'
export {
  formatSystemPromptSnapshot,
  formatToolSchemasSnapshot,
  fixtureContext,
  headerChangeCount,
  defineAcpSnapshotSuite,
  normalizedHeaders,
  normalizedSystemPrompts,
  normalizedToolSchemas,
  parseToolSchemasSnapshot,
  refreshFixtureReplacements,
  restorePinnedToolSchemas,
  stabilizeFixtureMessageIds,
  stabilizeRefreshLog,
  type Scenario,
  type SnapshotSuiteOptions,
} from './suite.ts'
export {
  captureExpectedWorkspaceSnapshot,
  captureWorkspaceSnapshot,
  EMPTY_WORKSPACE_MARKER,
  type CaptureWorkspaceSnapshotOptions,
  type WorkspaceBinaryFileSnapshot,
  type WorkspaceEmptyDirectorySnapshot,
  type WorkspaceSnapshotEntry,
  type WorkspaceSymlinkSnapshot,
  type WorkspaceTextFileSnapshot,
} from './workspace.ts'
