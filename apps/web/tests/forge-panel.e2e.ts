/** Worktree Sessions and the change request panel through the real optional bundle, a Git checkout, and a scripted GitHub CLI. */
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type {} from '@deepseek-ai/dsh-experimental-forge-session'
import { pluginRecordOf, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { initialShortcutConfig, type DesktopShortcutInput, type ShortcutRevision } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import { abbreviateHomePath } from '@deepseek-ai/dsh-util-workspace-path'
import { chromium, type Browser, type Page } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, fixtureUserPrompts, launchWebScaffold, readPersistedEvents, watchConsole,
  webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspaceZh, saveFailureShot, writeComposerDraft, ZH_BROWSER_LOCALE } from './support.ts'

declare global {
  interface Window {
    forgeKeyboard: { readonly revision: ShortcutRevision; deliver(input: DesktopShortcutInput): void }
  }
}

const BUNDLE = fileURLToPath(new URL('../../../packages/experimental/forge-bundle', import.meta.url))
const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/lifecycle-chrome/session.v4.jsonl', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/forge-panel', import.meta.url))
const MODE = webSnapshotMode()
const PULL = 'https://github.com/octo/demo/pull/7'
/** A draft change request that the double lets the panel mark ready and merge. */
const DRAFT = 'https://github.com/octo/demo/pull/9'
/** Message sent after the worktree is removed, which waits until the worktree is restored. */
const FOLLOW_UP = 'Summarize the failed check'
/** Reply to {@link FOLLOW_UP}, a model call appended after the borrowed scenario's single one. */
const FOLLOW_UP_REPLY = 'RESTORED'
const run = promisify(execFile)

/**
 * GitHub CLI double: signed in to github.com, with octo/demo allowing every
 * merge method and the viewer's usual one squash. GraphQL serves pull request
 * 7 with one failed and one passed check run, one unresolved thread, and a
 * required review, and pull request 9, an approved draft whose checks passed.
 * `gh pr ready 9` and the REST merge of pull request 9 change what later
 * queries report, through `state.json`. `gh pr diff N` prints `pr-N.diff`, or
 * fails with `pr-N.refused` on standard error when that file exists, and the raw
 * contents API serves `contents.json`, keyed by `path@commit`. Every invocation
 * is appended to `calls.jsonl`.
 */
const GH = `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const args = process.argv.slice(2)
const here = dirname(fileURLToPath(import.meta.url))
appendFileSync(join(here, 'calls.jsonl'), JSON.stringify(args) + '\\n')
const statePath = join(here, 'state.json')
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { ready: false, mergedAt: null }
const save = () => { writeFileSync(statePath, JSON.stringify(state)) }
if (args[0] === 'pr' && args[1] === 'view' && args[2] === '7') {
  const fields = args[args.indexOf('--json') + 1]
  process.stdout.write(JSON.stringify(fields === 'url'
    ? { url: 'https://github.com/octo/demo/pull/7' }
    : { number: 7, title: 'Add the pull request panel' }))
  process.exit(0)
}
if (args[0] === 'pr' && args[1] === 'ready' && args[2] === '9') {
  state.ready = true
  save()
  process.stderr.write('Pull request octo/demo#9 is marked as "ready for review"\\n')
  process.exit(0)
}
if (args[0] === 'api' && args[5] === 'repos/octo/demo/pulls/9/merge') {
  state.mergedAt = new Date().toISOString()
  save()
  process.stdout.write(JSON.stringify({ sha: 'c'.repeat(40), merged: true, message: 'Pull Request successfully merged' }))
  process.exit(0)
}
if (args[0] === 'pr' && args[1] === 'diff') {
  const refused = join(here, 'pr-' + args[2] + '.refused')
  if (existsSync(refused)) {
    process.stderr.write(readFileSync(refused, 'utf8'))
    process.exit(1)
  }
  process.stdout.write(readFileSync(join(here, 'pr-' + args[2] + '.diff'), 'utf8'))
  process.exit(0)
}
if (args[0] === 'api' && args[3] === '-H' && args[4] === 'Accept: application/vnd.github.raw+json') {
  const [resource, query] = args[5].split('?')
  const path = decodeURIComponent(resource.slice('repos/octo/demo/contents/'.length))
  const text = JSON.parse(readFileSync(join(here, 'contents.json'), 'utf8'))[path + '@' + query.slice('ref='.length)]
  if (text === undefined) {
    process.stderr.write('gh: Not Found (HTTP 404)\\n')
    process.exit(1)
  }
  process.stdout.write(text)
  process.exit(0)
}
if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write('github.com\\n  Logged in to github.com account octo\\n')
  process.exit(0)
}
if (args[0] === 'api' && args[1] === 'graphql') {
  const query = args.find(arg => arg.startsWith('query=')).slice('query='.length)
  const check = (name, conclusion, completedAt) => ({
    __typename: 'CheckRun', name, status: 'COMPLETED', conclusion,
    detailsUrl: 'https://github.com/octo/demo/actions/runs/1', startedAt: '2026-10-09T00:00:00Z', completedAt,
    checkSuite: { workflowRun: { workflow: { name: 'CI' } } },
  })
  const pulls = {
    7: {
      number: 7, url: 'https://github.com/octo/demo/pull/7', title: 'Add the pull request panel', state: 'OPEN', isDraft: false,
      updatedAt: '2026-10-09T00:00:00Z', closedAt: null, author: { login: 'octo' }, headRefName: 'feat', headRefOid: 'a'.repeat(40),
      baseRefName: 'main', additions: 128, deletions: 14, mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED',
      reviewThreads: { nodes: [{ isResolved: false }] },
      commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE', contexts: {
        pageInfo: { hasNextPage: false },
        nodes: [check('lint', 'SUCCESS', '2026-10-09T00:00:42Z'), check('test', 'FAILURE', '2026-10-09T00:02:07Z')],
      } } } }] },
    },
    9: {
      number: 9, url: 'https://github.com/octo/demo/pull/9', title: 'Add the merge button', state: state.mergedAt === null ? 'OPEN' : 'MERGED',
      isDraft: !state.ready, updatedAt: '2026-10-09T00:00:00Z', closedAt: state.mergedAt, author: { login: 'octo' },
      headRefName: 'feat/merge', headRefOid: state.head ?? 'b'.repeat(40), baseRefName: 'main', additions: 30, deletions: 2, mergeable: 'MERGEABLE',
      mergeStateStatus: state.ready ? 'CLEAN' : 'BLOCKED', reviewDecision: 'APPROVED', reviewThreads: { nodes: [] },
      commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS', contexts: {
        pageInfo: { hasNextPage: false }, nodes: [check('lint', 'SUCCESS', '2026-10-09T00:00:42Z')],
      } } } }] },
    },
  }
  const settings = {
    squashMergeAllowed: true, mergeCommitAllowed: true, rebaseMergeAllowed: true, viewerPermission: 'WRITE', viewerDefaultMergeMethod: 'SQUASH',
  }
  const data = {}
  let repository
  for (const match of query.matchAll(/(r\\d+): repository\\(|(p\\d+): pullRequest\\(number: (\\d+)\\)/g)) {
    if (match[1] !== undefined) data[repository = match[1]] = { ...settings }
    else data[repository][match[2]] = pulls[Number(match[3])] ?? null
  }
  process.stdout.write(JSON.stringify({ data }))
  process.exit(0)
}
process.stderr.write('unexpected gh invocation\\n')
process.exit(1)
`

/** Head commit of pull request 7 in the GitHub CLI double. */
const HEAD7 = 'a'.repeat(40)

/** What gh 2.100 prints for the diff of pull request 9 when GitHub refuses it for having over 300 files. */
const PR9_REFUSAL = [
  'could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of files (300). Consider using \'List pull '
  + 'requests files\' API or locally cloning the repository instead. (https://api.github.com/repos/octo/demo/pulls/9)',
  'PullRequest.diff too_large',
  '',
].join('\n')

/** Line `n` of `src/panel.ts` before (`old`) or after (`new`) pull request 7, which changes lines 2 and 15 of its 20. */
function panelLine(n: number, side: 'old' | 'new'): string {
  if (n === 2) return side === 'old' ? 'export const n2 = 2' : 'export const n2 = \'two\''
  if (n === 7) return 'export const n7 = "Long unchanged context stays wrapped while switching between Sessions and reviewing the same file"'
  if (n === 15) return side === 'old' ? 'export const n15 = 15' : 'export const n15 = \'fifteen\''
  return `export const n${n} = ${n}`
}

/** Patch of pull request 7 as `gh pr diff` prints it: two hunks of `src/panel.ts` and the new `docs/panel.md`. */
const PR7_DIFF = [
  'diff --git a/src/panel.ts b/src/panel.ts',
  'index 1111111..2222222 100644',
  '--- a/src/panel.ts',
  '+++ b/src/panel.ts',
  '@@ -1,5 +1,5 @@',
  ` ${panelLine(1, 'new')}`, `-${panelLine(2, 'old')}`, `+${panelLine(2, 'new')}`,
  ...[3, 4, 5].map(n => ` ${panelLine(n, 'new')}`),
  '@@ -12,7 +12,7 @@',
  ...[12, 13, 14].map(n => ` ${panelLine(n, 'new')}`), `-${panelLine(15, 'old')}`, `+${panelLine(15, 'new')}`,
  ...[16, 17, 18].map(n => ` ${panelLine(n, 'new')}`),
  'diff --git a/docs/panel.md b/docs/panel.md',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/docs/panel.md',
  '@@ -0,0 +1,2 @@',
  '+# Panel',
  '+Shows the change requests of a Session.',
  '',
].join('\n')

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } })
  return stdout.trim()
}

/** A Web scaffold with the bundle, a GitHub checkout of `main` and `release`, and the New Session screen of that workspace. */
interface PanelLaunch {
  readonly scaffold: WebScaffold
  readonly page: Page
  /** Temporary directory of the GitHub CLI double and its call log. */
  readonly root: string
  /** The Session's workspace, a main checkout. */
  readonly project: string
  readonly tripwire: ReturnType<typeof watchConsole>
}

/**
 * Launch the bundle against a GitHub checkout of `main` and `release` and open the New Session screen of that workspace.
 * @param failureShot - name of the screenshot saved when the test fails.
 * @param scenario - normal conversation, a restoration follow-up, or a numbered PR lookup.
 * @returns the scaffold, page, and checkout.
 */
async function launchPanel(failureShot: string, scenario: 'normal' | 'follow-up' | 'reference' = 'normal', desktop?: 'darwin' | 'win32'): Promise<PanelLaunch> {
  const resources: { scaffold?: WebScaffold; browser?: Browser } = {}
  const root = await mkdtemp(join(tmpdir(), 'dsh-forge-panel-'))
  onTestFinished(async () => {
    const failures: unknown[] = []
    await resources.browser?.close().catch((error: unknown) => failures.push(error))
    await resources.scaffold?.close().catch((error: unknown) => failures.push(error))
    await rm(root, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
    if (failures.length > 0) throw new AggregateError(failures, 'Forge panel teardown failed')
  })
  const gh = join(root, 'gh')
  await writeFile(gh, GH)
  await chmod(gh, 0o755)
  await writeFile(join(root, 'pr-7.diff'), PR7_DIFF)
  await writeFile(join(root, 'pr-9.refused'), PR9_REFUSAL)
  const panelText = `${Array.from({ length: 20 }, (_, index) => panelLine(index + 1, 'new')).join('\n')}\n`
  await writeFile(join(root, 'contents.json'), JSON.stringify({ [`src/panel.ts@${HEAD7}`]: panelText }))
  const overlay = join(root, 'forge.patch.yml')
  await writeFile(overlay, `- id: forge-github\n  config: ${JSON.stringify({ ghCommand: gh })}\n`)
  const override = join(root, 'replay.override.json')
  // The borrowed scenario records one model call, so index 1 appends the reply to the follow-up.
  if (scenario === 'follow-up') await writeFile(override, JSON.stringify({ patches: [{ at: 1, entry: { kind: 'chunks', chunks: textReply(FOLLOW_UP_REPLY) } }] }))
  if (scenario === 'reference') {
    const command = `PATH=${JSON.stringify(`.fixture-bin:${process.env.PATH ?? ''}`)} gh pr view 7 --repo octo/demo --json number,title 2>&1 | head -200`
    const call = { type: 'tool-call', id: 'view-pr', name: 'bash', arguments: JSON.stringify({ command, description: 'View PR metadata' }) }
    await writeFile(override, JSON.stringify({ patches: [
      { at: 0, entry: { kind: 'chunks', chunks: [
        { type: 'block-start', index: 0, blockType: 'tool-call' },
        { type: 'block-end', index: 0, block: call },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ] } },
      { at: 1, entry: { kind: 'chunks', chunks: textReply('Viewed PR 7.') } },
    ] }))
  }
  const scaffold = await launchWebScaffold({
    profile: { packages: [{ dir: BUNDLE, enabled: true }] },
    extraOverlayPath: overlay,
    replayFixture: FIXTURE,
    ...scenario !== 'normal' ? { replayOverride: override } : {},
    // The worktree notice, worktree records, and bindings are asserted separately from the borrowed conversation.
    compareReplaySession: false,
  })
  resources.scaffold = scaffold

  const project = join(scaffold.workspaceCwd, 'workspace')
  await mkdir(project, { recursive: true })
  await git(project, 'init', '--quiet', '--initial-branch=main')
  await git(project, 'config', 'user.name', 'Forge Panel')
  await git(project, 'config', 'user.email', 'forge-panel@example.test')
  await git(project, 'config', 'commit.gpgsign', 'false')
  await writeFile(join(project, 'README.md'), 'demo\n')
  await git(project, 'add', 'README.md')
  await git(project, 'commit', '--quiet', '-m', 'init')
  await git(project, 'remote', 'add', 'origin', 'https://github.com/octo/demo.git')
  await git(project, 'branch', 'release')
  await git(project, 'commit', '--quiet', '--allow-empty', '-m', 'main only')
  if (scenario === 'reference') {
    // The model's confined command must own the CLI double's writable call log.
    const modelBin = join(project, '.fixture-bin')
    await mkdir(modelBin)
    await writeFile(join(modelBin, 'gh'), GH)
    await chmod(join(modelBin, 'gh'), 0o755)
  }

  const browser = await chromium.launch()
  resources.browser = browser
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE, timezoneId: 'Asia/Shanghai' })
  if (desktop !== undefined) {
    // Only Electron's keyboard transport is substituted; the product registry and menus remain real.
    await page.addInitScript(({ device, config }) => {
      const mark = () => { document.documentElement.dataset.platform = device }
      if (document.documentElement === null) window.addEventListener('DOMContentLoaded', mark)
      else mark()
      const listeners = new Set<(input: DesktopShortcutInput) => void>()
      Object.assign(window, {
        forgeKeyboard: { revision: config.revision,
          deliver: (input: DesktopShortcutInput) => { for (const listener of listeners) listener(input) } },
        dshDesktop: { protocolVersion: 1,
          shortcuts: { get: async () => config, subscribe: () => () => {}, recording: async () => {}, edit: async () => { throw new Error('Unused preference edit') } },
          keyboard: {
            subscribe: (listener: (input: DesktopShortcutInput) => void) => {
              listeners.add(listener)
              return () => { listeners.delete(listener) }
            },
            closeWindow: async () => {},
          },
        },
      })
    }, { device: desktop, config: { ...initialShortcutConfig(), status: 'ready' as const } })
  }
  const tripwire = watchConsole(page)
  onTestFailed(async () => { await saveFailureShot(page, failureShot) })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  return { scaffold, page, root, project, tripwire }
}

/** Stream chunks of a model reply that is one text block. */
function textReply(text: string): unknown[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 50, outputTokens: 2, cacheReadTokens: 0, reasoningTokens: 0 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/**
 * Launch the panel and choose the worktree option of the fresh Session from `release`.
 * @param failureShot - name of the screenshot saved when the test fails.
 * @param followUp - whether the replay answers a second model call.
 * @returns the scaffold, page, and checkout.
 */
async function requestReleaseWorktree(failureShot: string, followUp = false): Promise<PanelLaunch> {
  const launched = await launchPanel(failureShot, followUp ? 'follow-up' : 'normal')
  const { page } = launched
  const option = page.locator('[data-forge-worktree]')
  await option.waitFor({ timeout: 20_000 })
  await option.getByRole('checkbox', { name: '工作树', exact: true }).check()
  await option.getByRole('button', { name: '基于 main', exact: true }).click()
  await page.getByRole('menuitem', { name: 'release', exact: true }).click()
  await option.getByRole('button', { name: '基于 release', exact: true }).waitFor()
  return launched
}

/**
 * Send the first prompt of the borrowed scenario.
 * @returns the prompt and the turn's settlement, which resolves to the Session id.
 */
async function sendPrompt(page: Page, scaffold: WebScaffold): Promise<{ readonly prompt: string; readonly settled: Promise<SessionId> }> {
  const [prompt] = fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))
  if (prompt === undefined) throw new Error('The borrowed scenario requires a user prompt')
  const settled = scaffold.whenTurnSettled()
  const composer = page.locator('[data-composer-input]').first()
  await writeComposerDraft(page, composer, prompt)
  await composer.press('Enter')
  return { prompt, settled }
}

function worktreeRecords(events: readonly SessionEvent[]): unknown[] {
  return events.flatMap((event) => {
    const record = pluginRecordOf(event)
    return record?.type === 'plugin:client-ui-forge/worktree' ? [record.data] : []
  })
}

it.skipIf(MODE === 'record')('automatically shows a numbered PR when gh JSON omits its URL', async () => {
  const { scaffold, page, project, tripwire } = await launchPanel('web-e2e-forge-numbered-reference', 'reference')
  const { settled } = await sendPrompt(page, scaffold)
  const sessionId = await settled
  const events = await readPersistedEvents(scaffold, sessionId)
  const toolOutput = events.flatMap(event => event.type === 'tool/result'
    ? event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []) : []).join('\n')
  expect(toolOutput).toContain('Add the pull request panel')
  const header = page.locator('[data-forge-header]')
  await expect.poll(() => header.getAttribute('aria-label'), { timeout: 20_000 }).toBe('本会话的变更请求需要处理')
  await header.click()
  const change = page.locator(`[data-forge-change="${PULL}"]`)
  await change.getByRole('link', { name: 'Add the pull request panel', exact: true }).waitFor({ timeout: 20_000 })
  await change.getByText('等待评审 · 1 条未解决讨论', { exact: true }).waitFor()
  await compareOrRefreshGolden(join(EXPECTED, 'reference.expected.md'),
    await captureStableAria(page, `[data-forge-change="${PULL}"]`, scaffold.workspaceCwd), MODE)
  expect(events.flatMap((event) => {
    const record = pluginRecordOf(event)
    return record?.type === 'plugin:forge-session/binding' ? [record.data] : []
  })).toEqual([{ action: 'reference', url: PULL }])
  const calls = (await readFile(join(project, '.fixture-bin', 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
  expect(calls).toContainEqual(['pr', 'view', '7', '--repo', 'octo/demo', '--json', 'url'])
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})

it.skipIf(MODE === 'record')('starts a Session in a worktree before its first message, follows its change request, and restores the removed worktree', async () => {
  const { scaffold, page, root, project, tripwire } = await requestReleaseWorktree('web-e2e-forge-panel', true)
  const { settled } = await sendPrompt(page, scaffold)
  const sessionId = await settled
  await page.getByText('LIGHTHOUSE', { exact: true }).waitFor()
  await page.locator('[data-forge-creation]').waitFor({ state: 'detached' })
  await page.locator('[data-forge-worktree]').waitFor({ state: 'detached' })

  const session = scaffold.ctx.sessions.get(sessionId)
  if (session === undefined) throw new Error('The worktree Session must stay loaded')
  const directory = scaffold.ctx.workingDirectory.get(session)
  const branch = basename(directory)
  expect(directory).toBe(join(project, '.agents', 'worktrees', branch))
  expect(branch).toMatch(new RegExp(`^dsh-${sessionId.slice('session-'.length, 'session-'.length + 8)}-[0-9a-f]{4}$`))
  expect(await git(directory, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branch)
  const baseCommit = await git(project, 'rev-parse', 'release')
  expect(await git(directory, 'rev-parse', 'HEAD')).toBe(baseCommit)
  const events = await readPersistedEvents(scaffold, sessionId)
  expect(worktreeRecords(events)).toEqual([
    { action: 'request', from: 'main' },
    { action: 'request', from: 'release' },
    { action: 'created', worktree: { path: directory, branch, from: 'release', baseCommit, repositoryRoot: project } },
  ])
  // The worktree existed before the turn, so the first model request carried its directory notice.
  const created = events.findIndex((event) => {
    const record = pluginRecordOf(event)
    const data = record?.type === 'plugin:client-ui-forge/worktree' ? record.data : null
    return typeof data === 'object' && data !== null && 'action' in data && data.action === 'created'
  })
  const turn = events.findIndex(event => event.type === 'turn/start')
  const notice = events.findIndex(event => event.type === 'user/message' && event.data.source.kind === 'working-directory')
  expect(created).toBeLessThan(turn)
  expect(notice).toBeGreaterThan(turn)
  expect(notice).toBeLessThan(events.findIndex(event => event.type === 'assistant/message'))

  // A change request bound the way a `gh pr create` result binds one.
  scaffold.ctx.forgeSession.track(session, PULL)
  const header = page.locator('[data-forge-header]')
  await expect.poll(() => header.getAttribute('aria-label'), { timeout: 20_000 }).toBe('本会话的变更请求需要处理')
  expect(await header.getAttribute('aria-pressed')).toBe('false')

  // The Session row marks the worktree and its change request's state, and its hover card names both.
  const row = page.locator(`[data-row-key="session:${sessionId}"]`)
  await row.getByRole('img', { name: '在自己的工作树中', exact: true }).waitFor({ timeout: 20_000 })
  await row.getByRole('img', { name: '变更请求状态：需要处理 · 检查失败', exact: true }).waitFor({ timeout: 20_000 })
  await row.hover()
  const rowHover = page.locator('[data-forge-session-hover]')
  await rowHover.getByText('#7 Add the pull request panel', { exact: true }).waitFor({ timeout: 20_000 })
  await compareOrRefreshGolden(join(EXPECTED, 'session-row-hover.expected.md'),
    await captureStableAria(page, '[data-forge-session-hover]', scaffold.workspaceCwd, { replacements: [[branch, 'dsh-{{worktree}}']] }), MODE)
  await page.mouse.move(0, 0)
  await rowHover.waitFor({ state: 'detached' })
  await header.click()
  await expect.poll(() => header.getAttribute('aria-pressed')).toBe('true')
  const panel = page.locator('[data-forge-panel]')
  const checkout = panel.locator('[data-forge-checkout]')
  const checkoutName = checkout.getByText(branch, { exact: true })
  await checkoutName.waitFor({ timeout: 20_000 })
  await checkout.getByText('工作树 · 基于 release', { exact: true }).waitFor()
  await checkoutName.hover()
  await page.getByRole('tooltip').filter({ hasText: `工作树（基于 release）：${abbreviateHomePath(directory, homedir())}` }).waitFor()
  await page.mouse.move(0, 0)
  const change = panel.locator(`[data-forge-change="${PULL}"]`)
  const title = change.getByRole('link', { name: 'Add the pull request panel', exact: true })
  await title.waitFor({ timeout: 20_000 })
  // The only open change request starts expanded.
  await change.getByText('等待评审 · 1 条未解决讨论', { exact: true }).waitFor()
  // The random branch suffix can read as a duration, so the branch is replaced before the capture normalizes durations.
  await compareOrRefreshGolden(join(EXPECTED, 'panel.expected.md'),
    await captureStableAria(page, '[data-forge-panel]', scaffold.workspaceCwd, { replacements: [[branch, 'dsh-{{worktree}}']] }), MODE)
  const checksRow = change.getByRole('button', { name: /^检查/ })
  await checksRow.click()
  const checks = page.getByRole('menu')
  await expect.poll(() => checks.getByRole('menuitem').allTextContents()).toEqual([expect.stringMatching(/^test/), expect.stringMatching(/^lint/)])
  await page.keyboard.press('Escape')
  await checks.waitFor({ state: 'detached' })
  expect(await checksRow.getAttribute('aria-expanded')).toBe('false')

  const bindings = async () => (await readPersistedEvents(scaffold, sessionId)).flatMap((event) => {
    const record = pluginRecordOf(event)
    return record?.type === 'plugin:forge-session/binding' ? [record.data] : []
  })
  await change.getByRole('button', { name: '从本会话移除 #7', exact: true }).click()
  await change.waitFor({ state: 'detached' })
  await panel.getByText('本会话还没有变更请求', { exact: true }).waitFor()
  await page.getByRole('alert').filter({ hasText: '已从本会话移除 #7' }).getByRole('button', { name: '撤销', exact: true }).click()
  await title.waitFor({ timeout: 20_000 })
  await expect.poll(bindings).toEqual([{ action: 'track', url: PULL }, { action: 'dismiss', url: PULL }, { action: 'track', url: PULL }])

  const calls = (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
  expect(calls).toContainEqual(['auth', 'status', '--hostname', 'github.com'])
  expect(calls.some(args => args[0] === 'api' && args[1] === 'graphql' && args.includes('--hostname'))).toBe(true)
  await header.click()
  await expect.poll(() => header.getAttribute('aria-pressed')).toBe('false')

  // Removing the worktree outside the Session holds the next message in the inbox until the worktree is restored.
  await git(project, 'worktree', 'remove', '--force', directory)
  const composer = page.locator('[data-composer-input]').first()
  await writeComposerDraft(page, composer, FOLLOW_UP)
  const accepted = page.waitForResponse('**/api/session/prompt')
  await composer.press('Enter')
  const envelope = await (await accepted).json() as { readonly result: unknown }
  expect(envelope.result).toMatchObject({ ok: true })
  const missing = page.locator('[data-forge-missing]')
  await missing.getByText(`可以在原位置恢复分支 ${branch} 的工作树。删除前未提交的修改无法恢复`, { exact: true }).waitFor()
  await missing.getByText('恢复工作树或在项目目录继续后，消息会接着发送', { exact: true }).waitFor()
  await expect.poll(() => checkout.getAttribute('data-missing')).toBe('')
  const turns = async (): Promise<number> => (await readPersistedEvents(scaffold, sessionId)).filter(event => event.type === 'turn/start').length
  expect(await turns()).toBe(1)
  await missing.getByRole('button', { name: '恢复工作树', exact: true }).click()
  await missing.waitFor({ state: 'detached', timeout: 20_000 })
  await page.getByRole('alert').filter({ hasText: '工作树已恢复' }).waitFor()
  expect(await git(directory, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branch)
  expect(await git(directory, 'rev-parse', 'HEAD')).toBe(baseCommit)
  await expect.poll(() => checkout.getAttribute('data-missing')).toBeNull()
  // The waiting message goes on in the restored worktree.
  await page.getByText(FOLLOW_UP_REPLY, { exact: true }).waitFor({ timeout: 20_000 })
  expect(await turns()).toBe(2)
  expect(scaffold.ctx.workingDirectory.get(session)).toBe(directory)
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})

it.skipIf(MODE === 'record')('keeps the first message waiting when the worktree cannot be created, tries again, and sends it without the worktree', async () => {
  const { scaffold, page, project, tripwire } = await requestReleaseWorktree('web-e2e-forge-panel-failure')
  await git(project, 'branch', '--quiet', '-D', 'release')
  const { settled } = await sendPrompt(page, scaffold)
  const card = page.locator('[data-forge-creation="failed"]')
  const failure = card.getByRole('region', { name: '创建工作树失败', exact: true })
  await failure.getByText('原因', { exact: true }).waitFor({ timeout: 20_000 })
  const attempted = await failure.getByRole('definition').first().textContent()
  expect(attempted).toMatch(/^dsh-[0-9a-f]{8}-[0-9a-f]{4}$/)
  await failure.getByText('消息会在工作树建好后发送', { exact: true }).waitFor()

  // Retry makes another attempt with a new branch name while the message keeps waiting.
  await card.getByRole('button', { name: '重试', exact: true }).click()
  await expect.poll(() => failure.getByRole('definition').first().textContent(), { timeout: 20_000 }).not.toBe(attempted)

  await card.getByRole('button', { name: '不使用工作树', exact: true }).click()
  const sessionId = await settled
  await page.getByText('LIGHTHOUSE', { exact: true }).waitFor()
  await card.waitFor({ state: 'detached' })

  const session = scaffold.ctx.sessions.get(sessionId)
  if (session === undefined) throw new Error('The Session must stay loaded')
  expect(scaffold.ctx.workingDirectory.get(session)).toBe(project)
  const events = await readPersistedEvents(scaffold, sessionId)
  expect(worktreeRecords(events)).toEqual([{ action: 'request', from: 'main' }, { action: 'request', from: 'release' }, { action: 'cancel' }])
  expect(events.filter(event => event.type === 'turn/start')).toHaveLength(1)
  expect(events.some(event => event.type === 'user/message' && event.data.source.kind === 'working-directory')).toBe(false)
  await page.locator('[data-forge-header]').click({ timeout: 20_000 })
  const checkout = page.locator('[data-forge-panel] [data-forge-checkout]')
  const checkoutName = checkout.getByText('main', { exact: true })
  await checkoutName.waitFor({ timeout: 20_000 })
  await checkout.getByText('项目目录', { exact: true }).waitFor()
  await checkoutName.hover()
  await page.getByRole('tooltip').filter({ hasText: `项目目录：${abbreviateHomePath(project, homedir())}` }).waitFor()
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})

it.skipIf(MODE === 'record')('marks a draft change request ready for review and merges it with the usual method', async () => {
  const { scaffold, page, root, tripwire } = await launchPanel('web-e2e-forge-panel-merge')
  const { settled } = await sendPrompt(page, scaffold)
  const sessionId = await settled
  await page.getByText('LIGHTHOUSE', { exact: true }).waitFor()
  const session = scaffold.ctx.sessions.get(sessionId)
  if (session === undefined) throw new Error('The Session must stay loaded')

  scaffold.ctx.forgeSession.track(session, DRAFT)
  const header = page.locator('[data-forge-header]')
  await expect.poll(() => header.getAttribute('aria-label'), { timeout: 20_000 }).toBe('本会话的变更请求')
  await header.click()
  const change = page.locator(`[data-forge-change="${DRAFT}"]`)
  await change.getByRole('link', { name: 'Add the merge button', exact: true }).waitFor({ timeout: 20_000 })

  // The only open change request starts expanded, so its action is in view.
  await change.getByRole('button', { name: '标记为可评审', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: '已将 #9 标记为可评审' }).waitFor()
  const merge = change.getByRole('button', { name: '合并', exact: true })
  await merge.waitFor({ timeout: 20_000 })
  await merge.click()
  const menu = page.getByRole('menu')
  await menu.getByText('将 #9 合并到 main', { exact: true }).waitFor()
  await compareOrRefreshGolden(join(EXPECTED, 'merge-menu.expected.md'), await captureStableAria(page, '[role="menu"]', scaffold.workspaceCwd), MODE)
  await writeFile(join(root, 'state.json'), JSON.stringify({ ready: true, mergedAt: null, head: 'c'.repeat(40) }))
  scaffold.ctx.forge.refresh({ repository: { forge: 'github', host: 'github.com', owner: 'octo', name: 'demo' }, number: 9 })
  const stale = menu.getByRole('menuitem', { name: '提交已更新，请重新检查后再打开合并菜单', exact: true })
  await stale.waitFor()
  expect(await stale.isDisabled()).toBe(true)
  await compareOrRefreshGolden(join(EXPECTED, 'merge-stale.expected.md'), await captureStableAria(page, '[role="menu"]', scaffold.workspaceCwd), MODE)
  await merge.click()
  await merge.click()
  await menu.getByRole('menuitem', { name: '确认合并', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: '已合并 #9' }).waitFor()
  // Merged, the change request is no longer open, so its card collapses to the merge line.
  await change.getByText(/^已合并到 main · /).waitFor({ timeout: 20_000 })

  const calls = (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
  expect(calls).toContainEqual(['pr', 'ready', '9', '--repo', 'github.com/octo/demo'])
  expect(calls).toContainEqual([
    'api', '--hostname', 'github.com', '--method', 'PUT', 'repos/octo/demo/pulls/9/merge', '-f', 'merge_method=squash', '-f', `sha=${'c'.repeat(40)}`,
  ])
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})

it.skipIf(MODE === 'record')('shows the local changes of the Session by scope and the changes of its change requests, expanding unchanged lines', async () => {
  const { scaffold, page, root, project, tripwire } = await launchPanel('web-e2e-forge-panel-changes')
  // origin/main stops at the twelve-line README; the branch adds a commit, a staged file, an edit, and an untracked file.
  await writeFile(join(project, 'README.md'), Array.from({ length: 12 }, (_, index) => `line ${index + 1}\n`).join(''))
  await git(project, 'commit', '--quiet', '-am', 'readme')
  await git(project, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  await git(project, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  await mkdir(join(project, 'src'))
  await writeFile(join(project, 'src', 'app.ts'), 'export const app = 1\n')
  await git(project, 'add', 'src/app.ts')
  await git(project, 'commit', '--quiet', '-m', 'app')
  await writeFile(join(project, 'src', 'extra.ts'), 'export const extra = 1\n')
  await git(project, 'add', 'src/extra.ts')
  await writeFile(join(project, 'README.md'), Array.from({ length: 12 }, (_, index) => index === 9 ? 'line ten\n' : `line ${index + 1}\n`).join(''))
  await writeFile(join(project, 'notes.md'), 'note\n')

  const { settled } = await sendPrompt(page, scaffold)
  const sessionId = await settled
  await page.getByText('LIGHTHOUSE', { exact: true }).waitFor()
  const session = scaffold.ctx.sessions.get(sessionId)
  if (session === undefined) throw new Error('The Session must stay loaded')
  const header = page.locator('[data-forge-header]')
  await header.click()
  // The New Session screen inspected the checkout before these changes, which came from outside the Session.
  await page.locator('[data-forge-panel]').getByRole('button', { name: '刷新状态', exact: true }).click()
  const card = page.locator('[data-forge-local]')
  await card.getByText('HEAD → origin/main', { exact: true }).waitFor({ timeout: 20_000 })
  await card.getByRole('button', { name: '查看本会话的变更：4 个文件，新增 4 行，删除 1 行', exact: true }).click()

  const local = page.locator('[data-forge-changes="local"]')
  await local.getByText('与 origin/main 比较，包含未提交的修改', { exact: true }).waitFor({ timeout: 20_000 })
  const files = local.locator('[data-forge-diff-file]')
  await expect.poll(() => files.evaluateAll(sections => sections.map(section => section.getAttribute('data-forge-diff-file'))), { timeout: 20_000 })
    .toEqual(['README.md', 'src/app.ts', 'src/extra.ts', 'notes.md'])
  await local.locator('[data-forge-diff-file="notes.md"]').getByText('新文件 · 未提交', { exact: true }).waitFor()
  const readme = local.locator('[data-forge-diff-file="README.md"]')
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await readme.getByRole('button', { name: '复制路径: README.md', exact: true }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('README.md')
  await page.evaluate(() => navigator.clipboard.writeText('unchanged'))
  await readme.locator('[data-forge-path-spacer]').click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('unchanged')
  await readme.getByRole('button', { name: '6 行未变更', exact: true }).click()
  await readme.getByText('line 1', { exact: true }).first().waitFor({ timeout: 20_000 })
  await local.getByRole('button', { name: '分支', exact: true }).click()
  await page.getByRole('menuitem', { name: '已暂存', exact: true }).click()
  await local.getByText('暂存区与 HEAD 比较', { exact: true }).waitFor()
  await expect.poll(() => files.evaluateAll(sections => sections.map(section => section.getAttribute('data-forge-diff-file'))), { timeout: 20_000 })
    .toEqual(['src/extra.ts'])

  // A change request bound the way a `gh pr create` result binds one.
  scaffold.ctx.forgeSession.track(session, PULL)
  await expect.poll(() => header.getAttribute('aria-pressed'), { timeout: 20_000 }).toBe('false')
  await header.click()
  const change = page.locator(`[data-forge-change="${PULL}"]`)
  await change.getByRole('link', { name: 'Add the pull request panel', exact: true }).waitFor({ timeout: 20_000 })
  await change.getByRole('button', { name: '查看 #7 的变更：新增 128 行，删除 14 行', exact: true }).click()
  const view = page.locator('[data-forge-changes="change"]')
  const panelFile = view.locator('[data-forge-diff-file="src/panel.ts"]')
  await panelFile.getByRole('button', { name: '6 行未变更', exact: true }).waitFor({ timeout: 20_000 })
  await compareOrRefreshGolden(join(EXPECTED, 'changes-view.expected.md'),
    await captureStableAria(page, '[data-forge-changes="change"]', scaffold.workspaceCwd), MODE)
  await panelFile.getByRole('button', { name: '6 行未变更', exact: true }).click()
  await panelFile.getByText('export const n6 = 6', { exact: true }).first().waitFor({ timeout: 20_000 })
  await panelFile.getByRole('button', { name: '2 行未变更', exact: true }).waitFor()
  await panelFile.getByRole('button', { name: '复制路径: src/panel.ts', exact: true }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('src/panel.ts')
  const docsFile = view.locator('[data-forge-diff-file="docs/panel.md"]')
  await docsFile.getByRole('button', { name: '收起 panel.md', exact: true }).click()
  await page.setViewportSize({ width: 1280, height: 500 })
  const scrollport = view.locator('[data-forge-changes-scroll]')
  await scrollport.evaluate((element) => { element.scrollTop = 100; element.dispatchEvent(new Event('scroll')) })
  await panelFile.getByRole('button', { name: '复制路径: src/panel.ts', exact: true }).click()
  const position = await scrollport.evaluate(element => element.scrollTop)
  expect(position).toBeGreaterThan(0)
  const originalFile = await panelFile.elementHandle()
  await page.getByRole('button', { name: /^(?:New session|新.*会话)$/ }).last().click()
  await expect.poll(() => view.isVisible()).toBe(false)
  await page.locator(`[data-row-key="session:${sessionId}"]`).click()
  await panelFile.getByText('export const n6 = 6', { exact: true }).first().waitFor({ timeout: 20_000 })
  expect(await panelFile.evaluate((element, original) => element === original, originalFile)).toBe(true)
  await expect.poll(() => docsFile.getAttribute('data-expanded')).toBe(null)
  await expect.poll(() => scrollport.evaluate(element => element.scrollTop)).toBe(position)
  await page.setViewportSize({ width: 1680, height: 1000 })

  // GitHub refuses the diff of pull request 9 as too large, so its view offers the web page instead of a retry.
  scaffold.ctx.forgeSession.track(session, DRAFT)
  await expect.poll(() => header.getAttribute('aria-pressed'), { timeout: 20_000 }).toBe('false')
  await header.click()
  const draft = page.locator(`[data-forge-change="${DRAFT}"]`)
  await draft.getByRole('button', { name: '展开 #9', exact: true }).click()
  await draft.getByRole('button', { name: '查看 #9 的变更：新增 30 行，删除 2 行', exact: true }).click({ timeout: 20_000 })
  const refused = page.locator('[data-forge-changes="change"]').filter({ hasText: 'Add the merge button' })
  await refused.getByRole('status').filter({ hasText: '变更太大，无法在这里显示' }).waitFor({ timeout: 20_000 })
  await refused.getByRole('button', { name: '在浏览器中查看', exact: true }).waitFor()
  expect(await refused.getByRole('button', { name: '重试', exact: true }).count()).toBe(0)

  const calls = (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
  expect(calls).toContainEqual(['pr', 'diff', '7', '--repo', 'github.com/octo/demo', '--color', 'never'])
  expect(calls).toContainEqual(['pr', 'diff', '9', '--repo', 'github.com/octo/demo', '--color', 'never'])
  expect(calls).toContainEqual([
    'api', '--hostname', 'github.com', '-H', 'Accept: application/vnd.github.raw+json', `repos/octo/demo/contents/src/panel.ts?ref=${HEAD7}`,
  ])
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})


it.skipIf(MODE === 'record').each(['darwin', 'win32'] as const)('closes diff menus when the %s desktop shortcut deactivates a retained tab', async (platform) => {
  const { page, scaffold, project, tripwire } = await launchPanel(`web-e2e-forge-menu-${platform}`, 'normal', platform)
  await git(project, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  await git(project, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  await writeFile(join(project, 'README.md'), 'review this change\n')
  const { settled } = await sendPrompt(page, scaffold)
  const sessionId = await settled
  await page.locator('[data-forge-header]').click()
  await page.locator('[data-forge-panel]').getByRole('button', { name: '刷新状态', exact: true }).click()
  await page.locator('[data-forge-local]').getByRole('button', { name: /查看本会话的变更：1 个文件/ }).click()
  const view = page.locator('[data-forge-changes="local"]')
  await view.getByRole('button', { name: '复制路径: README.md', exact: true }).waitFor()
  for (const name of ['分支', '全部 1 个文件', 'README.md 的更多操作']) {
    await view.getByRole('button', { name, exact: true }).click()
    await page.getByRole('menu').waitFor()
    await page.evaluate((mac) => { window.forgeKeyboard.deliver({
      kind: 'keyboard', frameName: '', revision: window.forgeKeyboard.revision, code: 'KeyN',
      meta: mac, control: !mac, alt: false, shift: false, repeat: false,
    }) }, platform === 'darwin')
    await expect.poll(() => view.isVisible()).toBe(false)
    await expect.poll(() => page.getByRole('menu').count()).toBe(0)
    await page.locator(`[data-row-key="session:${sessionId}"]`).click()
    await view.waitFor()
    await expect.poll(() => page.getByRole('menu').count()).toBe(0)
  }
  expect(tripwire.warnings).toEqual([])
})
