/**
 * Doc-sync gate for package README Model Experience sections. It validates
 * audited package classifications, model/token/KV-cache fields, package-owned
 * text blocks, generated-catalog links, and final-section order. See the
 * [Model Experience Agent Note](../.agents/notes/implemented/process/2026-07-12-package-model-experience-contract.md).
 */

import { existsSync, globSync, readFileSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { markdownHeadingLines, markdownProseLines, type MarkdownProseLine } from './markdown.ts'

const root = resolve(import.meta.dirname, '..')
const HEADING = '## Model Experience'
const LIMITATIONS_HEADING = '## Known Limitations and Deferred Work'
const MODEL_VIEW_HEADING = '#### What the model sees'
const TOKEN_EFFECT_HEADING = '#### Token effect'
const KV_CACHE_EFFECT_HEADING = '#### KV Cache effect'
const FIELD_HEADINGS = [MODEL_VIEW_HEADING, TOKEN_EFFECT_HEADING, KV_CACHE_EFFECT_HEADING] as const

type SentenceKind = 'none' | 'indirect'

interface SentenceContract {
  kind: SentenceKind
  reason: string
}

/**
 * Generic packages whose public contract is model-agnostic. Their READMEs omit
 * Model Experience entirely; the reason stays here as reviewable audit evidence
 * so an absent section cannot be mistaken for forgotten documentation.
 */
const NO_MODEL_EXPERIENCE_SECTION: Readonly<Record<string, string>> = {
  'packages/core/scope': 'The package is a model-agnostic registration and lifecycle primitive; model-facing consumers own any context selection.',
  'packages/util/brand': 'The package only constructs plain string values and registers nothing model-facing.',
  'packages/util/home-paths': 'The package only resolves harness-owned host paths; model-facing consumers own any rendered use.',
  'packages/util/launch-environment': 'The package only resolves host environment values; model-facing consumers own any rendered use.',
  'packages/util/workspace-path': 'The package only formats Workspace paths for browser UI; it never constructs model input.',
  'packages/util/values': 'The package only validates, snapshots, compares, freezes, or rejects caller-owned values; consumers own every model-facing use.',
}

/**
 * Packages whose Model Experience is simple enough for one gated sentence plus
 * a KV-cache field. Every other package must carry canonical model-context
 * blocks. A package moves on or off this list with its context behavior.
 */
const SENTENCE_MODEL_EXPERIENCE: Readonly<Record<string, SentenceContract>> = {
  'packages/attachment/attachment': { kind: 'indirect', reason: 'The storage seam delegates model request rendering to provider adapters.' },
  'packages/attachment/attachment-local': { kind: 'indirect', reason: 'The local backend delegates model request rendering to provider adapters.' },
  'packages/mcp/mcp-manager': { kind: 'indirect', reason: 'The manager only mounts and disposes dsh-mcp-client instances; those instances own every model-facing tool and schema.' },
  'packages/shell/shell': { kind: 'indirect', reason: 'The service interface delegates all model rendering to dsh-tool-bash.' },
  'packages/shell/shell-env': { kind: 'indirect', reason: 'The env service exposes managed DSH_* facts through the shell tools (dsh-tool-bash/dsh-tool-pwsh); it registers no prompt or schema of its own.' },
  'packages/shell/bash-local': { kind: 'indirect', reason: 'The executor backend delegates model rendering to dsh-tool-bash.' },
  'packages/shell/pwsh-local': { kind: 'indirect', reason: 'The executor backend delegates model rendering to dsh-tool-pwsh.' },
  'packages/code-runtime/code-runtime': { kind: 'indirect', reason: 'The service interface delegates model rendering to PTC mode in dsh-tools.' },
  'packages/core/agent-tool-presentation': { kind: 'indirect', reason: 'The row only selects between the two projections dsh-tools owns; it registers no prompt, schema, or result of its own.' },
  'packages/code-runtime/code-runtime-worker-thread': { kind: 'indirect', reason: 'The worker backend delegates model rendering to PTC mode in dsh-tools.' },
  'packages/code-runtime/code-runtime-python': { kind: 'indirect', reason: 'The CPython subprocess backend delegates model rendering to PTC mode in dsh-tools.' },
  'packages/client/ui-agent-preset': { kind: 'indirect', reason: 'Browser-side settings row; the preset it selects owns every model-facing effect.' },
  'packages/util/crypto': { kind: 'indirect', reason: 'Pure identifier minting; the ids consumers mint with it never enter prompts as semantic content.' },
  'packages/util/deque': { kind: 'none', reason: 'In-process collection primitive; registers nothing model-facing.' },
  'packages/util/time': { kind: 'indirect', reason: 'Pure zone validation; the consumer that records a canonical zone owns the model-visible line derived from it.' },
  'packages/core/agent-default-model': { kind: 'indirect', reason: 'The service supplies a ModelSelection; request assembly and adapters own the model-visible request.' },
  'packages/llm/deepseek-llm-api-extensions': { kind: 'indirect', reason: 'The registry contributes model-hidden provider fields; dsh-llm-deepseek owns their wire placement.' },
  'packages/preset/agent-presets': { kind: 'indirect', reason: 'The mount installs a preset\'s own plugins, which own every model-facing registration it makes visible.' },
  'packages/typert/registry': { kind: 'none', reason: 'Runtime type registry; consumers (cordis_inspect, wire faces, gates) own any model-visible projection of registry contents.' },
  'packages/typert/loader': { kind: 'none', reason: 'Loader integration only registers generated artifacts; consumers own any model-visible projection.' },
  'packages/e2b/e2b': { kind: 'none', reason: 'The shared remote-runtime owner registers no model context; provider adapters and consumers own rendered effects.' },
  'packages/client/hmr': { kind: 'none', reason: 'Browser-side UI plugin layer; registers nothing model-facing.' },
  'packages/client/modules': { kind: 'none', reason: 'Browser-side module-loading kernel machinery; registers nothing model-facing.' },
  'packages/test-support/client-runtime': { kind: 'none', reason: 'Browser-side test infrastructure (jsdom bench); registers nothing model-facing.' },
  'packages/experimental/webworker-runtime': { kind: 'none', reason: 'Browser-side host runtime and Node-compatibility layer; the plugins it boots own every model-facing registration.' },
  'packages/experimental/webworker-packer': { kind: 'none', reason: 'Build-time image writer; its output reaches a model only through the tree the worker then boots.' },
  'packages/experimental/inspector': { kind: 'none', reason: 'Developer diagnostics transport; it observes runtime activity without changing model requests.' },
  'packages/client/ui-slots': { kind: 'none', reason: 'Browser-side UI plugin layer; registers nothing model-facing.' },
  'packages/client/ui-attachment': { kind: 'none', reason: 'Browser-side UI plugin layer; registers nothing model-facing.' },
  'packages/client/ui-primitives': { kind: 'none', reason: 'Browser-side UI plugin layer; registers nothing model-facing.' },
  'packages/client/store': { kind: 'none', reason: 'Browser-side state primitives; register nothing model-facing.' },
  'packages/client/ui-renderer': { kind: 'none', reason: 'Browser-side render assembly; registers nothing model-facing.' },
  'packages/client/ui-session': { kind: 'none', reason: 'Browser-side Session adapter; registers nothing model-facing.' },
  'packages/client/connection': { kind: 'none', reason: 'Browser-side UI plugin layer; registers nothing model-facing.' },
  'packages/api/remotes': { kind: 'none', reason: 'The Remote BFF selects business methods and forwarded events; selected services own any model-visible effect.' },
  'packages/experimental/agent-team-web-profile': { kind: 'indirect', reason: 'The private Web layer delegates model composition to the Host-side Agent Teams profile.' },
  'packages/experimental/client-ui-agent-team': { kind: 'none', reason: 'The browser projection and task controls register no model-facing input.' },
  'packages/client/ui-layout': { kind: 'none', reason: 'Browser-side UI plugin layer; registers nothing model-facing.' },
  'packages/client/ui-sidebar': { kind: 'none', reason: 'Browser-side UI plugin layer; registers nothing model-facing.' },
  'packages/client/ui-brand-official': { kind: 'none', reason: 'Browser-side presentation occupants; registers nothing model-facing.' },
  'packages/client/ui-conversation': { kind: 'none', reason: 'Browser-side UI plugin layer; registers nothing model-facing.' },
  'packages/client/ui-approval': { kind: 'none', reason: 'Browser-side approval presentation; registers nothing model-facing.' },
  'packages/client/ui-chat': { kind: 'none', reason: 'Browser-side Chat presentation; registers nothing model-facing.' },
  'packages/client/ui-message-feedback': { kind: 'none', reason: 'Browser-side controls over the message-feedback sidecar; ratings and notes never enter the Session log, model context, or telemetry.' },
  'packages/client/ui-tool': { kind: 'none', reason: 'Browser-side Tool presentation layer; renders logged calls without changing model context.' },
  'packages/client/ui-jobs': { kind: 'none', reason: 'Browser-side read-only projection of ctx.jobs records; dsh-tool-jobs owns the model-facing behavior.' },
  'packages/client/ui-schedule': { kind: 'none', reason: 'Browser-side read-only projection of active Schedule records; dsh-schedule owns the model-facing tools and delivery.' },
  'packages/client/ui-workflow-run': { kind: 'none', reason: 'Browser-side UI plugin layer; renders durable workflow records without changing model context.' },
  'packages/client/ui-input-trigger': { kind: 'none', reason: 'Browser-side UI plugin layer; registers nothing model-facing.' },
  'packages/client/ui-reference': { kind: 'indirect', reason: 'Browser-side reference selection delegates file guidance and session snapshot preparation to Host-owned providers.' },
  'packages/client/ui-commands': { kind: 'indirect', reason: 'The dispatch paths trigger the host command.execute RPC; each command handler\'s host package owns any model-visible effect.' },
  'packages/client/ui-model-selection': { kind: 'indirect', reason: 'Selection routes session.selectModel; the Host snapshots the selection at the next prompt-assembly boundary and owns the model-visible effect.' },
  'packages/client/ui-goal': { kind: 'indirect', reason: 'The strip verbs route goal.* mutations; the host GoalService owns the model-visible goal/change context message.' },
  'packages/extensions/ui-cordis': { kind: 'indirect', reason: 'The definition card drives the host dynamic run/stop verbs that the model\'s cordis_run/cordis_stop tools also reach; the runner owns any model-visible effect.' },
  'packages/client/ui-permission-presets': { kind: 'indirect', reason: 'The picker submits the host /permission command; the knob events it appends own the model-visible effect through the sandbox/approval consumers.' },
  'packages/client/ui-settings-plugins': { kind: 'none', reason: 'Browser-side settings surface; registers no model surface.' },
  'packages/client/ui-plan': { kind: 'indirect', reason: 'The chip dispatches /plan off; dsh-plan-mode owns the model-visible policy, exit tool, and logged state.' },
  'packages/client/ui-user-questions': { kind: 'indirect', reason: 'The package mounts dsh-tool-ask-user; that tool owns the model-visible schema and answer rendering.' },
  'packages/client/ui-trajectory': { kind: 'none', reason: 'Browser-side UI plugin layer; registers nothing model-facing.' },
  'packages/client/ui-workspace': { kind: 'none', reason: 'Browser-side UI plugin layer; registers nothing model-facing.' },
  'packages/client/ui-directory-picker-browse': { kind: 'none', reason: 'Browser-side directory-browsing surface; registers nothing model-facing.' },
  'packages/client/ui-directory-picker-native': { kind: 'none', reason: 'Browser-side surface driving the host OS chooser; registers nothing model-facing.' },
  'packages/client/ui-theme': { kind: 'none', reason: 'Browser-side UI plugin layer; registers nothing model-facing.' },
  'packages/client/ui-settings': { kind: 'none', reason: 'Browser-side UI plugin layer; registers nothing model-facing.' },
  'packages/client/ui-settings-general': { kind: 'none', reason: 'Browser-side UI plugin layer; registers nothing model-facing.' },
  'packages/client/ui-settings-models': { kind: 'none', reason: 'Browser-side UI plugin layer; registers nothing model-facing.' },
  'packages/client/ui-settings-plugin-inventory': { kind: 'none', reason: 'Browser-side inventory projection; registers nothing model-facing.' },
  'packages/client/locale': { kind: 'none', reason: 'Browser-side UI plugin layer; registers nothing model-facing.' },
  'packages/client/web': { kind: 'none', reason: 'Browser-side UI plugin layer; registers nothing model-facing.' },
  'packages/context/file-reference': { kind: 'indirect', reason: 'The discovery seam and grammar delegate model guidance to the composed provider.' },
  'packages/fs/fs': { kind: 'indirect', reason: 'The service interface delegates model rendering to dsh-tool-fs.' },
  'packages/e2b/fs-e2b': { kind: 'indirect', reason: 'The provider backend delegates model rendering to dsh-tool-fs.' },
  'packages/fs/fs-local': { kind: 'indirect', reason: 'The provider backend delegates model rendering to dsh-tool-fs.' },
  'packages/hooks/hook-protocol': { kind: 'indirect', reason: 'Only the hook bridge plugins render decoded hook output to a model.' },
  'packages/host/directory-picker': { kind: 'none', reason: 'The GUI-host picking seam registers nothing model-facing.' },
  'packages/host/directory-picker-auto': { kind: 'none', reason: 'The GUI-host picking chooser only mounts a backend row; it registers nothing model-facing.' },
  'packages/host/directory-picker-browse': { kind: 'none', reason: 'The GUI-host picking backend registers nothing model-facing.' },
  'packages/host/directory-picker-native': { kind: 'none', reason: 'The GUI-host picking backend registers nothing model-facing.' },
  'packages/host/webserver': { kind: 'none', reason: 'The HTTP carrier bridges browser and API handler and registers nothing model-facing.' },
  'packages/webhook/webhook-github': { kind: 'indirect', reason: 'The adapter delegates model-visible text to matching rules and dsh-webhook.' },
  'packages/host/frontend-static': { kind: 'none', reason: 'The SPA dist server answers browser asset requests and registers nothing model-facing.' },
  'packages/host/plugin-inventory': { kind: 'none', reason: 'Host-side read-only Loader projection; registers nothing model-facing.' },
  'packages/bundle/base': { kind: 'indirect', reason: 'The bundle is a patch-list carrier; each inserted row\'s package owns its model-facing behavior.' },
  'packages/bundle/headless': { kind: 'none', reason: 'The one-shot runner submits the task as an ordinary user message; prompts and tools belong to the composed base and headless bundles.' },
  'packages/llm/llm': { kind: 'none', reason: 'The adapter registry forwards already-assembled requests unchanged.' },
  'packages/llm/token-meter': { kind: 'indirect', reason: 'The measurement service leaves model-visible changes to its consumers.' },
  'packages/lsp/lsp': { kind: 'indirect', reason: 'The provider registry delegates model rendering to dsh-tool-lsp.' },
  'packages/lsp/lsp-stdio': { kind: 'indirect', reason: 'The provider backend delegates model rendering to dsh-tool-lsp.' },
  'packages/subprocess/subprocess': { kind: 'indirect', reason: 'The seam delegates all model rendering to consumer seams such as the bash executor family.' },
  'packages/e2b/subprocess-e2b': { kind: 'indirect', reason: 'The remote spawn backend delegates model rendering to consumer seams such as the bash executor family.' },
  'packages/subprocess/subprocess-local': { kind: 'indirect', reason: 'The spawn backend delegates model rendering to consumer seams such as the bash executor family.' },
  'packages/sandbox/sandbox-local': { kind: 'indirect', reason: 'The provider backend delegates model rendering to dsh-bash-sandbox and dsh-tool-bash.' },
  'packages/sandbox/sandbox-windows-acl': { kind: 'indirect', reason: 'The provider backend delegates model rendering to the shell/pwsh sandbox executors and their tools.' },
  'packages/sdk/client': { kind: 'none', reason: 'Client-process library; model-facing behavior lives in the spawned runtime\'s composed plugins.' },
  'packages/sdk/protocol': { kind: 'none', reason: 'Client-facing wire library; the runtime plugins behind the serving entry own model-facing behavior.' },
  'packages/session/session-projection': { kind: 'none', reason: 'The projection registry serves client-facing read models of already-logged session state and registers nothing model-facing.' },
  'packages/session/session-projection-cache': { kind: 'none', reason: 'The persisted cache accelerates host-side cold reads of projection state and registers nothing model-facing.' },
  'packages/session/session-stats': { kind: 'none', reason: 'The sessionStats unit folds already-logged step boundaries into a client-facing read model and registers nothing model-facing.' },
  'packages/session-query/session-query': { kind: 'none', reason: 'The trusted query service exposes cloned records only to callers and registers nothing model-facing.' },
  'packages/session-query/session-query-sqlite': { kind: 'none', reason: 'The search backend returns hits only to callers and registers nothing model-facing.' },
  'packages/settings/settings': { kind: 'indirect', reason: 'The seam stores and resolves user settings; consumer plugins own any model-facing content fed by a value.' },
  'packages/settings/settings-file': { kind: 'indirect', reason: 'The file provider stores and publishes namespace sections; consumers of ctx.settings own any model-facing behavior.' },
  'packages/credentials/credentials': { kind: 'indirect', reason: 'The seam resolves credential references; the consuming adapter owns every model-facing use a value authorizes.' },
  'packages/credentials/credentials-local': { kind: 'indirect', reason: 'The file/environment provider stores credential values; consumers of ctx.credentials own any model-facing behavior.' },
  'packages/credentials/authorization': { kind: 'none', reason: 'A configuration-time conversation with a human; no flow, notice, or prompt reaches a model request.' },
  'packages/util/atomic-write': { kind: 'none', reason: 'Pure filesystem write primitive; registers nothing model-facing.' },
  'packages/session/session-telemetry': { kind: 'none', reason: 'The seam observes the session stream and hands redacted copies outward; it registers nothing model-facing.' },
  'packages/session/session-telemetry-otel': { kind: 'none', reason: 'The backend forwards seam records into the OTel SDK pipeline and registers nothing model-facing.' },
  'packages/identity/anonymous-user-id': { kind: 'none', reason: 'The shared identifier reaches DeepSeek only as model-hidden HTTP metadata; it registers nothing model-facing.' },
  'packages/skill/skill': { kind: 'indirect', reason: 'The provider registry delegates model rendering to dsh-tool-skill.' },
  'packages/skill/skill-badge': { kind: 'indirect', reason: 'The bundled provider delegates model rendering to dsh-tool-skill.' },
  'packages/skill/skill-filesystem': { kind: 'indirect', reason: 'The provider backend delegates model rendering to dsh-tool-skill.' },
  'packages/spill/spill': { kind: 'indirect', reason: 'The storage seam delegates model rendering to spill consumers.' },
  'packages/spill/spill-local': { kind: 'indirect', reason: 'The storage backend delegates model rendering to spill consumers.' },
  'packages/test-support/session-snapshot': { kind: 'none', reason: 'The test harness observes and normalizes transcripts without changing live requests.' },
  'packages/test-support/agent-loop-testkit': { kind: 'none', reason: 'The test helper mounts services but neither drives nor modifies model requests.' },
  'packages/runtime-diagnostics/invariants': { kind: 'none', reason: 'The observer validates requests but never rewrites their context.' },
  'packages/test-support/loader-smoke': { kind: 'none', reason: 'The test harness submits an ordinary user task but delegates prompt and tool composition to the loaded tree.' },
  'packages/test-support/llm-mock-server': { kind: 'none', reason: 'The test server substitutes provider wire behavior without invoking a real model.' },
  'packages/test-support/llm-replay': { kind: 'none', reason: 'The keyless adapter invokes no provider model.' },
  'packages/api/gateway': { kind: 'none', reason: 'Remote dispatch infrastructure; invoked business methods own any model-visible effect.' },
  'packages/api/session-controller': { kind: 'none', reason: 'Session API and transport owner; invoked Agent commands own any model-visible effect.' },
  'packages/api/settings-controller': { kind: 'none', reason: 'Configuration-surface API owner; it registers no prompt, tool, or session event.' },
  'packages/api/workspace-controller': { kind: 'none', reason: 'Workspace API and state projection owner; it registers no prompt, tool, or session event.' },
  'packages/typert/protocol': { kind: 'none', reason: 'Compiler-independent Remote protocol declarations; registers nothing model-facing.' },
  'packages/typert/generator': { kind: 'none', reason: 'The build-time generator runs outside any agent runtime and touches no model request.' },
  'packages/jobs/jobs': { kind: 'indirect', reason: 'Producer and controller plugins own all model rendering over the job registry.' },
  'packages/jobs/jobs-local': { kind: 'indirect', reason: 'The registry backend delegates model rendering to producer plugins and dsh-tool-jobs.' },
  'packages/boot/app-boot': { kind: 'indirect', reason: 'Only the loaded plugin tree contributes model context.' },
  'packages/boot/cmdline': { kind: 'none', reason: 'Resolves the process command line before any session exists; configured rows own every model-visible consequence.' },
  'packages/interaction/permission-presets': { kind: 'indirect', reason: 'The service writes mechanism events rendered by dsh-user-approval and dsh-tool-bash.' },
  'packages/interaction/user-questions': { kind: 'indirect', reason: 'Model-facing consumers render provider answers and seam errors.' },
  'packages/util/timeout': { kind: 'indirect', reason: 'Only timeout consumers render timeout outcomes.' },
  'packages/util/output-retention': { kind: 'indirect', reason: 'Only retention consumers render retained content and omission metadata.' },
  'packages/util/native-command': { kind: 'none', reason: 'The host-side subprocess runner registers nothing model-facing.' },
  'packages/web/web': { kind: 'indirect', reason: 'The provider registry delegates model rendering to dsh-tool-web.' },
  'packages/web/web-fetch-http': { kind: 'indirect', reason: 'The provider backend delegates model rendering to dsh-tool-web.' },
  'packages/web/web-search-exa': { kind: 'indirect', reason: 'The provider backend delegates model rendering to dsh-tool-web.' },
  'packages/workflow/workflow': { kind: 'indirect', reason: 'The service delegates parent and child model rendering to its consumer and engine.' },
}

interface Failure {
  path: string
  message: string
}

type Line = MarkdownProseLine

interface ModelExperienceEntry {
  heading: Line
  modelView: Line
  tokenEffect: Line
  kvCacheEffect: Line
  title: string
  modelViewVerbatimBlocks: number
  verbatimBlocks: number
}

interface ParsedField {
  value: Line
  verbatimBlocks: number
}

/** Validate H5-plus-markdown literals nested under one Model Experience field. */
function validateNestedVerbatim(raw: readonly string[], fragments: Set<string>): { blocks: number; error?: string } {
  let cursor = 0
  while (raw[cursor]?.trim().length === 0) cursor += 1
  if (cursor === raw.length) return { blocks: 0 }

  let blocks = 0
  while (true) {
    while (raw[cursor]?.trim().length === 0) cursor += 1
    if (cursor === raw.length) break
    if (!/^##### \S/.test(raw[cursor] ?? '')) {
      return { blocks, error: 'content after a field paragraph must be a titled H5 verbatim block' }
    }
    const title = (raw[cursor] as string).slice('##### '.length)
    const fragment = headingFragment(title)
    if (fragment.length === 0) return { blocks, error: 'verbatim H5 title must be non-empty' }
    if (fragments.has(fragment)) {
      return { blocks, error: `verbatim H5 title ${JSON.stringify(title)} is duplicated within its model-context entry` }
    }
    fragments.add(fragment)
    cursor += 1
    while (raw[cursor]?.trim().length === 0) cursor += 1
    if (raw[cursor] !== '```markdown') {
      return { blocks, error: 'each nested verbatim H5 requires an exact ```markdown fence' }
    }
    cursor += 1
    const contentStart = cursor
    while (cursor < raw.length && raw[cursor] !== '```') cursor += 1
    if (cursor === raw.length) return { blocks, error: 'unterminated nested ```markdown fence' }
    if (cursor === contentStart) return { blocks, error: 'nested ```markdown fence must not be empty' }
    cursor += 1
    blocks += 1
  }
  return { blocks }
}

/** GitHub-style fragment for the simple ASCII nested titles allowed by these rules. */
function headingFragment(title: string): string {
  return title.toLowerCase().replaceAll('`', '').replaceAll(/[^a-z0-9 _-]/g, '').trim().replaceAll(/\s+/g, '-')
}

/** A direct stable system-prompt contribution, as named by the README rules. */
function isDirectSystemPromptEntry(title: string): boolean {
  return /\bsystem prompt\b/i.test(title)
}

/** Anchored generated-catalog links in one model-view field. */
function toolCatalogLinkFragments(text: string): string[] {
  return [...text.matchAll(/\]\(\.\.\/\.\.\/\.\.\/docs\/tool-catalog\.md#([a-z0-9_-]+)\)/g)]
    .map(match => match[1] as string)
}

const toolCatalogFragments = new Set<string>()
for (const line of readFileSync(resolve(root, 'docs/tool-catalog.md'), 'utf8').split('\n')) {
  const title = /^## (.+)$/.exec(line)?.[1]
  if (title !== undefined) toolCatalogFragments.add(headingFragment(title))
}

const failures: Failure[] = []
const packageJsons = globSync('packages/*/*/package.json', { cwd: root }).map(path => path.split(sep).join('/')).sort()
const scannedPackages = new Set(packageJsons.map(path => path.slice(0, -'/package.json'.length)))
let structuredCount = 0
let modelContextEntryCount = 0
let omittedSectionCount = 0
let explainedNoneCount = 0
let indirectCount = 0
let verbatimBlockCount = 0
let systemPromptEntryCount = 0
let toolSchemaEntryCount = 0
let kvCacheEffectCount = 0

for (const [pkg, reason] of Object.entries(NO_MODEL_EXPERIENCE_SECTION)) {
  if (!scannedPackages.has(pkg)) {
    failures.push({ path: `${pkg}/README.md`, message: 'no-section allowlist entry does not name a scanned package' })
  }
  if (reason.trim().length === 0) {
    failures.push({ path: `${pkg}/README.md`, message: 'no-section allowlist entry must retain its audit justification' })
  }
  if (SENTENCE_MODEL_EXPERIENCE[pkg] !== undefined) {
    failures.push({ path: `${pkg}/README.md`, message: 'package cannot appear in both Model Experience allowlists' })
  }
}

for (const [pkg, contract] of Object.entries(SENTENCE_MODEL_EXPERIENCE)) {
  if (!scannedPackages.has(pkg)) {
    failures.push({ path: `${pkg}/README.md`, message: 'sentence allowlist entry does not name a scanned package' })
  }
  if (contract.reason.trim().length === 0) {
    failures.push({ path: `${pkg}/README.md`, message: 'sentence allowlist entry must justify why structured model-context entries are unnecessary' })
  }
}

for (const packageJson of packageJsons) {
  const pkg = packageJson.slice(0, -'/package.json'.length)
  const readme = packageJson.replace(/package\.json$/, 'README.md')
  const abs = resolve(root, readme)
  if (!existsSync(abs)) {
    failures.push({ path: readme, message: 'missing package README' })
    continue
  }

  const text = readFileSync(abs, 'utf8')
  const rawLines = text.split('\n')
  const lines = markdownProseLines(text)
  const headings = markdownHeadingLines(text)
  const h2Headings = headings.filter(heading => heading.depth === 2)
  const modelExperienceHeadings = headings.filter(heading => heading.text
    .trim().replaceAll(/\s+/g, ' ').toLowerCase() === 'model experience')
  const modelHeadings = modelExperienceHeadings.filter(heading => heading.depth === 2 && heading.raw === HEADING)
  if (NO_MODEL_EXPERIENCE_SECTION[pkg] !== undefined) {
    if (modelExperienceHeadings.length !== 0) {
      for (const heading of modelExperienceHeadings) {
        failures.push({ path: readme, message: `line ${heading.index}: audited model-agnostic package must omit every Model Experience heading; found ${JSON.stringify(heading.raw)}` })
      }
    } else {
      omittedSectionCount += 1
    }
    continue
  }
  const nonCanonicalModelHeading = modelExperienceHeadings.find(heading => heading.depth !== 2 || heading.raw !== HEADING)
  if (nonCanonicalModelHeading !== undefined) {
    failures.push({ path: readme, message: `line ${nonCanonicalModelHeading.index}: non-canonical Model Experience heading ${JSON.stringify(nonCanonicalModelHeading.raw)}; use exactly ${JSON.stringify(HEADING)}` })
    continue
  }
  const modelHeading = modelHeadings.at(0)
  if (modelHeading === undefined) {
    failures.push({
      path: readme,
      message: `missing ${HEADING}`,
    })
    continue
  }
  if (modelHeadings.length !== 1) {
    failures.push({ path: readme, message: `contains ${modelHeadings.length} copies of ${HEADING}` })
    continue
  }
  const modelH2Index = h2Headings.indexOf(modelHeading)
  const limitationsH2Index = h2Headings.findIndex(heading => heading.depth === 2 && heading.raw === LIMITATIONS_HEADING)
  if (limitationsH2Index >= 0) {
    if (modelH2Index !== h2Headings.length - 2 || limitationsH2Index !== h2Headings.length - 1) {
      failures.push({
        path: readme,
        message: `${HEADING} and ${LIMITATIONS_HEADING} must be the final two H2 sections, in that order`,
      })
      continue
    }
  } else if (modelH2Index !== h2Headings.length - 1) {
    failures.push({ path: readme, message: `${HEADING} must be the final H2 when ${LIMITATIONS_HEADING} is absent` })
    continue
  }

  const modelHeadingAt = lines.findIndex(line => line.index === modelHeading.index)
  const body = lines.slice(modelHeadingAt + 1)
  const h2Lines = new Set(h2Headings.map(heading => heading.index))
  const nextH2 = body.findIndex(line => h2Lines.has(line.index))
  const section = nextH2 < 0 ? body : body.slice(0, nextH2)
  const nextH2Line = nextH2 < 0 ? rawLines.length + 1 : (body[nextH2] as Line).index
  const rawSection = rawLines.slice(modelHeading.index, nextH2Line - 1)
  const content = section.filter(line => line.raw.trim().length > 0)
  const sentenceContract = SENTENCE_MODEL_EXPERIENCE[pkg]
  if (sentenceContract !== undefined) {
    const pattern = sentenceContract.kind === 'none' ? /^None, as .+\.$/ : /^Indirectly, through .+\.$/
    const rawContent = rawSection.filter(line => line.trim().length > 0)
    const sentence = content[0]
    const kvCacheHeading = content[1]
    const kvCacheEffect = content[2]
    if (content.length !== 3 || rawContent.length !== 3 || !pattern.test(sentence?.raw ?? '')) {
      const prefix = sentenceContract.kind === 'none' ? 'None, as ' : 'Indirectly, through '
      failures.push({ path: readme, message: `must contain exactly one sentence beginning ${JSON.stringify(prefix)} and ending with a period, followed by ${KV_CACHE_EFFECT_HEADING} and one non-empty paragraph` })
      continue
    }
    if (kvCacheHeading?.raw !== KV_CACHE_EFFECT_HEADING
      || kvCacheEffect === undefined
      || /^#{1,6} /.test(kvCacheEffect.raw)
      || kvCacheEffect.raw.trim().length === 0) {
      failures.push({ path: readme, message: `line ${kvCacheHeading?.index ?? sentence?.index ?? modelHeading.index}: short Model Experience form requires exact ${KV_CACHE_EFFECT_HEADING} and one non-empty paragraph` })
      continue
    }
    if (sentence === undefined
      || sentence.index !== modelHeading.index + 2
      || kvCacheHeading.index !== sentence.index + 2
      || kvCacheEffect.index !== kvCacheHeading.index + 2) {
      failures.push({ path: readme, message: 'short Model Experience sentence, KV-cache H4, and paragraph require one blank line between each element' })
      continue
    }
    if (sentenceContract.kind === 'none') explainedNoneCount += 1
    else indirectCount += 1
    kvCacheEffectCount += 1
    continue
  }

  const shortSentence = content.find(line => line.raw === 'None.' || /^None, as |^Indirectly, through /.test(line.raw))
  if (shortSentence !== undefined) {
    failures.push({ path: readme, message: `line ${shortSentence.index}: short Model Experience form requires an audited entry in SENTENCE_MODEL_EXPERIENCE` })
    continue
  }

  const entryStarts = content
    .map((line, index) => ({ line, index }))
    .filter(entry => /^### \S/.test(entry.line.raw))
  if (entryStarts.length === 0 || entryStarts[0]?.index !== 0) {
    failures.push({ path: readme, message: 'must contain one or more complete model-context entries' })
    continue
  }

  const modelContextEntries: ModelExperienceEntry[] = []
  const entryFragments = new Set<string>()
  let entryError = false
  for (let entryIndex = 0; entryIndex < entryStarts.length; entryIndex += 1) {
    const start = entryStarts[entryIndex] as { line: Line; index: number }
    const end = entryStarts[entryIndex + 1]?.index ?? content.length
    const entries = content.slice(start.index, end)
    const heading = entries[0] as Line
    const title = heading.raw.slice('### '.length)
    const fragment = headingFragment(title)
    if (fragment.length === 0) {
      failures.push({ path: readme, message: `line ${heading.index}: each model-context entry requires a non-empty H3 heading` })
      entryError = true
      break
    }
    if (entryFragments.has(fragment)) {
      failures.push({ path: readme, message: `line ${heading.index}: duplicate model-context entry link fragment ${JSON.stringify(fragment)}` })
      entryError = true
      break
    }
    const fieldStarts = entries
      .map((line, index) => ({ line, index }))
      .filter(entry => /^#### \S/.test(entry.line.raw))
    if (fieldStarts.length !== FIELD_HEADINGS.length || fieldStarts[0]?.index !== 1) {
      failures.push({ path: readme, message: `line ${heading.index}: model-context entry requires exactly three ordered H4 fields: ${FIELD_HEADINGS.join(', ')}` })
      entryError = true
      break
    }
    if ((entryIndex === 0 && heading.index !== modelHeading.index + 2)
      || rawLines[heading.index - 2]?.trim().length !== 0
      || fieldStarts[0].line.index !== heading.index + 2) {
      failures.push({ path: readme, message: `line ${heading.index}: model-context entry heading and first field require one blank line between them` })
      entryError = true
      break
    }
    const parsedFields: ParsedField[] = []
    const verbatimFragments = new Set<string>()
    for (let fieldIndex = 0; fieldIndex < FIELD_HEADINGS.length; fieldIndex += 1) {
      const fieldStart = fieldStarts[fieldIndex] as { line: Line; index: number }
      const expectedHeading = FIELD_HEADINGS[fieldIndex] as string
      if (fieldStart.line.raw !== expectedHeading) {
        failures.push({ path: readme, message: `line ${fieldStart.line.index}: expected exact field heading ${JSON.stringify(expectedHeading)}, found ${JSON.stringify(fieldStart.line.raw)}` })
        entryError = true
        break
      }
      const fieldEnd = fieldStarts[fieldIndex + 1]?.index ?? entries.length
      const fieldEntries = entries.slice(fieldStart.index, fieldEnd)
      const value = fieldEntries[1]
      if (value === undefined || /^#{1,6} /.test(value.raw) || value.raw.trim().length === 0) {
        failures.push({ path: readme, message: `line ${fieldStart.line.index}: ${expectedHeading} requires one non-empty paragraph` })
        entryError = true
        break
      }
      if (value.index !== fieldStart.line.index + 2) {
        failures.push({ path: readme, message: `line ${fieldStart.line.index}: ${expectedHeading} and its paragraph require one blank line between them` })
        entryError = true
        break
      }
      const unexpected = fieldEntries.slice(2).find(line => !/^##### \S/.test(line.raw))
      if (unexpected !== undefined) {
        failures.push({ path: readme, message: `line ${unexpected.index}: content after ${expectedHeading} paragraph must be a titled H5 plus \`markdown\` fence owned by that field` })
        entryError = true
        break
      }
      const nextHeadingLine = fieldStarts[fieldIndex + 1]?.line.index
        ?? entryStarts[entryIndex + 1]?.line.index
        ?? nextH2Line
      if (rawLines[nextHeadingLine - 2]?.trim().length !== 0) {
        failures.push({ path: readme, message: `line ${nextHeadingLine}: Model Experience headings require a preceding blank line` })
        entryError = true
        break
      }
      const verbatim = validateNestedVerbatim(rawLines.slice(value.index, nextHeadingLine - 1), verbatimFragments)
      if (verbatim.error !== undefined) {
        failures.push({ path: readme, message: `line ${value.index}: ${verbatim.error}` })
        entryError = true
        break
      }
      if (fieldEntries.length - 2 !== verbatim.blocks) {
        failures.push({ path: readme, message: `line ${value.index}: every nested H5 must own exactly one \`markdown\` fence` })
        entryError = true
        break
      }
      parsedFields.push({ value, verbatimBlocks: verbatim.blocks })
    }
    if (entryError) break
    const modelViewField = parsedFields[0] as ParsedField
    const tokenEffectField = parsedFields[1] as ParsedField
    const kvCacheEffectField = parsedFields[2] as ParsedField
    const modelView = modelViewField.value
    const tokenEffect = tokenEffectField.value
    const kvCacheEffect = kvCacheEffectField.value
    if (/\]\(#[^)]+\)/.test(modelView.raw) || /\]\(#[^)]+\)/.test(tokenEffect.raw) || /\]\(#[^)]+\)/.test(kvCacheEffect.raw)) {
      failures.push({ path: readme, message: `line ${heading.index}: Model Experience fields must not link between local subsections; nest the H5 in its owning H4 field` })
      entryError = true
      break
    }
    entryFragments.add(fragment)
    modelContextEntries.push({
      heading,
      modelView,
      tokenEffect,
      kvCacheEffect,
      title,
      modelViewVerbatimBlocks: modelViewField.verbatimBlocks,
      verbatimBlocks: parsedFields.reduce((total, field) => total + field.verbatimBlocks, 0),
    })
  }
  if (entryError) continue

  const promptWithoutVerbatim = modelContextEntries.find(entry => isDirectSystemPromptEntry(entry.title)
    && entry.modelViewVerbatimBlocks === 0)
  if (promptWithoutVerbatim !== undefined) {
    failures.push({ path: readme, message: `line ${promptWithoutVerbatim.heading.index}: system-prompt entry must contain a titled H5 plus verbatim \`markdown\` block under ${MODEL_VIEW_HEADING}` })
    continue
  }
  const hasConcreteLiteral = modelContextEntries.some(entry => entry.verbatimBlocks > 0
    || entry.modelView.raw.includes('`')
    || entry.tokenEffect.raw.includes('`')
    || toolCatalogLinkFragments(entry.modelView.raw).length > 0)
  if (!hasConcreteLiteral) {
    failures.push({ path: readme, message: 'structured Model Experience must ground at least one entry with inline code, a nested `markdown` block, or an anchored tool-catalog link' })
    continue
  }
  let catalogError = false
  for (const entry of modelContextEntries) {
    if (!/\bschemas?\b/i.test(entry.title)) continue
    const fragments = toolCatalogLinkFragments(entry.modelView.raw)
    if (fragments.length === 0) {
      failures.push({ path: readme, message: `line ${entry.heading.index}: tool-schema entry must link an anchored section of ../../../docs/tool-catalog.md` })
      catalogError = true
      break
    }
    const invalid = fragments.find(fragment => !toolCatalogFragments.has(fragment))
    if (invalid !== undefined) {
      failures.push({ path: readme, message: `line ${entry.modelView.index}: tool-catalog link fragment ${JSON.stringify(invalid)} does not name an H2 section` })
      catalogError = true
      break
    }
  }
  if (catalogError) continue
  verbatimBlockCount += modelContextEntries.reduce((total, entry) => total + entry.verbatimBlocks, 0)
  modelContextEntryCount += modelContextEntries.length
  systemPromptEntryCount += modelContextEntries.filter(entry => isDirectSystemPromptEntry(entry.title)).length
  toolSchemaEntryCount += modelContextEntries.filter(entry => /\bschemas?\b/i.test(entry.title)).length
  kvCacheEffectCount += modelContextEntries.length
  structuredCount += 1
}

if (failures.length === 0) {
  console.log(`verify-package-readme-model-experience: ${packageJsons.length} README(s) checked (${omittedSectionCount} audited omissions, ${structuredCount} structured, ${modelContextEntryCount} model-context entries, ${kvCacheEffectCount} KV-cache fields, ${systemPromptEntryCount} fenced system-prompt entries, ${toolSchemaEntryCount} catalog-linked tool-schema entries, ${explainedNoneCount} explained none, ${indirectCount} indirect, ${verbatimBlockCount} verbatim markdown blocks), all conform.`)
  process.exit(0)
}

console.error('verify-package-readme-model-experience failed:')
for (const failure of failures) {
  console.error(`  ${relative(root, resolve(root, failure.path))}: ${failure.message}`)
}
process.exit(1)
