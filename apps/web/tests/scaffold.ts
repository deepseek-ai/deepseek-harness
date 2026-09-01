// Shared scaffold for the keyless browser e2e lane (Agent Note:
// .agents/notes/implemented/testing/2026-07-24-web-gui-browser-e2e-lane.md).
// Boots the REAL web composition — the dsh-base and dsh-web-app bundle
// patches over the empty profile root through the vendored Loader (the same
// layer stack the profile boot composes), patched the
// snapshot way — so a real chromium exercises the real HTTP uplink/WebSocket
// downlink, api-gateway, agent loop, tools, and persistence. Modes ride $DSH_SNAPSHOT:
// replay (default, keyless: normally disables the llm-deepseek row and
// inserts dsh-llm-replay in providers mode), record (real adapter + key,
// harvests fixtures from live session memory), refresh (keyless replay that
// rewrites goldens). A first-run option keeps the real adapter mounted while
// masking its credential, without making a model call.
//
// Composition divergences from `dsh web`, all deliberate, all via include
// patches after the shipped bundle layers, over the SAME tree (never a
// second yml): temp persistenceRoot; host-level skill roots confined to the
// temp workspace while project skill discovery remains real; agent-instructions
// disabled (recorded fixtures must not embed this repo's AGENTS.md);
// session-title-llm disabled (its fire-and-forget title call would race the
// loop for the session's replay cursor); webserver pinned to port 0 with the
// built dist; ordinary keyless modes disable llm-deepseek and fill the open
// llm seam post-boot with installLlmReplay on the settled root ctx
// (the plugin-row path discards the ReplayHandle; the direct install keeps
// assertConsumed for the teardown fixture-consumption check).
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Page } from 'playwright'
import { expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include, { type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import {
  captureExpectedWorkspaceSnapshot,
  captureWorkspaceSnapshot,
  formatSystemPromptSnapshot,
  formatToolSchemasSnapshot,
  normalizedSystemPrompts,
  normalizedToolSchemas,
  parseSnapshotManifest,
  redactSessionSnapshotIds,
  normalizeSessionSnapshots,
  scrubRequestHeaders,
  scrubSessionSnapshot,
  stabilizeFixtureMessageIds,
  type NormalizeContext,
} from '@deepseek-ai/dsh-session-snapshot'
import {
  assertEntriesLoaded,
  composeEntries,
  healProfilesModuleFallback,
  loadOverlayPatches,
  type Profile,
} from '@deepseek-ai/dsh-app-boot'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type {
  LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, RetryPolicyConfig, StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { ReplayHandle } from '@deepseek-ai/dsh-llm-replay'
import { installLlmReplay, parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import SessionStore, {
  packChunkRuns,
  SESSION_FORMAT_VERSION,
  SessionId,
  type Session,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
// Empty type imports carry the webServer/agents/sessionPersistence Context merges.
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-agent'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { REPO_ROOT, requireDist } from './support.ts'

// Host-side web e2e cannot import a browser package: doing so would pull that
// package's complete TS project into this graph. Mirrored from
// packages/client/ui-settings-models/src/onboarding-copy.ts; drift makes the
// default pre-acknowledgement stop suppressing the notice and fails loudly.
// import {
//   WELCOME_NOTICE_ACK_FIELD, WELCOME_NOTICE_SETTINGS_NAMESPACE,
//   WELCOME_NOTICE_VERSION, WELCOME_NOTICE_COPY,
// } from '@deepseek-ai/dsh-client-ui-settings-models'
export const WELCOME_NOTICE_SETTINGS_NAMESPACE = 'ui-onboarding'
export const WELCOME_NOTICE_ACK_FIELD = 'welcomeNoticeVersion'
export const WELCOME_NOTICE_VERSION = '2026-08-13.1'
export const WELCOME_NOTICE_COPY = {
  zh: {
    title: '内测声明',
    body: 'DeepSeek Harness 目前的 0.1 版本仍处在面向 Harness 开发者进行测试的阶段，还有许多地方需要持续改进和打磨，希望听取广大开发者的反馈建议。预计 DeepSeek Harness 的核心插件以及基础 API 都会在接下来的一段时间内快速迭代、持续演化。\n\n我们期待与全球开发者一起，在开源、开放、可复用、可组合的基础设施之上，共同探索智能上限。欢迎全球 Harness 开发者加入 DSH 插件生态。',
    continueLabel: '继续',
  },
} as const

/** Snapshot mode for the lane, from $DSH_SNAPSHOT (same vocabulary as the other snapshot suites). */
export type WebSnapshotMode = 'replay' | 'record' | 'refresh'

/**
 * Resolve and validate the lane's snapshot mode.
 * @returns the active mode; unset/empty selects replay.
 */
export function webSnapshotMode(): WebSnapshotMode {
  const value = process.env.DSH_SNAPSHOT
  if (value === undefined || value === '' || value === 'replay') return 'replay'
  if (value === 'record' || value === 'refresh') return value
  throw new Error(`DSH_SNAPSHOT must be replay, record, or refresh; got ${JSON.stringify(value)}`)
}

/**
 * Compare a session-driven Web scenario's complete workspace with its committed independent expected state.
 * @param scenarioDir - Absolute recorded-session scenario directory.
 * @param workspaceRoot - Absolute cwd used by the controlled session.
 */
export async function assertFinalWorkspaceSnapshot(scenarioDir: string, workspaceRoot: string): Promise<void> {
  const manifestPath = join(scenarioDir, 'snapshot.yml')
  const manifest = parseSnapshotManifest(await readFile(manifestPath, 'utf8'), manifestPath)
  expect(manifest.workspace?.final, `${manifest.scenario ?? scenarioDir}: mutating Web scenario declares workspace.final`)
    .toBe(true)
  const actual = await captureWorkspaceSnapshot(workspaceRoot)
  const expected = await captureExpectedWorkspaceSnapshot(join(scenarioDir, 'workspace.expected'))
  expect(actual, `${manifest.scenario ?? scenarioDir}: complete final workspace`).toEqual(expected)
}

async function ownsReplayFixture(replayFixture: string | undefined): Promise<boolean> {
  if (replayFixture === undefined || basename(replayFixture) !== 'session.jsonl') return false
  const manifestPath = join(dirname(replayFixture), 'snapshot.yml')
  if (!existsSync(manifestPath)) return false
  const manifest = parseSnapshotManifest(await readFile(manifestPath, 'utf8'), manifestPath)
  return manifest.session === undefined
}

/** The shipped composition under test: the dsh-base and dsh-web-app bundle patches over the empty profile root. */
const BASE_PATCH_PATH = join(REPO_ROOT, 'packages/bundle/base/cordis.patch.yml')
const WEB_PATCH_PATH = join(REPO_ROOT, 'packages/bundle/web-app/cordis.patch.yml')
/** The installation anchor whose dependency surface the profile module fallback mirrors. */
const INSTALL_ANCHOR = join(REPO_ROOT, 'apps/cli/package.json')

// Replay publishes the provider catalog the gateway routes to (providers
// mode, never catch-all: with llm-deepseek disabled no adapter exists, so a
// catch-all would leave resolveModelInfo unroutable and compaction-basic's
// post-step pressure check would warn every step). The published
// contextWindow keeps that pressure path provably inert for small fixtures.
const REPLAY_PROVIDERS = [{
  id: 'deepseek-official',
  name: 'DeepSeek',
  models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', contextWindow: 128_000 }],
}]

/**
 * The routes a shipped composition always has, with no ability to stream.
 * A fixture-less keyless scenario issues no model calls, but its tree must
 * still answer `listProviders()` — surfaces legitimately gate on whether any
 * adapter serves a session's route, and an empty registry is a test artifact,
 * not a product state.
 */
class RouteOnlyAdapter extends LlmAdapter {
  constructor(private readonly providers: typeof REPLAY_PROVIDERS) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.providers.find(entry => entry.id === provider)?.name ?? provider }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve((this.providers.find(entry => entry.id === provider)?.models ?? [])
      .map(model => ({ provider, id: model.id, name: model.name })))
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const listed = this.providers.find(entry => entry.id === provider)?.models
      .find(entry => entry.id === model)
    return Promise.resolve({
      provider,
      id: model,
      name: listed?.name ?? model,
      ...listed?.contextWindow === undefined ? {} : { contextWindow: listed.contextWindow },
    })
  }

  override async *stream(): AsyncIterable<StreamChunk> {
    throw new Error(
      'web e2e scaffold: a model call was issued by a scenario that declared no replay fixture'
      + ' — pass replayFixture, or keep the scenario free of model calls',
    )
  }
}

function replayProviders(contextWindow: number | undefined): typeof REPLAY_PROVIDERS {
  if (contextWindow === undefined) return REPLAY_PROVIDERS
  return REPLAY_PROVIDERS.map(provider => ({
    ...provider,
    models: provider.models.map(model => ({ ...model, contextWindow })),
  }))
}

/** A booted web scaffold: real composition, mode-selected model backend, temp world. */
export interface WebScaffold {
  /** The active snapshot mode this scaffold booted under. */
  mode: WebSnapshotMode
  /** Browser-facing origin for the bound test server. */
  baseUrl: string
  /** Process-token URL that establishes this scaffold's browser session. */
  authenticatedUrl: string
  /** Settled root context (the in-process readiness barrier; headless event subscription is its sanctioned use). */
  ctx: Context
  /** Temp project directory sessions run in (shell/fs tool cwd). */
  workspaceCwd: string
  /** Temp persistence root (seeded sessions land here through the real API). */
  persistenceRoot: string
  /** Isolated harness home the settings/credentials rows write ($DSH_HOME double). */
  harnessHome: string
  /** Send a browser-equivalent Host request with this scaffold's authenticated cookie. */
  hostFetch(path: string, init?: RequestInit): Promise<Response>
  /** Await a settled turn end: in-process turn/end, then the agent's idle flip (which follows the persistence flush). */
  whenTurnSettled(timeoutMs?: number): Promise<SessionId>
  /**
   * Tear everything down; asserts the replay fixture was fully consumed first
   * (replay/refresh), unless booted with replayProvidersOnly (whose fixture
   * is validated call-free at boot).
   */
  close(): Promise<void>
}

/** Options for {@link launchWebScaffold}. */
export interface LaunchOptions {
  /** Compare the replayed root session with `replayFixture`; defaults on for a manifest-owned canonical recording. */
  compareReplaySession?: boolean
  /**
   * Optional product overlay applied after the shipped Web surface and before
   * the scaffold's hermetic test patches, matching the launcher's `--patch`
   * ordering.
   */
  extraOverlayPath?: string
  /**
   * Additional source-checkout package manifests whose dependency closures
   * supply private profile layers named by {@link extraOverlayPath}.
   */
  extraInstallAnchors?: string[]
  /**
   * Replay fixture (session.jsonl) served by the inserted dsh-llm-replay row
   * in replay/refresh modes; ignored in record mode (the real adapter
   * answers). Omit for scenarios issuing no model calls — a stray stream then
   * fails loud with NO_ADAPTER (llm-deepseek is disabled and no replay row
   * mounts). With {@link replayProvidersOnly}, the fixture must record no
   * model calls (its header alone mounts the catalog).
   */
  replayFixture?: string
  /**
   * Mount the replay provider catalog (the model directory the UI shows)
   * without consuming any recorded script: for scenarios that never call a
   * model but need the real provider/model labels rendered. Requires
   * {@link replayFixture} whose log records no model calls, and rejects
   * {@link replayOverride} and {@link replayChildFixtures}; the teardown
   * consumption check is skipped for this mode. `replayFixture` without this
   * flag keeps the consumption check.
   */
  replayProvidersOnly?: boolean
  /**
   * Recorded child logs assigned in child creation order. Each child owns its
   * own positional replay cursor across initial and continuation turns.
   */
  replayChildFixtures?: string[]
  /**
   * Optional replay.override.json sidecar (whole-script replacement or
   * `{ patches }` augmentation) for throw/hang scenarios not expressible as
   * recorded chunks; replay/refresh only.
   */
  replayOverride?: string
  /**
   * Retry policy registered on every replay provider route, for failure-
   * injection scenarios that must exhaust recovery quickly instead of walking
   * the shared normal default's five backed-off retries; replay/refresh only.
   */
  replayRetryPolicy?: RetryPolicyConfig
  /** Per-chunk replay pacing (ms) so the browser observes genuinely incremental SSE; replay/refresh only. */
  paceMs?: number
  /** Synthetic model capacity for UI scenarios whose seeded history must remain uncompacted. */
  replayContextWindow?: number
  /**
   * Tool presentation mode patched onto the shipped `tools` row (`code`
   * collapses the wire to run_code + the SDK prompt section). Omit for the
   * yml default. The code runtime row is always in the tree, so no extra
   * insertion is needed.
   */
  toolsMode?: 'native' | 'ptc' | 'both'
  /**
   * Insert the opt-in model-facing Cordis tool provider into the shipped tree.
   * Record and replay use the same tool surface, so captured request headers
   * remain reconstructable without making the tools a product default.
   */
  cordisTools?: boolean
  /**
   * Keep the shipped DeepSeek adapter mounted while masking the process
   * environment's DEEPSEEK_API_KEY for this scaffold lifetime. This is the
   * keyless first-run configuration lane; the default disables the adapter.
   */
  deepSeekMissingCredential?: boolean
  /** Leave the current welcome notice pending; ordinary scenarios pre-acknowledge it before browser boot. */
  welcomeNoticePending?: boolean
  /**
   * Patch the shipped DeepSeek search row to a deterministic endpoint and
   * credential reference. Browser search scenarios keep the real provider and
   * credentials seam while avoiding external search traffic and ambient keys.
   */
  deepSeekSearch?: {
    /** Anthropic-compatible base URL; the provider appends `/messages`. */
    baseURL: string
    /** Credential reference resolved by the shipped search provider. */
    apiKeyEnv: string
  }
  /**
   * Replace the roster row the scaffold pins by default (no configured roots,
   * default `standard` — the plugin's own shipped presets). Supply this only
   * to change WHICH presets a scenario sees beyond the shipped set — a
   * writable user root, a different default. The patch lands after the
   * default, so it wins.
   */
  agentPresets?: {
    /** Roots to discover after the plugin's shipped root, in precedence order. */
    roots: { path: string; trust: 'system' | 'user' }[]
    /** The preset a session that names none is composed from. */
    default: string
  }
  /**
   * Mount the shipped telemetry row against this exporter URL instead of
   * disabling it. Used to pin a real backend disclosure in assembled
   * coverage; point the URL at a local endpoint (a dead port, or a scenario's
   * own mock collector) so no record leaves the machine.
   */
  telemetryUrl?: string
  /** Uploading mode for the mounted telemetry row. Defaults to `FULL`. */
  telemetryMode?: 'FULL' | 'FEEDBACK_ONLY'
  /**
   * Browse through a trusted non-loopback hostname that the browser resolves
   * to loopback (for example `*.localhost`). The test server stays bound to
   * 127.0.0.1; a non-resolving authority fails before Host trust is exercised.
   */
  remoteAuthority?: string
  /** Reuse an existing harness home so a second Host can verify user settings across origins. */
  harnessHome?: string
}

/** Dispose the booted tree and remove both owned temp roots, reporting every independent cleanup failure. */
async function cleanupScaffoldWorld(ctx: Context, workspaceCwd: string, persistenceRoot: string): Promise<unknown[]> {
  const failures: unknown[] = []
  await Promise.resolve(ctx.fiber.dispose()).catch((error: unknown) => failures.push(error))
  await rm(workspaceCwd, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
  await rm(persistenceRoot, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
  return failures
}

/**
 * Boot the real web composition under the current snapshot mode.
 * @param options - replay fixture selection and pacing.
 * @returns the running scaffold.
 */
export async function launchWebScaffold(options: LaunchOptions = {}): Promise<WebScaffold> {
  requireDist()
  const mode = webSnapshotMode()
  const compareReplaySession = options.compareReplaySession ?? await ownsReplayFixture(options.replayFixture)
  const browserHost = options.remoteAuthority ?? '127.0.0.1'
  if (mode === 'record') {
    // Both owning vitest configs (web unconditionally, snapshot in record
    // mode) load the repo-root .env before this file runs.
    if (process.env.DEEPSEEK_API_KEY === undefined || process.env.DEEPSEEK_API_KEY.length === 0) {
      throw new Error('web e2e record mode needs DEEPSEEK_API_KEY (env or repo-root .env)')
    }
  }
  if (mode === 'record' && options.deepSeekMissingCredential === true) {
    throw new Error('deepSeekMissingCredential is a keyless replay/refresh option')
  }
  const maskDeepSeekCredential = mode !== 'record' && options.deepSeekMissingCredential === true
  const originalDeepSeekCredential = process.env.DEEPSEEK_API_KEY
  let credentialEnvironmentRestored = false
  const restoreCredentialEnvironment = (): void => {
    if (credentialEnvironmentRestored || !maskDeepSeekCredential) return
    credentialEnvironmentRestored = true
    if (originalDeepSeekCredential === undefined) {
      Reflect.deleteProperty(process.env, 'DEEPSEEK_API_KEY')
    } else {
      process.env.DEEPSEEK_API_KEY = originalDeepSeekCredential
    }
  }
  const workspaceCwd = await realpath(await mkdtemp(join(tmpdir(), 'dsh-web-e2e-ws-')))
  // Isolated harness home: the settings/credentials rows resolve $DSH_HOME
  // paths at load, and an in-process boot must NEVER touch the developer's
  // real ~/.dsh document or credential file.
  const harnessHome = options.harnessHome ?? join(workspaceCwd, '.dsh-home')
  // Skill discovery is model-visible input, and its roots now resolve inside a
  // PRESET — a subtree this lane's include patches cannot reach, because the
  // roster mounts it directly per session rather than as a row of the booted
  // tree. The row's documented fallback is the environment, so pin that: the
  // whole scaffold lifetime, not just the boot, since presets mount when a
  // session is created. Without this a developer's real ~/.dsh/skills silently
  // enters replay requests and goldens while CI sees none. `DSH_HOME` follows
  // the resolved harness home so a scaffold sharing another's home — the
  // cross-port persistence scenario — pins the same roots the settings and
  // credentials rows were configured with.
  const skillRootEnvironment = {
    DSH_HOME: harnessHome,
    DSH_AGENTS_HOME: join(workspaceCwd, '.agents-home'),
    DSH_BUNDLED_SKILL_DIR: join(workspaceCwd, '.bundled-skills'),
  }
  const originalSkillRootEnvironment = Object.fromEntries(
    Object.keys(skillRootEnvironment).map(key => [key, process.env[key]]),
  )
  let skillRootEnvironmentRestored = false
  const restoreSkillRootEnvironment = (): void => {
    if (skillRootEnvironmentRestored) return
    skillRootEnvironmentRestored = true
    for (const [key, value] of Object.entries(originalSkillRootEnvironment)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
  }
  Object.assign(process.env, skillRootEnvironment)
  let persistenceRoot: string
  try {
    persistenceRoot = await mkdtemp(join(tmpdir(), 'dsh-web-e2e-sessions-'))
  } catch (error) {
    const failures: unknown[] = [error]
    await rm(workspaceCwd, { recursive: true, force: true }).catch((cleanupError: unknown) => failures.push(cleanupError))
    restoreSkillRootEnvironment()
    if (failures.length > 1) throw new AggregateError(failures, 'web scaffold temp-root setup failed')
    throw error
  }
  if (maskDeepSeekCredential) Reflect.deleteProperty(process.env, 'DEEPSEEK_API_KEY')

  // The include patch set — the same layer stack the profile boot composes
  // (bundle patches in dsh.profile.bundles order), applied over the SAME empty root (a
  // patch id that stops matching a row fails the boot sweep loudly instead of
  // drifting).
  const basePatches = loadOverlayPatches('web e2e scaffold', BASE_PATCH_PATH)
  const surfacePatches = loadOverlayPatches('web e2e scaffold', WEB_PATCH_PATH)
  const extraOverlayPatches = options.extraOverlayPath === undefined
    ? []
    : loadOverlayPatches('web e2e scaffold', options.extraOverlayPath)
  const composedRows = composeEntries([basePatches, surfacePatches, extraOverlayPatches])
  const webRuntimeConfig = composedRows.find(row => row.id === 'web-runtime')?.config as {
    surfaceContext?: boolean
  } | undefined
  const surfaceContext = webRuntimeConfig?.surfaceContext !== false
  const patches: PatchOptions[] = [
    ...basePatches,
    ...surfacePatches,
    ...extraOverlayPatches,
    // The roster's shipped presets are the plugin's own, bundled inside
    // `dsh-agent-presets` and prepended by it. Pin only the machine-local
    // root away: a developer's own `~/.dsh/.agent-presets` must not be able
    // to change a golden.
    {
      id: 'agent-presets',
      config: {
        default: 'standard',
        includeUserRoot: false,
      },
    },
    { id: 'session-persistence-jsonl', config: { root: persistenceRoot } },
    // Content search is enabled here although the shipped bundles default it
    // off (`openAt: never`, pinned by apps/cli/tests/lazy-search-startup):
    // the seeded-session scenarios navigate by content search, and these e2e
    // runs are the assembled coverage for the opt-in search path.
    { id: 'session-query-sqlite', config: { path: ':memory:', openAt: 'first-search' } },
    // storage-json's yml root is anchored to the real $DSH_HOME; pin the row
    // to an absolute temp root (removed with the workspace at close) so tests
    // never write the user's harness home.
    { id: 'storage-json', config: { root: join(workspaceCwd, '.dsh-storages') } },
    // Skill discovery is model-visible input. Pin every host-level root inside
    // the owned temp world so ~/.dsh, ~/.agents, and a bundled-root env setting
    // cannot change replay requests or conversation goldens. Project roots stay
    // enabled against the same empty temp workspace, preserving the real seam.
    {
      id: 'skill-filesystem',
      config: {
        dshHome: join(workspaceCwd, '.dsh-home'),
        agentsHome: join(workspaceCwd, '.agents-home'),
        bundledSkillDir: join(workspaceCwd, '.bundled-skills'),
        watch: false,
      },
    },
    // fs/bash cwd default to process.cwd(); the gateway injects the same
    // value into session.cwd — chdir below anchors all three to the temp
    // workspace, keeping the composition untouched.
    { id: 'agent-instructions', disabled: true },
    { id: 'session-title-llm', disabled: true },
    // Fixture sessions must never leave the process: the shipped row defaults
    // to the production OTLP endpoint (or whatever DSH_TELEMETRY_OTLP_URL
    // names in the ambient environment). A scenario that pins a real backend
    // disclosure passes a local dead endpoint instead of disabling the row.
    options.telemetryUrl === undefined
      ? { id: 'session-telemetry-otel', disabled: true }
      : {
        id: 'session-telemetry-otel',
        config: {
          mode: options.telemetryMode ?? 'FULL',
          exporter: { url: options.telemetryUrl },
          shutdownTimeoutMillis: 1_000,
        },
      },
    // Use an ephemeral port while preserving the shipped compression policy;
    // a patch replaces the row's complete config.
    {
      id: 'webserver',
      config: {
        host: '127.0.0.1', port: 0, compression: 'gzip',
        compressionLevel: 1, compressionThresholdBytes: 1024,
      },
    },
    // The bundle's web-runtime row resolves the same built dist under test
    // (apps/web IS @deepseek-ai/dsh-web-frontend); native browser opening and the
    // URL line are disabled because this scaffold owns its Playwright browser.
    // Preserve the composed surface-context choice because a patch replaces
    // the row's complete config.
    { id: 'web-runtime', config: { openBrowser: false, printUrl: false, surfaceContext } },
    ...options.remoteAuthority === undefined
      ? []
      : [{ id: 'connection', config: { trustedHosts: [options.remoteAuthority] } }],
    { id: 'settings', config: { dshHome: harnessHome } },
    { id: 'credentials', config: { dshHome: harnessHome } },
    // The shipped directory-picker row is the -auto chooser, which resolves
    // the interaction from the RUNNING host (display, SSH launch, bind). The
    // lane's goldens are interaction-specific (workspace-management drives
    // the in-app browse dialog), so pin -browse deterministically on every
    // host: patch `name` is an assertion, not an override, hence the
    // disable+insert pair.
    { id: 'directory-picker', disabled: true },
    { insert: [
      { id: 'directory-picker-browse', name: '@deepseek-ai/dsh-host-directory-picker-browse' },
      { id: 'ui-directory-picker-browse', name: '@deepseek-ai/dsh-client-ui-directory-picker-browse' },
    ] },
    ...options.agentPresets === undefined
      ? []
      // Never the derived harness-home root: a developer's own presets must not
      // be able to change a golden, whatever roots a scenario asks for.
      : [{ id: 'agent-presets', config: { ...options.agentPresets, includeUserRoot: false } }],
    ...options.toolsMode === undefined ? [] : [{ id: 'tools', config: { mode: options.toolsMode } }],
    // The shipped Web bundle already owns both runners and the Cordis UI. This
    // scenario adds only the model-facing tools that exercise those services.
    ...options.cordisTools === true
      ? [{ insert: [
        { id: 'tool-cordis', name: '@deepseek-ai/dsh-tool-cordis' },
      ] }]
      : [],
    ...options.deepSeekSearch === undefined
      ? []
      : [{
        id: 'web-search-deepseek',
        config: {
          apiKeyEnv: options.deepSeekSearch.apiKeyEnv,
          baseURL: options.deepSeekSearch.baseURL,
        },
      }],
    ...mode === 'record' || options.deepSeekMissingCredential === true
      ? []
      : [{ id: 'llm-deepseek', disabled: true }],
  ]

  // Sessions inherit the gateway's process.cwd() default; run the boot from
  // the temp workspace so tool cwd, session cwd, and fixtures agree.
  const originalCwd = process.cwd()
  const ctx = new Context()
  const observedSessions = new Map<SessionId, Session>()
  const stopObservingSessions = ctx.on('session/created', (session) => {
    observedSessions.set(session.id, session)
  })
  let port = 0
  let baseUrl = ''
  let authenticatedUrl = ''
  let cookieHeader = ''
  let replayHandle: ReplayHandle | undefined
  try {
    process.chdir(workspaceCwd)
    const profileDir = join(harnessHome, 'profiles', 'scaffold')
    const extraLayers: Profile['layers'] = await Promise.all((options.extraInstallAnchors ?? []).map(async (anchor) => {
      const manifest = JSON.parse(await readFile(anchor, 'utf8')) as { name?: unknown }
      if (typeof manifest.name !== 'string' || manifest.name === '') {
        throw new Error(`web scaffold extra install anchor has no package name: ${anchor}`)
      }
      const packageDir = dirname(anchor)
      return {
        packageName: manifest.name,
        packageDir,
        patchPath: join(packageDir, 'cordis.patch.yml'),
        patches: [],
      }
    }))
    // Mirror the production launcher: the shared installation closure keeps
    // its carrier-specific fallback, while private bundle dependencies stay
    // isolated to this synthetic scaffold profile.
    await healProfilesModuleFallback({
      installAnchor: INSTALL_ANCHOR,
      home: harnessHome,
      profile: {
        name: 'scaffold',
        dir: profileDir,
        layers: extraLayers,
        patchPath: join(profileDir, 'cordis.patch.yml'),
        patches: [],
        patchReload: 'startup',
      },
    })
    await mkdir(profileDir, { recursive: true })
    const rootConfig = join(profileDir, 'cordis.yml')
    await writeFile(rootConfig, '[]\n')
    ctx.baseUrl = pathToFileURL(profileDir).href + '/'
    // This direct Loader harness supplies the same root-path capability as app-boot.
    ctx.provide('dshHomePath', dshHomePath)
    // A host with no command line still provides one: the web bundle's startup
    // row releases the rows waiting on it, and with no arguments each starts on
    // the values this scaffold composed above. An exit request can only come
    // from a rejected argument, which a fixed empty list has none of.
    provideCmdline(ctx, {
      args: [],
      exit: (code) => {
        throw new Error(`web e2e scaffold: the web app requested exit ${String(code)} with no arguments to reject`)
      },
    })
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    // `cordis:group` beside it, exactly as `boot()` registers it: a group row is
    // how a preset gives one `isolate` realm to a provider and its consumers,
    // and a preset resolving package names from its own directory cannot reach
    // `@deepseek-ai/cordis-plugin-group` by name.
    ctx.loader.builtins.group = Group
    await ctx.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(rootConfig).href, patches },
    })
    await ctx.loader.await()
    assertEntriesLoaded(ctx, 'web e2e scaffold')
    if (options.welcomeNoticePending !== true) {
      await ctx.settings.mutate(WELCOME_NOTICE_SETTINGS_NAMESPACE, [{
        op: 'set', path: [WELCOME_NOTICE_ACK_FIELD], value: WELCOME_NOTICE_VERSION,
      }])
    }
    const boundPort = ctx.get('webServer')?.port
    if (boundPort === undefined) {
      throw new Error('web e2e scaffold: webServer service missing after settled boot')
    }
    port = boundPort

    // Fill the open llm seam on the settled root ctx. Ordinary keyless modes
    // disable llm-deepseek; the first-run lane keeps it mounted but has no
    // replay fixture and never streams. The direct install, unlike the plugin
    // row, returns the ReplayHandle for the teardown consumption check.
    if (options.replayProvidersOnly) {
      if (options.replayFixture === undefined) {
        throw new Error('replayProvidersOnly requires replayFixture (its file supplies the header)')
      }
      const fixtureText = readFileSync(options.replayFixture, 'utf8')
      // The consumption check is skipped for this mode, so no script source
      // may carry callable entries: reject override/child sources outright
      // and any call-bearing fixture.
      if (options.replayOverride !== undefined || options.replayChildFixtures !== undefined) {
        throw new Error('replayProvidersOnly cannot combine with replayOverride or replayChildFixtures')
      }
      // A fixture without a session header row must not mount the catalog
      // silently: the consumption-skip assumes the header-only shape.
      let headerType: unknown
      try {
        headerType = (JSON.parse(fixtureText.trimStart().split('\n', 1)[0] ?? '') as { type?: unknown }).type
      } catch {
        headerType = undefined
      }
      if (headerType !== 'session') {
        throw new Error('replayProvidersOnly fixture must open with a session header row')
      }
      const recorded = parseSessionLog(fixtureText)
      const hasModelCall = recorded.some(event => (
        event.type === 'assistant/chunk' || event.type === 'request/header' || event.type === 'tool/call'
      ))
      if (hasModelCall) {
        throw new Error('replayProvidersOnly fixture must record no model calls')
      }
    }
    if (mode !== 'record' && options.replayFixture !== undefined) {
      replayHandle = installLlmReplay(ctx, {
        file: options.replayFixture,
        providers: replayProviders(options.replayContextWindow).map(provider => ({
          ...provider,
          ...(options.replayRetryPolicy === undefined ? {} : { retryPolicy: options.replayRetryPolicy }),
        })),
        ...(options.replayOverride === undefined ? {} : { overrideFile: options.replayOverride }),
        ...(options.replayChildFixtures === undefined ? {} : { childFiles: options.replayChildFixtures }),
        ...(options.paceMs === undefined ? {} : { paceMs: options.paceMs }),
      })
    } else if (mode !== 'record' && options.deepSeekMissingCredential !== true) {
      // No fixture and no shipped adapter would leave the tree with ZERO
      // provider routes — a state no product composition has, and one the
      // composer refuses to type into. Register the same routes
      // a fixture would, with streaming that still fails loud: the scenario
      // issues no model calls, and one that slipped in must not pass quietly.
      ctx.effect(() => ctx.llm.registerAdapter(
        replayProviders(options.replayContextWindow).map(provider => provider.id),
        new RouteOnlyAdapter(replayProviders(options.replayContextWindow)),
      ), 'web e2e scaffold: route-only adapter')
    }
    baseUrl = `http://${browserHost}:${String(port)}`
    authenticatedUrl = ctx.connection.authenticatedUrl(baseUrl)
    const login = await fetch(authenticatedUrl, { redirect: 'manual' })
    const setCookie = login.headers.get('set-cookie')
    if (login.status !== 303 || login.headers.get('location') !== '/' || setCookie === null) {
      throw new Error('web e2e scaffold: browser token exchange did not return its session cookie')
    }
    cookieHeader = setCookie.split(';', 1)[0] ?? ''
    if (cookieHeader.length === 0) {
      throw new Error('web e2e scaffold: browser token exchange returned an empty session cookie')
    }
  } catch (error) {
    if (process.cwd() !== originalCwd) process.chdir(originalCwd)
    const cleanupFailures = await cleanupScaffoldWorld(ctx, workspaceCwd, persistenceRoot)
    restoreCredentialEnvironment()
    restoreSkillRootEnvironment()
    if (cleanupFailures.length > 0) {
      throw new AggregateError([error, ...cleanupFailures], 'web scaffold setup failed and cleanup was incomplete')
    }
    throw error
  } finally {
    if (process.cwd() !== originalCwd) process.chdir(originalCwd)
  }

  return {
    harnessHome,
    mode,
    baseUrl,
    authenticatedUrl,
    ctx,
    workspaceCwd,
    persistenceRoot,
    hostFetch(path: string, init: RequestInit = {}): Promise<Response> {
      const headers = new Headers(init.headers)
      headers.set('cookie', cookieHeader)
      return fetch(new URL(path, baseUrl), { ...init, headers })
    },
    // Barrier stack: the in-process turn/end identifies the session, its
    // explicit flush makes the transcript durable, and the caller's browser
    // settled-poll comes last because host completion strictly precedes render.
    whenTurnSettled(timeoutMs = mode === 'record' ? 180_000 : 30_000): Promise<SessionId> {
      return new Promise<SessionId>((resolveSettled, reject) => {
        const timer = setTimeout(() => {
          off()
          reject(new Error(`no turn/end within ${timeoutMs}ms`))
        }, timeoutMs)
        const off = ctx.on('session/event', (session: Session, event: SessionEvent) => {
          if (event.type !== 'turn/end') return
          clearTimeout(timer)
          off()
          ctx.sessions.flush(session)
            .then(() => { resolveSettled(session.id) }, reject)
        })
      })
    },
    async close(): Promise<void> {
      const failures: unknown[] = []
      if (mode !== 'record'
        && options.replayFixture !== undefined
        && options.replayProvidersOnly !== true
        && compareReplaySession) {
        try {
          await assertReplaySession(
            [...observedSessions.values()],
            options.replayFixture,
            mode,
            `http://${browserHost}:${port}`,
          )
        } catch (error) {
          failures.push(error)
        }
      }
      // Fixture-consumption check first, while the run's binding state is
      // still authoritative — a scenario that drove fewer model calls than
      // recorded fails here instead of drifting green. Skipped for
      // replayProvidersOnly, whose fixture is validated call-free at boot.
      if (!options.replayProvidersOnly) {
        try {
          replayHandle?.assertConsumed()
        } catch (error) {
          failures.push(error)
        }
      }
      try {
        stopObservingSessions()
        failures.push(...await cleanupScaffoldWorld(ctx, workspaceCwd, persistenceRoot))
      } finally {
        restoreCredentialEnvironment()
        restoreSkillRootEnvironment()
      }
      if (failures.length > 0) throw new AggregateError(failures, 'web scaffold teardown failed')
    },
  }
}

/**
 * Serialize a live session to the canonical raw session-JSONL layout — the
 * in-memory record-mode harvest, so the on-disk zstd default never matters.
 */
function rawSessionLog(session: Session): string {
  return [
    JSON.stringify({ type: 'session', ...session.header }),
    ...packChunkRuns(session.snapshotEvents()).map(record => JSON.stringify(record)),
    '',
  ].join('\n')
}

function normalizeWebSessionVolatiles(log: string): string {
  const normalizeValue = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return value.replace(/Anonymous user: [^.]+(?=\. Session sharing)/g, 'Anonymous user: {{anonymousUserId}}')
    }
    if (Array.isArray(value)) return value.map(normalizeValue)
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeValue(item)]))
    }
    return value
  }
  return log.split(/\r?\n/).map((line) => {
    if (line.trim() === '') return line
    const record = normalizeValue(JSON.parse(line)) as { type?: unknown; data?: { endpoint?: unknown } }
    if (record.type === 'web/deepseek-search-llm-request' && typeof record.data?.endpoint === 'string') {
      record.data.endpoint = '{{webSearchEndpoint}}'
    }
    return JSON.stringify(record)
  }).join('\n')
}

function stableSessionFixture(session: Session, existing: string, workspaceCwd: string): string {
  const fresh = scrubSessionSnapshot(normalizeWebSessionVolatiles(rawSessionLog(session)))
    .split(session.id).join('{{sessionId}}')
    .split(workspaceCwd).join('{{cwd}}')
  const stable = redactSessionSnapshotIds(stabilizeFixtureMessageIds([fresh], [existing]))[0]
  if (stable === undefined) throw new Error('session harvest produced no stabilized fixture')
  return stable
}

async function assertReplaySession(
  sessions: readonly Session[],
  fixturePath: string,
  mode: WebSnapshotMode,
  webUrl: string,
): Promise<void> {
  let expected = await readFile(fixturePath, 'utf8')
  const userPrompts = fixtureUserPrompts(expected)
  const candidates = sessions.filter((session) => {
    if (session.header.parentSession !== undefined) return false
    const actual = session.snapshotEvents().flatMap((event) => {
      if (event.type !== 'user/message' || event.data.source.kind !== 'user') return []
      const text = event.data.content.filter(block => block.type === 'text').map(block => block.text).join('')
      return text.length === 0 ? [] : [text]
    })
    return JSON.stringify(actual) === JSON.stringify(userPrompts)
  })
  expect(candidates, `Web replay fixture ${fixturePath} must match one live root session`).toHaveLength(1)
  const session = candidates[0] as Session
  const sessionCwd = session.header.cwd
  if (sessionCwd === undefined) throw new Error(`${fixturePath}: replayed session has no cwd`)
  const actual = rawSessionLog(session)
  if (mode === 'refresh') {
    expected = stableSessionFixture(session, expected, sessionCwd)
    await writeFile(fixturePath, expected)
  }
  const expectedHeader = JSON.parse(expected.split('\n').find(line => line.trim() !== '') ?? '{}') as {
    id?: unknown
    cwd?: unknown
  }
  const actualContext: NormalizeContext = { sessionIds: [String(session.id)], cwd: sessionCwd }
  const expectedContext: NormalizeContext = {
    sessionIds: typeof expectedHeader.id === 'string' ? [expectedHeader.id] : [],
    cwd: typeof expectedHeader.cwd === 'string' ? expectedHeader.cwd : '\0no-cwd\0',
  }
  expect(normalizeSessionSnapshots([normalizeWebSessionVolatiles(actual)], actualContext)[0], `${fixturePath}: persisted replay`)
    .toBe(normalizeSessionSnapshots([normalizeWebSessionVolatiles(expected)], expectedContext)[0])

  const fixtureDir = dirname(fixturePath)
  const manifestPath = join(fixtureDir, 'snapshot.yml')
  const manifest = parseSnapshotManifest(await readFile(manifestPath, 'utf8'), manifestPath)
  if (manifest.header?.pin !== true) return
  const normalizePrompt = (value: string): string => value
    .split(REPO_ROOT).join('{{sourceRoot}}')
    .split(webUrl).join('{{webUrl}}')
  const prompts = normalizedSystemPrompts(actual, actualContext).map(normalizePrompt)
  const schemas = normalizedToolSchemas(actual, actualContext)
  const promptPath = join(fixtureDir, 'system-prompt.expected.md')
  const schemaPath = join(fixtureDir, 'tool-schemas.expected.json')
  const promptSnapshot = formatSystemPromptSnapshot(prompts[0] as string, prompts.slice(1))
  const schemaSnapshot = formatToolSchemasSnapshot(schemas[0] as unknown[], schemas.slice(1))
  if (mode === 'refresh') {
    await Promise.all([writeFile(promptPath, promptSnapshot), writeFile(schemaPath, schemaSnapshot)])
  }
  expect(promptSnapshot, `${fixturePath}: system-prompt pin`).toBe(await readFile(promptPath, 'utf8'))
  expect(schemaSnapshot, `${fixturePath}: tool-schema pin`).toBe(await readFile(schemaPath, 'utf8'))
}

/**
 * Record-mode fixture write-back: harvest the live session, scrub request
 * headers to {{system}}/{{tools}}, tokenize the run-local cwd, redact opaque
 * identities with typed relationship-preserving tokens, and write the fixture.
 * @param scaffold - the record-mode scaffold.
 * @param sessionId - the driven session.
 * @param fixturePath - the committed session.jsonl target.
 */
export async function recordFixture(scaffold: WebScaffold, sessionId: SessionId, fixturePath: string): Promise<void> {
  const agent = scaffold.ctx.agents.get(sessionId)
  if (agent === undefined) throw new Error(`record harvest: no live agent for ${sessionId}`)
  const existing = existsSync(fixturePath) ? await readFile(fixturePath, 'utf8') : ''
  await writeFile(fixturePath, stableSessionFixture(agent.session, existing, scaffold.workspaceCwd))
}

/**
 * The user prompts recorded in a fixture, in order — the single source tying
 * spec drive steps to recorded reality so script and fixture cannot drift.
 * @param fixtureText - raw session.jsonl contents.
 * @returns the recorded user prompt texts.
 */
export function fixtureUserPrompts(fixtureText: string): string[] {
  return parseSessionLog(fixtureText).flatMap((event) => {
    if (event.type !== 'user/message' || event.data.source.kind !== 'user') return []
    const text = event.data.content.filter(block => block.type === 'text').map(block => block.text).join('')
    return text.length > 0 ? [text] : []
  })
}

/** Deterministic UUID used when a seed fixture's typed identity token is materialized. */
export function fixtureIdentity(
  kind: 'message' | 'approval' | 'workflow' | 'command' | 'rpc' | 'retry' | 'id',
  ordinal: number,
): string {
  const hex = createHash('sha256').update(`${kind}:${ordinal}`).digest('hex').slice(0, 32).split('')
  hex[12] = '4'
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16] as string, 16) % 4] as string
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`
}

/**
 * Seed a recorded session fixture into the scaffold's persistence root
 * through the REAL backend API (throwaway Context + SessionStore + JSONL
 * plugin — the semantic-checkpoint precedent), never raw file writes: no
 * knowledge of bucket hashing, filename encoding, or compression, and
 * malformed session events fail loud at seed time. The fixture's tokenized identity
 * ({{sessionId}}/{{cwd}}) is realized for this world before parsing. Event
 * times are materialized from event order against the fixture header's
 * creation time, or the seeded creation time when normalization replaced the
 * header value with zero.
 * @param scaffold - the target scaffold.
 * @param fixtureText - raw recorded session.jsonl contents.
 * @param id - the seeded session id (stable for deterministic goldens).
 * @param agentPreset - the preset the recorded session was composed from,
 *   for scenarios asserting what a resumed session reports running.
 * @returns the seeded id.
 */
/**
 * Realize a recorded seed fixture against one scaffold: substitute the
 * `{{sessionId}}`/`{{cwd}}` placeholders and rewrite the recorded cwd to the
 * scaffold's workspace. Idempotent, so a caller may realize early (e.g. to
 * price content exactly as the host will fold it) and still pass the result
 * through {@link seedSession}.
 * @param scaffold - the booted scaffold whose workspace the seed targets.
 * @param fixtureText - the committed seed fixture text.
 * @param id - the session id the seed is realized for.
 * @returns the realized fixture text.
 */
export function realizeSeedFixture(scaffold: WebScaffold, fixtureText: string, id: string): string {
  const realized = fixtureText
    .split('{{sessionId}}').join(id)
    .split('{{session:1}}').join(id)
    .replace(/\{\{session:([2-9]\d*)\}\}/g, (_token, ordinal: string) => `${id}-child-${ordinal}`)
    .replace(/\{\{(message|approval|workflow|command|rpc|retry|id):([1-9]\d*)\}\}/g, (_token, kind: string, ordinal: string) =>
      fixtureIdentity(kind as 'message' | 'approval' | 'workflow' | 'command' | 'rpc' | 'retry' | 'id', Number(ordinal)))
    .split('{{cwd}}').join(scaffold.workspaceCwd)
  const fixtureCwd = (JSON.parse(realized.split('\n', 1)[0]!) as { cwd?: string }).cwd
  return fixtureCwd === undefined
    ? realized
    : realized.split(fixtureCwd).join(scaffold.workspaceCwd)
}

/**
 * Parse a committed web seed fixture through the replay reader.
 * @param fixtureText - session JSONL fixture contents.
 * @returns the original header line, parsed header, and logical events.
 */
export function parseSeedFixture(fixtureText: string): {
  headerLine: string
  header: Record<string, unknown>
  events: SessionEvent[]
} {
  const headerLine = fixtureText.split(/\r?\n/).find(line => line.trim().length > 0)
  if (headerLine === undefined) throw new Error('seed fixture has no session header')
  const header = JSON.parse(headerLine) as Record<string, unknown>
  if (header.type !== 'session') throw new Error('seed fixture must start with a session header')
  return { headerLine, header, events: parseSessionLog(fixtureText) }
}

/**
 * Render logical events as an envelope-free web seed fixture.
 * @param headerLine - original session header line.
 * @param events - logical session events in order.
 * @returns projected session JSONL.
 */
export function renderSeedFixture(
  headerLine: string,
  events: readonly ({ readonly seq: number; readonly time: number } & object)[],
): string {
  return [
    headerLine,
    ...events.map(({ seq: _seq, time: _time, ...event }) => JSON.stringify(event)),
    '',
  ].join('\n')
}

export async function seedSession(
  scaffold: WebScaffold,
  fixtureText: string,
  id: string,
  agentPreset?: string,
): Promise<SessionId> {
  const decoded = parseSeedFixture(realizeSeedFixture(scaffold, fixtureText, id))
  const events = decoded.events
  if (events.length === 0) throw new Error('seed fixture has no events')
  const last = events[events.length - 1]!
  // An open final turn would be mutated by resume's crash repair on first
  // open; a committed seed must be a closed recording.
  if (last.type !== 'turn/end') throw new Error(`seed fixture must end in turn/end, got ${last.type}`)
  const meta: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: Date.now() - 60_000,
    cwd: scaffold.workspaceCwd,
    delegationDepth: 0,
    ...agentPreset === undefined ? {} : { agentPreset },
  }
  const fixtureCreatedAt = decoded.header.createdAt
  if (typeof fixtureCreatedAt !== 'number') {
    throw new Error('seed fixture requires a numeric createdAt header')
  }
  const timeAnchor = fixtureCreatedAt === 0 ? meta.createdAt : fixtureCreatedAt
  const materializedEvents = events.map((event, index) => ({ ...event, time: timeAnchor + index }))
  await persistSeedSession(scaffold, meta, materializedEvents)
  return meta.id
}

/** Seed one materialized cold Session whose log has no turn/start event. */
export async function seedBlankSession(
  scaffold: WebScaffold,
  id: string,
  cwd: string,
): Promise<SessionId> {
  const meta: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: Date.now() - 60_000,
    cwd,
    delegationDepth: 0,
  }
  await persistSeedSession(scaffold, meta, [{
    type: 'session/end-seed',
    seq: 0,
    time: meta.createdAt,
    data: {},
  }])
  return meta.id
}

/** Materialize one detached Session fixture through the shipped JSONL provider. */
async function persistSeedSession(
  scaffold: WebScaffold,
  meta: SessionHeader,
  events: readonly SessionEvent[],
): Promise<void> {
  const seeder = new Context()
  try {
    await seeder.plugin(SessionStore)
    // Same root as the booted tree with the plugin's own default compression,
    // so the host's directory-scan list() sees one consistent encoding.
    await seeder.plugin(JsonlSessionPersistence, { root: scaffold.persistenceRoot })
    await seeder.sessionPersistence.create(meta)
    await seeder.sessionPersistence.append(meta.id, events)
  } finally {
    await seeder.fiber.dispose()
  }
}

/**
 * Normalize an aria snapshot: uuid, cwd, workspace-basename, duration,
 * decode-throughput, and path-sensitive compaction estimates collapse to
 * stable tokens.
 *
 * Throughput needs a token for the same reason durations do, and no fixture
 * can supply one: the figure divides a replayed step's output tokens by the
 * wall time the local run took to stream them, so it moves between two runs
 * on one machine (measured 69 → 70 tok/s) and swings wildly on a fast replay
 * (26333 tok/s for a 3 ms stream).
 */
/**
 * Relative-time buckets rendered by a dated row, in both dictionaries.
 *
 * Opt-in per capture: a session-tree golden asserts its own literal age (a
 * fresh row reads `now`, an older one does not), so collapsing the vocabulary
 * everywhere would delete that assertion. A region whose rows are dated from
 * live wall-clock state asks for it instead. Anchored on an aria label's
 * closing quote, where the bucket is always last.
 */
const ARIA_AGE =
  /(?:now|\d+min|\d+h|\d+d|\d+mo|\d+y|刚刚|\d+分钟|\d+小时|\d+天|\d+个月|\d+年)(?=")/g

function normalizeAria(snapshot: string, workspaceCwd: string, age: boolean): string {
  // The session heading renders the workspace's basename, not the full
  // path, so both spellings must collapse to the token.
  const base = workspaceCwd.split('/').pop()!
  return (age ? snapshot.replace(ARIA_AGE, '{{age}}') : snapshot)
    .split(workspaceCwd).join('{{cwd}}')
    .split(base).join('{{workspace}}')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '{{uuid}}')
    // The optional space in `\d+m ?\d+s` covers both minute spellings: the
    // stats line's compact `2m42s` and the message-chrome template's `2m 42s`.
    .replace(
      /~\d+(?:y(?: \d+mo)?|mo(?: \d+d)?)|\b(?:\d+d(?: \d+h(?: \d+m \d+s)?)?|\d+h \d+m \d+s|\d+m ?\d+s|\d+(?:\.\d+)?s|\d+(?:\.\d+)?ms)\b/g,
      duration => duration.startsWith('~') ? duration : '{{duration}}',
    )
    .replace(/\b\d[\d,]*(?:\.\d+)? ms\b/g, '{{duration}}')
    .replace(
      /约\d+(?:年(?:\d+个月)?|个月(?:\d+天)?)|\d+(?:天(?:\d+小时(?:\d+分\d+秒)?)?|小时\d+分\d+秒|分\d+秒|(?:\.\d+)?秒)/g,
      duration => duration.startsWith('约') ? duration : '{{duration}}',
    )
    .replace(/\d+(?:\.\d+)?(?= tok\/s(?!\w))/g, '{{throughput}}')
    // Seeded compaction prices realized file paths, whose length differs
    // between local worktrees and CI scratch directories.
    .replace(/(Compacted \d+ history items \(~)\d+( tokens\))/g, '$1{{tokens}}$2')
    // Session summaries and Message IconActions clocks cross calendar
    // boundaries; collapse every shape so goldens stay stable across them.
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '{{timestamp}}')
    .replace(/\d{4}年\d{1,2}月\d{1,2}日 \d{2}:\d{2}/g, '{{clock}}')
    .replace(/\d{1,2}月\d{1,2}日 \d{2}:\d{2}/g, '{{clock}}')
    .replace(/(?<!\d)\d{1,2}:\d{2}:\d{2}(?:\.\d+)?(?:\s*[AP]M)?(?!\d)/gi, '{{clock}}')
    .replace(/(?<!\d)\d{2}:\d{2}(?!\d)/g, '{{clock}}')
}

/**
 * Capture the region's aria snapshot at a settled milestone: poll until two
 * consecutive normalized captures are equal — a single-shot capture races the
 * last React commits.
 * @param page - the page under test.
 * @param selector - the region locator selector.
 * @param workspaceCwd - normalization input.
 * @param options - `normalizeAge` collapses relative-time buckets to `{{age}}`
 *   for a region whose rows are dated from live wall-clock state.
 * @returns the stable normalized snapshot.
 */
export async function captureStableAria(
  page: Page,
  selector: string,
  workspaceCwd: string,
  options: { normalizeAge?: boolean } = {},
): Promise<string> {
  const region = page.locator(selector).first()
  const age = options.normalizeAge === true
  let previous = normalizeAria(await region.ariaSnapshot(), workspaceCwd, age)
  await expect.poll(async () => {
    const current = normalizeAria(await region.ariaSnapshot(), workspaceCwd, age)
    const stable = current === previous
    previous = current
    return stable
  }, { timeout: 5_000, message: 'aria snapshot did not stabilize' }).toBe(true)
  return previous
}

/**
 * Capture a stable aria snapshot with every eligible Turn process expanded,
 * then restore the controls that were closed before the capture.
 * @param page - the page under test.
 * @param selector - the region locator selector.
 * @param workspaceCwd - normalization input.
 * @param options - optional user-visible state to establish before capture.
 * @returns the stable normalized expanded snapshot.
 */
export async function captureExpandedTurnProcessAria(
  page: Page,
  selector: string,
  workspaceCwd: string,
  options: { scrollToBottom?: boolean } = {},
): Promise<string> {
  const controls = page.locator('[data-turn-process]')
  const count = await controls.count()
  expect(count).toBeGreaterThan(0)
  const opened: number[] = []
  for (let index = 0; index < count; index++) {
    const control = controls.nth(index)
    if (!await control.isVisible() || await control.getAttribute('aria-expanded') === 'true') continue
    await control.click()
    opened.push(index)
  }
  try {
    if (options.scrollToBottom === true) {
      const backToBottom = page.getByRole('button', { name: 'Back to bottom', exact: true })
      const scroll = page.locator('[data-conversation-scroll]')
      await expect.poll(async () => {
        const distanceFromBottom = await scroll.evaluate((host) => {
          host.scrollTop = host.scrollHeight
          return host.scrollHeight - host.clientHeight - host.scrollTop
        })
        return Math.abs(distanceFromBottom) <= 1 && await backToBottom.count() === 0
      }, { timeout: 10_000 }).toBe(true)
    }
    return await captureStableAria(page, selector, workspaceCwd)
  } finally {
    for (const index of opened.reverse()) {
      const control = controls.nth(index)
      if (await control.getAttribute('aria-expanded') === 'true') await control.click()
    }
  }
}

/**
 * Compare a normalized golden, or rewrite it under refresh. Refresh is the
 * ONLY writer: a missing golden in replay mode fails with the healing command
 * instead of silently self-bootstrapping.
 * @param goldenPath - the committed ui.expected.md path.
 * @param actual - the stable normalized snapshot.
 * @param mode - the active snapshot mode.
 */
export async function compareOrRefreshGolden(goldenPath: string, actual: string, mode: WebSnapshotMode): Promise<void> {
  const payload = `${actual}\n`
  if (mode === 'refresh') {
    await writeFile(goldenPath, payload)
    return
  }
  if (!existsSync(goldenPath)) {
    throw new Error(`missing golden ${goldenPath} — run DSH_SNAPSHOT=refresh pnpm run test:web to generate it`)
  }
  expect(payload).toBe(await readFile(goldenPath, 'utf8'))
}

/**
 * Fixture-inventory guard: the scenario directory holds exactly the expected
 * files and every committed JSONL is a header-scrubbed, typed-redaction fixed point.
 * @param dir - the scenario snapshot directory.
 * @param expected - the exact expected file inventory.
 */
export async function assertFixtureInventory(dir: string, expected: string[]): Promise<void> {
  const entries = (await readdir(dir)).sort()
  const ownsManifest = entries.includes('snapshot.yml')
  const artifacts = entries.filter(name => name !== 'snapshot.yml')
  expect(artifacts).toEqual([...expected].sort())
  if (ownsManifest) {
    const manifestPath = join(dir, 'snapshot.yml')
    const manifest = parseSnapshotManifest(await readFile(manifestPath, 'utf8'), manifestPath)
    expect(manifest.profile).toBe('web')
    if (manifest.session === undefined) {
      expect(
        artifacts.includes('session.jsonl'),
        `${dir}: session owner must carry session.jsonl`,
      ).toBe(true)
    } else {
      expect(existsSync(resolve(dir, manifest.session.source)), `${dir}: session source`).toBe(true)
    }
  }
  for (const entry of artifacts.filter(name => name.endsWith('.jsonl'))) {
    const content = await readFile(join(dir, entry), 'utf8')
    expect(scrubRequestHeaders(content), `${dir}/${entry} carries request-header bulk`).toBe(content)
    expect(redactSessionSnapshotIds([content]), `${dir}/${entry} carries unredacted identities`).toEqual([content])
  }
}

/**
 * Console tripwires: reconnect/gap-repair self-healing or a pageerror must
 * fail the scenario, not mask a dead wire behind eventual consistency.
 * @param page - the page under test.
 * @returns live warning/pageerror collectors to assert empty at scenario end.
 */
export function watchConsole(page: Page): { warnings: string[]; pageErrors: string[] } {
  const warnings: string[] = []
  const pageErrors: string[] = []
  page.on('console', (message) => {
    const text = message.text()
    if (/connection lost|gap repair|discontinuous/i.test(text)) warnings.push(text)
  })
  page.on('pageerror', (error) => { pageErrors.push(String(error)) })
  return { warnings, pageErrors }
}

/**
 * Remove only connection-loss warnings emitted after an intentional reload.
 * Earlier warnings and all gap-repair/discontinuity warnings remain fatal.
 * @param tripwire - the live console-warning collector.
 * @param warningStart - warning count captured immediately before reloading.
 */
export function acknowledgeReloadConnectionLoss(
  tripwire: ReturnType<typeof watchConsole>,
  warningStart: number,
): void {
  const reloadWarnings = tripwire.warnings.splice(warningStart)
  tripwire.warnings.push(...reloadWarnings.filter(text => !/connection lost/i.test(text)))
}
