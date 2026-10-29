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
if (args[0] === 'api' && args[3] === 'repos/octo/demo/pulls/7') {
  process.stdout.write(JSON.stringify({ head: { sha: 'a'.repeat(40) }, state: 'open' }))
  process.exit(0)
}
if (args[0] === 'api' && args[4] === 'POST' && ['repos/octo/demo/pulls/7/comments', 'repos/octo/demo/pulls/7/reviews'].includes(args[5])) {
  const body = JSON.parse(readFileSync(0, 'utf8'))
  appendFileSync(join(here, 'reviews.jsonl'), JSON.stringify({ endpoint: args[5], body }) + '\\n')
  process.stdout.write(JSON.stringify({ html_url: 'https://github.com/octo/demo/pull/7#pullrequestreview-1' }))
  process.exit(0)
}
if (args[0] === 'pr' && args[1] === 'diff') {
  const refused = join(here, 'pr-' + args[2] + '.refused')
  if (existsSync(refused)) {
    process.stderr.write(readFileSync(refused, 'utf8'))
    process.exit(1)
  }
  await new Promise(resolve => process.stdout.write(readFileSync(join(here, 'pr-' + args[2] + '.diff'), 'utf8'), resolve))
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
  const check = (name, conclusion, completedAt, databaseId = 101) => ({
    __typename: 'CheckRun', id: 'check-' + databaseId, name, status: 'COMPLETED', conclusion, databaseId,
    detailsUrl: 'https://github.com/octo/demo/actions/runs/1', startedAt: '2026-10-09T00:00:00Z', completedAt,
    checkSuite: { app: { id: 'github-actions' }, workflowRun: { event: 'pull_request', workflow: { id: 'ci', name: 'CI' } } },
  })
  const pulls = {
    7: {
      number: 7, url: 'https://github.com/octo/demo/pull/7', title: 'Add the pull request panel', state: 'OPEN', isDraft: false,
      updatedAt: '2026-10-09T00:00:00Z', closedAt: null, author: { login: 'octo' }, headRefName: 'feat', headRefOid: 'a'.repeat(40),
      baseRefName: 'main', additions: 128, deletions: 14, mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED',
      reviewThreads: { nodes: [{ isResolved: false }] },
      commits: { nodes: [{ commit: { statusCheckRollup: { id: 'rollup-7', state: 'FAILURE', contexts: {
        pageInfo: { hasNextPage: true, endCursor: 'checks-100' },
        nodes: Array.from({ length: 100 }, (_, i) => check('lint', 'FAILURE', '2026-10-08T00:00:42Z', i + 1)),
      } } } }] },
    },
    9: {
      number: 9, url: 'https://github.com/octo/demo/pull/9', title: 'Add the merge button', state: state.mergedAt === null ? 'OPEN' : 'MERGED',
      isDraft: !state.ready, updatedAt: '2026-10-09T00:00:00Z', closedAt: state.mergedAt, author: { login: 'octo' },
      headRefName: 'feat/merge', headRefOid: state.head ?? 'b'.repeat(40), baseRefName: 'main', additions: 30, deletions: 2, mergeable: 'MERGEABLE',
      mergeStateStatus: state.ready ? 'CLEAN' : 'BLOCKED', reviewDecision: 'APPROVED', reviewThreads: { nodes: [] },
      commits: { nodes: [{ commit: { statusCheckRollup: { id: 'rollup-9', state: 'SUCCESS', contexts: {
        pageInfo: { hasNextPage: false, endCursor: null }, nodes: [check('lint', 'SUCCESS', '2026-10-09T00:00:42Z')],
      } } } }] },
    },
  }
  if (query.includes('node(id: $id)')) {
    process.stdout.write(JSON.stringify({ data: { node: { contexts: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [check('lint', 'SUCCESS', '2026-10-09T00:00:42Z'), check('test', 'FAILURE', '2026-10-09T00:02:07Z')],
    } } } }))
    process.exit(0)
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
 * @param options - desktop transport, checkout branch, browser input, sandbox runner availability, and diff output limit.
 * @returns the scaffold, page, and checkout.
 */
async function launchPanel(failureShot: string, scenario: 'normal' | 'follow-up' | 'reference' = 'normal',
  options: { desktop?: 'darwin' | 'win32'; branch?: string; hasTouch?: boolean; missingSandbox?: boolean; maxDiffBytes?: number } = {}): Promise<PanelLaunch> {
  const { desktop } = options
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
  await writeFile(overlay, `- id: forge-github\n  config: ${JSON.stringify({ ghCommand: gh })}\n`
    + (options.maxDiffBytes === undefined ? '' : `- id: forge-panel\n  config: ${JSON.stringify({ maxDiffBytes: options.maxDiffBytes })}\n`)
    + (options.missingSandbox ? `- id: sandbox\n  config: ${JSON.stringify({ runnerCommand: [join(root, 'missing-sandbox')], runnerFailureSignatures: ['sandbox startup failed'] })}\n` : ''))
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
  if (options.branch !== undefined) await git(project, 'checkout', '--quiet', '-b', options.branch)
  if (scenario === 'reference') {
    // The model's confined command must own the CLI double's writable call log.
    const modelBin = join(project, '.fixture-bin')
    await mkdir(modelBin)
    await writeFile(join(modelBin, 'gh'), GH)
    await chmod(join(modelBin, 'gh'), 0o755)
  }

  const browser = await chromium.launch()
  resources.browser = browser
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE, timezoneId: 'Asia/Shanghai',
    hasTouch: options.hasTouch ?? false })
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
  await option.getByRole('checkbox', { name: '新建工作树', exact: true }).check()
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

it.skipIf(MODE === 'record')('reads local Git with full access when the sandbox runner cannot start', async () => {
  const { scaffold, page, project, tripwire } = await launchPanel('web-e2e-forge-permissions', 'normal', { missingSandbox: true })
  await git(project, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  await git(project, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  await writeFile(join(project, 'README.md'), 'demo\nchanged\n')
  const { settled } = await sendPrompt(page, scaffold)
  const sessionId = await settled
  await page.getByText('LIGHTHOUSE', { exact: true }).waitFor()
  await page.locator('[data-forge-header]').click()
  const panel = page.locator('[data-forge-panel]')
  await panel.getByText('无法读取 Git 信息', { exact: true }).waitFor({ timeout: 20_000 })

  const permission = page.locator('button[aria-label^="访问模式"]').first()
  await permission.click()
  await page.getByRole('menuitem', { name: '完全权限', exact: true }).click()
  const confirmation = page.getByRole('dialog', { name: '确认启用完全权限？' })
  await confirmation.getByRole('checkbox', { name: '我已了解风险，并愿意继续' }).check()
  await confirmation.getByRole('button', { name: '启用完全权限' }).click()
  const local = page.locator('[data-forge-local]')
  await local.getByRole('button', { name: '查看本会话的变更：1 个文件，新增 1 行，删除 0 行', exact: true }).waitFor({ timeout: 20_000 })
  await compareOrRefreshGolden(join(EXPECTED, 'full-access.expected.md'), await captureStableAria(page, '[data-forge-local]', scaffold.workspaceCwd), MODE)
  await local.getByRole('button', { name: '查看本会话的变更：1 个文件，新增 1 行，删除 0 行', exact: true }).click()
  await page.locator('[data-forge-diff-file="README.md"]').getByText('changed', { exact: true }).waitFor()

  await permission.click()
  await page.getByRole('menuitem', { name: '工作区内修改', exact: true }).click()
  if (!await panel.isVisible()) await page.locator('[data-forge-header]').click()
  await panel.getByText('无法读取 Git 信息', { exact: true }).waitFor({ timeout: 20_000 })
  await expect.poll(async () => (await readPersistedEvents(scaffold, sessionId))
    .filter(event => event.type === 'sandbox/mode').map(event => event.data.mode).slice(-2))
    .toEqual(['danger-full-access', 'workspace-write'])
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})

it.skipIf(MODE === 'record')('reports incomplete filter configuration and retries after it is corrected', async () => {
  const { scaffold, page, project, tripwire } = await launchPanel('web-e2e-forge-filter-config', 'normal', { maxDiffBytes: 512 })
  await git(project, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  await git(project, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  await writeFile(join(project, 'README.md'), 'demo\nchanged\n')
  const { settled } = await sendPrompt(page, scaffold)
  await settled
  await page.getByText('LIGHTHOUSE', { exact: true }).waitFor()
  await page.locator('[data-forge-header]').click()
  const openChanges = page.locator('[data-forge-local]').getByRole('button', { name: '查看本会话的变更：1 个文件，新增 1 行，删除 0 行', exact: true })
  await openChanges.waitFor({ timeout: 20_000 })
  const key = `filter.${'long'.repeat(200)}.clean`
  await git(project, 'config', key, 'cat')
  await openChanges.click()
  const changes = page.locator('[data-forge-changes="local"]')
  await changes.getByText('无法完整读取 Git 过滤器配置，尚未执行比较。请检查 Git 配置和读取上限后重试', { exact: true }).waitFor()
  await compareOrRefreshGolden(join(EXPECTED, 'filter-config-failed.expected.md'),
    await captureStableAria(page, '[data-forge-changes="local"]', scaffold.workspaceCwd), MODE)

  await git(project, 'config', '--unset', key)
  await changes.getByRole('button', { name: '重试', exact: true }).click()
  await changes.locator('[data-forge-diff-file="README.md"]').getByText('changed', { exact: true }).waitFor()
  expect(await changes.getByRole('status').count()).toBe(0)
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})

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
  // A fresh page cannot retain the previous browser source's status values.
  await page.goto('about:blank')
  await expect.poll(() => scaffold.ctx.storageDomain.get('forge_panel_change_requests')).toBeUndefined()
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
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
  const beforeChecks = (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
  expect(beforeChecks.some(args => args.includes('id=rollup-7'))).toBe(false)
  const checksRow = change.getByRole('button', { name: /^检查/ })
  await checksRow.click()
  const checks = page.getByRole('menu')
  await expect.poll(() => checks.getByRole('menuitem').allTextContents()).toEqual([expect.stringMatching(/^test/), expect.stringMatching(/^lint/)])
  const afterChecks = (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
  expect(afterChecks.filter(args => args.includes('id=rollup-7'))).toHaveLength(1)
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
  const { scaffold, page, root, project, tripwire } = await launchPanel('web-e2e-forge-panel-changes', 'follow-up')
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
  await page.getByRole('button', { name: '打开右侧边栏', exact: true }).click()
  const guide = page.locator('[data-sidebar-right-guide]')
  await guide.getByRole('button', { name: /^代码审查和变更/ }).waitFor()
  await compareOrRefreshGolden(join(EXPECTED, 'review-guide.expected.md'),
    await captureStableAria(page, '[data-sidebar-right-guide-entry="forge-panel"]', scaffold.workspaceCwd), MODE)
  await guide.getByRole('button', { name: /^代码审查和变更/ }).click()
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
  await page.evaluate(() => navigator.clipboard.writeText('unchanged'))
  await readme.locator('[data-forge-file-label]').click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('unchanged')
  await readme.locator('[data-forge-path-spacer]').click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('unchanged')
  await readme.getByRole('button', { name: '6 行未变更', exact: true }).click()
  await readme.getByText('line 1', { exact: true }).first().waitFor({ timeout: 20_000 })
  await local.getByRole('button', { name: '全部 4 个文件', exact: true }).click()
  const tree = page.getByRole('menu')
  await tree.getByRole('textbox', { name: '筛选文件…' }).fill('extra')
  await tree.getByRole('menuitem', { name: 'src/extra.ts', exact: true }).click()
  for (const [path, comment] of [['src/app.ts', '请解释这行代码'], ['src/extra.ts', '请检查这项修改']] as const) {
    const section = local.locator(`[data-forge-diff-file="${path}"]`)
    const lineNumber = section.getByRole('button', { name: '选择第 R1 行', exact: true })
    await lineNumber.hover()
    expect(await lineNumber.evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
    const content = await section.locator('[data-review-code]').first().boundingBox()
    const fileBox = await section.boundingBox()
    if (content === null || fileBox === null) throw new Error('Added file must be visible')
    expect(content.x - fileBox.x).toBeLessThan(70)
    await lineNumber.click()
    expect(await section.getByRole('textbox', { name: '留下评论…' }).count()).toBe(0)
    await section.getByRole('button', { name: '添加评论', exact: true }).click()
    await section.getByRole('textbox', { name: '留下评论…' }).fill(comment)
    await section.locator('[data-forge-comment]').getByRole('button', { name: '添加到输入框', exact: true }).click()
    await section.locator('[data-forge-review-thread="agent"]').getByText(comment, { exact: true }).waitFor()
  }
  await compareOrRefreshGolden(join(EXPECTED, 'review-quotes.expected.md'),
    await captureStableAria(page, '[data-composer-input]', scaffold.workspaceCwd), MODE)
  expect((await readPersistedEvents(scaffold, sessionId)).some(event => event.type === 'user/message'
    && event.data.content.some(block => block.type === 'text' && block.text.includes('## User Comment')))).toBe(false)
  const reviewed = scaffold.whenTurnSettled()
  await page.locator('[data-composer-input]').first().press('Enter')
  await reviewed
  await page.getByText(FOLLOW_UP_REPLY, { exact: true }).waitFor()
  const comments = (await readPersistedEvents(scaffold, sessionId)).flatMap(event => event.type === 'user/message'
    ? event.data.content.flatMap(block => block.type === 'text' && block.text.includes('## User Comment') ? [block.text] : []) : [])
  expect(comments).toHaveLength(1)
  await compareOrRefreshGolden(join(EXPECTED, 'review-message.expected.md'), comments.join('').trimEnd(), MODE)

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
  const title = await view.getByText('Add the pull request panel', { exact: true }).boundingBox()
  const submit = await view.getByRole('button', { name: '提交评审', exact: true }).boundingBox()
  if (title === null || submit === null) throw new Error('PR title and submit action must be visible')
  expect(Math.abs(title.y + title.height / 2 - submit.y - submit.height / 2)).toBeLessThan(1)

  await panelFile.getByRole('button', { name: '6 行未变更', exact: true }).waitFor({ timeout: 20_000 })
  await compareOrRefreshGolden(join(EXPECTED, 'changes-view.expected.md'),
    await captureStableAria(page, '[data-forge-changes="change"]', scaffold.workspaceCwd), MODE)
  await page.getByRole('button', { name: '全屏', exact: true }).click()
  await view.getByRole('navigation').getByRole('button', { name: 'src/panel.ts', exact: true }).waitFor()
  const fileTree = view.getByRole('navigation')
  const treeIsLeft = async () => {
    const tree = await fileTree.boundingBox()
    const diff = await view.locator('[data-forge-changes-scroll]').boundingBox()
    if (tree === null || diff === null) throw new Error('Tree and diff must be visible')
    return tree.x < diff.x
  }
  expect(await treeIsLeft()).toBe(true)
  const directoryName = await fileTree.getByText('src', { exact: true }).boundingBox()
  const fileName = await fileTree.getByText('panel.ts', { exact: true }).boundingBox()
  if (directoryName === null || fileName === null) throw new Error('Tree entries must be visible')
  expect(fileName.x).toBeGreaterThan(directoryName.x)
  await fileTree.getByRole('textbox', { name: '筛选文件…' }).fill('src')
  await fileTree.getByRole('textbox', { name: '筛选文件…' }).fill('')
  await fileTree.getByRole('button', { name: 'src', exact: true }).click()
  await view.getByRole('button', { name: /^(将文件树移到右侧|隐藏文件树|在左侧显示文件树)$/ }).click()
  expect(await treeIsLeft()).toBe(false)
  expect(await fileTree.getByRole('button', { name: 'src', exact: true }).getAttribute('aria-expanded')).toBe('false')
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await fileTree.isVisible()).toBe(false)
  expect(await view.getByRole('button', { name: /^(将文件树移到右侧|隐藏文件树|在左侧显示文件树)$/ }).isVisible()).toBe(false)
  await view.getByRole('button', { name: '全部 2 个文件', exact: true }).click()
  await page.getByRole('menu').getByRole('textbox', { name: '筛选文件…' }).waitFor()
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 1680, height: 1000 })
  expect(await treeIsLeft()).toBe(false)
  await view.getByRole('button', { name: /^(将文件树移到右侧|隐藏文件树|在左侧显示文件树)$/ }).click()
  expect(await fileTree.isVisible()).toBe(false)
  await view.getByRole('button', { name: /^(将文件树移到右侧|隐藏文件树|在左侧显示文件树)$/ }).click()
  expect(await treeIsLeft()).toBe(true)
  expect(await fileTree.getByRole('button', { name: 'src', exact: true }).getAttribute('aria-expanded')).toBe('false')
  await fileTree.getByRole('textbox', { name: '筛选文件…' }).fill('src')
  await view.getByRole('button', { name: /^(将文件树移到右侧|隐藏文件树|在左侧显示文件树)$/ }).click()
  await view.getByRole('button', { name: /^(将文件树移到右侧|隐藏文件树|在左侧显示文件树)$/ }).click()
  await view.getByRole('button', { name: /^(将文件树移到右侧|隐藏文件树|在左侧显示文件树)$/ }).click()
  expect(await fileTree.getByRole('textbox', { name: '筛选文件…' }).inputValue()).toBe('src')
  await compareOrRefreshGolden(join(EXPECTED, 'file-tree-toggle.expected.md'),
    await captureStableAria(page, '[data-forge-changes="change"]', scaffold.workspaceCwd), MODE)
  await fileTree.getByRole('textbox', { name: '筛选文件…' }).fill('')
  await fileTree.getByRole('button', { name: 'src', exact: true }).click()
  const resizeTree = view.getByRole('separator', { name: '调整文件树宽度', exact: true })
  const originalWidth = Number(await resizeTree.getAttribute('aria-valuenow'))
  const handle = await resizeTree.boundingBox()
  if (handle === null) throw new Error('Tree resize handle must be visible')
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 100)
  await page.mouse.down()
  await page.mouse.move(handle.x + 80, handle.y + 100, { steps: 5 })
  await page.mouse.up()
  expect(Number(await resizeTree.getAttribute('aria-valuenow'))).toBeGreaterThan(originalWidth)
  await resizeTree.press('Home')
  expect(await fileTree.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  const searchBounds = await fileTree.getByRole('textbox').boundingBox()
  const treeBounds = await fileTree.boundingBox()
  if (searchBounds === null || treeBounds === null) throw new Error('Tree search must be visible')
  expect(searchBounds.x + searchBounds.width).toBeLessThanOrEqual(treeBounds.x + treeBounds.width)
  await resizeTree.press('ArrowRight')
  const resizedWidth = await resizeTree.getAttribute('aria-valuenow')
  await view.getByRole('button', { name: /^(将文件树移到右侧|隐藏文件树|在左侧显示文件树)$/ }).click()
  expect(await treeIsLeft()).toBe(false)
  expect(await resizeTree.getAttribute('aria-valuenow')).toBe(resizedWidth)
  await resizeTree.press('ArrowLeft')
  expect(Number(await resizeTree.getAttribute('aria-valuenow'))).toBe(Number(resizedWidth) + 20)
  await resizeTree.press('ArrowRight')
  const rightHandle = await resizeTree.boundingBox()
  if (rightHandle === null) throw new Error('Right tree resize handle must be visible')
  await page.mouse.move(rightHandle.x + rightHandle.width / 2, rightHandle.y + 100)
  await page.mouse.down()
  await page.mouse.move(rightHandle.x - 80, rightHandle.y + 100, { steps: 5 })
  await page.mouse.up()
  expect(Number(await resizeTree.getAttribute('aria-valuenow'))).toBeGreaterThan(Number(resizedWidth))
  const rightWidth = await resizeTree.getAttribute('aria-valuenow')
  await view.getByRole('button', { name: /^(将文件树移到右侧|隐藏文件树|在左侧显示文件树)$/ }).click()
  await view.getByRole('button', { name: /^(将文件树移到右侧|隐藏文件树|在左侧显示文件树)$/ }).click()
  expect(await resizeTree.getAttribute('aria-valuenow')).toBe(rightWidth)
  for (const side of ['old', 'new'] as const) {
    const firstLine = await panelFile.locator(`[data-review-code][data-${side}-line="2"]`).boundingBox()
    const lastLine = await panelFile.locator(`[data-review-code][data-${side}-line="4"]`).boundingBox()
    if (firstLine === null || lastLine === null) throw new Error('Review text must be visible')
    await page.mouse.move(firstLine.x + 7, firstLine.y + firstLine.height / 2)
    await page.mouse.down()
    await page.mouse.move(lastLine.x + 120, lastLine.y + lastLine.height / 2, { steps: 5 })
    await page.mouse.up()
    await panelFile.getByRole('button', { name: '添加评论', exact: true }).waitFor()
    expect(await panelFile.getByRole('textbox', { name: '留下评论…' }).count()).toBe(0)
    const opposite = panelFile.locator(`[data-diff-side="${side === 'old' ? 'R' : 'L'}"]`).first()
    expect(await opposite.evaluate(element => getComputedStyle(element).userSelect)).toBe('none')
    await page.keyboard.press('ControlOrMeta+c')
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    expect(copied).toContain(side === 'old' ? 'n2 = 2' : "n2 = 'two'")
    expect(copied).not.toContain(side === 'old' ? "n2 = 'two'" : 'n2 = 2')
    expect(copied.match(/n3 = 3/g)).toHaveLength(1)
  }
  await panelFile.getByRole('button', { name: '添加评论', exact: true }).click()
  await panelFile.getByRole('region', { name: '评论 R2–4', exact: true }).waitFor()
  await panelFile.getByRole('textbox', { name: '留下评论…' }).fill('请核对边界条件')
  await panelFile.getByRole('button', { name: 'GitHub 评论选项', exact: true }).click()
  await page.getByRole('menuitem', { name: '发布单条评论', exact: true }).waitFor()
  await page.keyboard.press('Escape')
  await compareOrRefreshGolden(join(EXPECTED, 'review-composer.expected.md'),
    await captureStableAria(page, '[data-forge-comment]', scaffold.workspaceCwd), MODE)
  await page.getByRole('button', { name: '退出全屏', exact: true }).click()
  const commentForm = panelFile.locator('[data-forge-comment]')
  expect(await commentForm.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.getByRole('button', { name: '全屏', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 780 })
  await commentForm.getByRole('textbox').focus()
  expect(await commentForm.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  const narrowComment = await commentForm.boundingBox()
  if (narrowComment === null) throw new Error('Comment form must remain visible')
  expect(narrowComment.x + narrowComment.width).toBeLessThanOrEqual(390)
  await page.setViewportSize({ width: 1680, height: 1000 })
  await panelFile.getByRole('button', { name: '开始评审', exact: true }).click()
  await panelFile.locator('[data-forge-review-thread="pending"]').getByText('请核对边界条件', { exact: true }).waitFor()
  await page.setViewportSize({ width: 1680, height: 500 })
  const changesScroll = view.locator('[data-forge-changes-scroll]')
  await changesScroll.evaluate((element) => { element.scrollTop = element.scrollHeight })
  const reviewScroll = await changesScroll.evaluate(element => element.scrollTop)
  expect(reviewScroll).toBeGreaterThan(0)
  await view.getByRole('button', { name: '提交评审 (1)', exact: true }).click()
  const reviewDialog = page.getByRole('dialog', { name: '提交评审', exact: true })
  await reviewDialog.waitFor()
  expect(await reviewDialog.getByRole('textbox').count()).toBe(1)
  expect(await reviewDialog.getByText('请核对边界条件', { exact: true }).count()).toBe(0)
  expect(await changesScroll.evaluate(element => element.scrollTop)).toBe(reviewScroll)
  await page.setViewportSize({ width: 390, height: 780 })
  expect(await reviewDialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  const narrowDialog = await reviewDialog.boundingBox()
  if (narrowDialog === null) throw new Error('Review dialog must remain visible')
  expect(narrowDialog.x + narrowDialog.width).toBeLessThanOrEqual(390)
  await page.setViewportSize({ width: 1680, height: 500 })
  await page.keyboard.press('Escape')
  expect(await reviewDialog.count()).toBe(0)
  await view.getByRole('button', { name: '提交评审 (1)', exact: true }).click()
  await reviewDialog.getByRole('radio', { name: '请求更改', exact: true }).check()
  await reviewDialog.getByText('请求更改时，请填写评审总结', { exact: true }).waitFor()
  expect(await reviewDialog.getByRole('button', { name: '提交评审', exact: true }).isDisabled()).toBe(true)
  await compareOrRefreshGolden(join(EXPECTED, 'review-summary-required.expected.md'),
    await captureStableAria(page, '[role="dialog"][aria-label="提交评审"]', scaffold.workspaceCwd), MODE)
  await reviewDialog.getByRole('textbox', { name: '评审总结…', exact: true }).fill('需要补充边界检查')
  await compareOrRefreshGolden(join(EXPECTED, 'submit-review.expected.md'),
    await captureStableAria(page, '[role="dialog"][aria-label="提交评审"]', scaffold.workspaceCwd), MODE)
  await reviewDialog.getByRole('button', { name: '提交评审', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: '已提交评审' }).waitFor()
  await panelFile.locator('[data-forge-review-thread="published"]').getByText('请核对边界条件', { exact: true }).waitFor()
  await compareOrRefreshGolden(join(EXPECTED, 'review-record.expected.md'), await captureStableAria(page, '[data-forge-review-thread="published"]', scaffold.workspaceCwd), MODE)
  const published: unknown = JSON.parse((await readFile(join(root, 'reviews.jsonl'), 'utf8')).trim())
  expect(published).toEqual({ endpoint: 'repos/octo/demo/pulls/7/reviews', body: { commit_id: HEAD7, event: 'REQUEST_CHANGES', body: '需要补充边界检查',
    comments: [{ path: 'src/panel.ts', side: 'RIGHT', line: 4, start_line: 2, start_side: 'RIGHT', body: '请核对边界条件' }] } })
  await page.getByRole('button', { name: '退出全屏', exact: true }).click()
  await panelFile.getByRole('button', { name: '6 行未变更', exact: true }).click()
  await panelFile.getByText('export const n6 = 6', { exact: true }).first().waitFor({ timeout: 20_000 })
  await panelFile.getByRole('button', { name: '2 行未变更', exact: true }).waitFor()
  await panelFile.getByRole('button', { name: 'panel.ts 的更多操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '复制路径', exact: true }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('src/panel.ts')
  const docsFile = view.locator('[data-forge-diff-file="docs/panel.md"]')
  await docsFile.getByRole('button', { name: '收起 panel.md', exact: true }).click()
  await page.setViewportSize({ width: 1280, height: 500 })
  const scrollport = view.locator('[data-forge-changes-scroll]')
  await scrollport.evaluate((element) => { element.scrollTop = 100; element.dispatchEvent(new Event('scroll')) })
  await panelFile.locator('[data-forge-file-label]').click()
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
  expect(await panelFile.locator('[data-forge-review-thread="published"]').count()).toBe(1)
  await page.setViewportSize({ width: 1680, height: 1000 })
  await page.locator('[data-dockkit-tab]').filter({ hasText: '#7 的变更' }).locator('[data-dockkit-tab-close]').click()
  await expect.poll(() => view.count()).toBe(0)
  if (await header.getAttribute('aria-pressed') !== 'true') await header.click()
  await change.getByRole('button', { name: '查看 #7 的变更：新增 128 行，删除 14 行', exact: true }).click()
  await panelFile.getByRole('button', { name: '6 行未变更', exact: true }).waitFor()
  expect(await panelFile.locator('[data-forge-review-thread]').count()).toBe(0)
  await view.getByRole('button', { name: '提交评审', exact: true }).click()
  await reviewDialog.waitFor()
  expect(await reviewDialog.getByRole('textbox').inputValue()).toBe('')
  expect(await reviewDialog.getByRole('radio', { name: '评论', exact: true }).isChecked()).toBe(true)
  await page.keyboard.press('Escape')

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


it.skipIf(MODE === 'record')('retains a wrapped code line and tree width across tab and Session switches', async () => {
  const { page, scaffold, root, tripwire } = await launchPanel('web-e2e-forge-reading-position')
  const paths = ['src/before-0.ts', 'src/before-1.ts', 'src/before-2.ts', 'src/server.ts', 'src/after.ts']
  const patch = paths.map(path => [
    `diff --git a/${path} b/${path}`, 'index 1111111..2222222 100644', `--- a/${path}`, `+++ b/${path}`,
    '@@ -1,650 +1,650 @@', '-const oldValue = true;', '+const newValue = true;',
    ...Array.from({ length: 649 }, (_, index) => ` const value_${index + 2} = "${'x'.repeat(24 + (index + 2) % 70)}";`), '',
  ].join('\n')).join('\n')
  await writeFile(join(root, 'pr-7.diff'), patch)
  const { settled } = await sendPrompt(page, scaffold)
  const sessionId = await settled
  const session = scaffold.ctx.sessions.get(sessionId)
  if (session === undefined) throw new Error('Session must stay loaded')
  scaffold.ctx.forgeSession.track(session, PULL)
  // Keep the file tree and the Session sidebar visible together on every platform.
  await page.setViewportSize({ width: 2400, height: 700 })
  await page.locator('[data-forge-header]').click()
  await page.locator(`[data-forge-change="${PULL}"]`).getByRole('button', { name: /查看 #7 的变更/ }).click()
  const view = page.locator('[data-forge-changes="change"]')
  const scroll = view.locator('[data-forge-changes-scroll]')
  const file = view.locator('[data-forge-diff-file="src/server.ts"]')
  const code = file.locator('[data-review-code][data-new-line="300"]')
  const separator = view.getByRole('separator', { name: '调整文件树宽度', exact: true })
  const beforeFile = view.locator('[data-forge-diff-file="src/before-0.ts"]')
  // ResizeObserver runs between rendering frames, including when an ancestor becomes hidden.
  const layout = () => page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) })
  }))
  const reading = () => file.evaluate((element) => {
    const viewport = element.closest('[data-forge-changes-scroll]')!
    const top = Math.max(viewport.getBoundingClientRect().top, element.firstElementChild!.getBoundingClientRect().bottom)
    const line = [...element.querySelectorAll<HTMLElement>('[data-review-code][data-new-line]')]
      .find(row => row.getBoundingClientRect().bottom > top + 1)!
    return { path: element.getAttribute('data-forge-diff-file'), line: line.dataset.newLine,
      offset: line.getBoundingClientRect().top - top, scrollTop: viewport.scrollTop }
  })
  await code.waitFor()
  for (const width of [240, 320]) {
    if (width === 320) {
      for (let step = 0; step < 4; step += 1) await separator.press('ArrowRight')
      await beforeFile.getByRole('button', { name: '收起 before-0.ts', exact: true }).click()
    }
    await layout()
    await code.evaluate((element) => {
      const viewport = element.closest('[data-forge-changes-scroll]')!
      const header = element.closest('[data-forge-diff-file]')!.firstElementChild!
      const top = viewport.getBoundingClientRect().top + header.getBoundingClientRect().height
      viewport.scrollTop += element.getBoundingClientRect().top - top + 7
    })
    await layout()
    const position = await reading()
    expect(position.line).toBe('300')
    expect(position.offset).toBe(-7)
    for (const destination of ['tab', 'session', 'tab', 'session']) {
      if (destination === 'tab') await page.getByRole('tab').filter({ hasText: '变更请求' }).click()
      else await page.getByRole('button', { name: '新建会话', exact: true }).last().click()
      await expect.poll(() => view.isVisible()).toBe(false)
      await layout()
      expect(await scroll.evaluate(element => element.clientWidth)).toBe(0)
      if (destination === 'tab') await page.getByRole('tab').filter({ hasText: '#7 的变更' }).click()
      else await page.locator(`[data-row-key="session:${sessionId}"]`).click()
      await view.waitFor()
      await layout()
      expect(await separator.getAttribute('aria-valuenow')).toBe(String(width))
      expect(await reading()).toEqual(position)
      expect(await beforeFile.getAttribute('data-expanded')).toBe(width === 240 ? '' : null)
    }
  }
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})

it.skipIf(MODE === 'record')('uses horizontal arrows to navigate files while preserving vertical scrolling and comment editing', async () => {
  const { scaffold, page, project, tripwire } = await launchPanel('web-e2e-forge-file-keys')
  await git(project, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  await git(project, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  for (const path of ['a.txt', 'b.txt', 'c.txt']) {
    await writeFile(join(project, path), Array.from({ length: path === 'c.txt' ? 1 : 80 }, (_, line) => `line ${line + 1}\n`).join(''))
  }
  const { settled } = await sendPrompt(page, scaffold)
  await settled
  await page.locator('[data-forge-header]').click()
  await page.locator('[data-forge-panel]').getByRole('button', { name: '刷新状态', exact: true }).click()
  await page.locator('[data-forge-local]').getByRole('button', { name: /查看本会话的变更：3 个文件/ }).click()
  const view = page.locator('[data-forge-changes="local"]')
  const scroll = view.getByRole('region', { name: '全部 3 个文件', exact: true })
  await scroll.waitFor()
  await page.getByRole('button', { name: '全屏', exact: true }).click()
  await page.setViewportSize({ width: 1280, height: 500 })
  const tree = view.getByRole('navigation')
  const a = view.locator('[data-forge-diff-file="a.txt"]')
  const b = view.locator('[data-forge-diff-file="b.txt"]')
  const c = view.locator('[data-forge-diff-file="c.txt"]')
  await b.getByRole('button', { name: '收起 b.txt', exact: true }).click()
  await scroll.evaluate((element) => { element.scrollTop = 0 })
  await scroll.focus()
  await page.keyboard.press('ArrowLeft')
  expect(await scroll.evaluate(element => element.scrollTop)).toBe(0)
  expect(await scroll.evaluate(element => getComputedStyle(element).outlineStyle)).toBe('none')
  await page.keyboard.press('ArrowDown')
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  await scroll.evaluate((element) => { element.scrollTop = 0 })
  await page.keyboard.press('ArrowRight')
  await expect.poll(() => tree.getByRole('button', { name: 'b.txt', exact: true }).getAttribute('aria-current')).toBe('true')
  expect(await b.getAttribute('data-expanded')).toBe('')
  expect(await scroll.evaluate(element => document.activeElement === element)).toBe(true)
  await page.keyboard.press('ArrowRight')
  await expect.poll(() => tree.getByRole('button', { name: 'c.txt', exact: true }).getAttribute('aria-current')).toBe('true')
  const lastPosition = await scroll.evaluate(element => element.scrollTop)
  const lastBox = await c.boundingBox(), viewport = await scroll.boundingBox()
  if (lastBox === null || viewport === null) throw new Error('The last file and scroll viewport must be rendered')
  expect(lastBox.y).toBeGreaterThan(viewport.y)
  expect(lastBox.y).toBeLessThan(viewport.y + viewport.height)
  await page.keyboard.press('ArrowRight')
  expect(await scroll.evaluate(element => element.scrollTop)).toBe(lastPosition)
  await page.keyboard.press('ArrowLeft')
  await expect.poll(() => tree.getByRole('button', { name: 'b.txt', exact: true }).getAttribute('aria-current')).toBe('true')
  await page.keyboard.press('ArrowLeft')
  await expect.poll(() => tree.getByRole('button', { name: 'a.txt', exact: true }).getAttribute('aria-current')).toBe('true')
  await b.evaluate((element) => {
    const viewport = element.closest('[data-forge-changes-scroll]')!
    viewport.scrollTop += element.getBoundingClientRect().top - viewport.getBoundingClientRect().top + 100
  })
  await page.keyboard.press('ArrowRight')
  await expect.poll(() => tree.getByRole('button', { name: 'c.txt', exact: true }).getAttribute('aria-current')).toBe('true')
  await tree.getByRole('button', { name: 'a.txt', exact: true }).click()
  await a.getByRole('button', { name: '选择第 R1 行', exact: true }).click()
  await a.getByRole('button', { name: '添加评论', exact: true }).click()
  const input = a.getByRole('textbox', { name: '留下评论…', exact: true })
  await input.fill('keep editing')
  await input.press('ArrowLeft')
  expect(await input.evaluate(element => (element as HTMLTextAreaElement).selectionStart)).toBe(11)
  await input.press('ArrowRight')
  expect(await input.inputValue()).toBe('keep editing')
  expect(await tree.getByRole('button', { name: 'a.txt', exact: true }).getAttribute('aria-current')).toBe('true')
  expect(await input.evaluate(element => document.activeElement === element)).toBe(true)
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})

it.skipIf(MODE === 'record')('keeps localized status columns separate and long file lists inside one vertical scroller', async () => {
  const { scaffold, page, project, tripwire } = await launchPanel('web-e2e-forge-layout')
  await page.locator('[data-forge-current-branch]').waitFor()
  await compareOrRefreshGolden(join(EXPECTED, 'worktree-option.expected.md'),
    await captureStableAria(page, '[data-forge-worktree]', scaffold.workspaceCwd), MODE)
  await page.getByRole('button', { name: '收起侧边栏', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect.poll(() => page.locator('[data-forge-worktree]')
    .evaluate(element => element.getBoundingClientRect().right)).toBeLessThanOrEqual(390)
  await page.setViewportSize({ width: 1680, height: 1000 })
  await git(project, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  await git(project, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  await mkdir(join(project, 'src'))
  await Promise.all(Array.from({ length: 60 }, (_, index) => writeFile(join(project, 'src', `file-${index}.ts`), `export const value = ${index}\n`)))
  const { settled } = await sendPrompt(page, scaffold)
  const session = scaffold.ctx.sessions.get(await settled)
  if (session === undefined) throw new Error('The Session must stay loaded')
  scaffold.ctx.forgeSession.track(session, PULL)
  await page.locator('[data-forge-header]').click()
  const panel = page.locator('[data-forge-panel]')
  await panel.getByRole('button', { name: '刷新状态', exact: true }).click()
  const local = panel.locator('[data-forge-local]')
  await local.locator('button[aria-expanded]').click()
  await expect.poll(() => local.locator('li').count(), { timeout: 20_000 }).toBe(60)
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 700 })
    const outerScrollers = await panel.evaluate((element) => {
      const scrollers: string[] = []
      for (let ancestor = element.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
        if (/auto|scroll/.test(getComputedStyle(ancestor).overflowY) && ancestor.scrollHeight > ancestor.clientHeight + 1) {
          scrollers.push(ancestor.className)
        }
      }
      return scrollers
    })
    expect(outerScrollers).toEqual([])
    expect(await panel.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
    await local.locator('li').last().scrollIntoViewIfNeeded()
    expect(await local.locator('li').last().isVisible()).toBe(true)
  }
  await local.locator('button[aria-expanded]').click()
  const change = panel.locator(`[data-forge-change="${PULL}"]`)
  for (const [locale, labels] of [
    ['zh', ['检查', '评审', '合并', '变更']],
    ['en', ['Checks', 'Review', 'Merge', 'Changes']],
    ['de', ['Prüfungen', 'Review', 'Zusammenführen', 'Änderungen']],
  ] as const) {
    await scaffold.ctx.settings.update('locale', { preference: locale })
    await change.getByText(labels[0], { exact: true }).waitFor()
    if (locale === 'en') {
      await compareOrRefreshGolden(join(EXPECTED, 'local-card.expected.md'),
        await captureStableAria(page, '[data-forge-local]', scaffold.workspaceCwd), MODE)
    }
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 700 })
      await expect.poll(() => change.evaluate(element => element.getBoundingClientRect().right)).toBeLessThanOrEqual(width)
      await change.getByText(labels[3], { exact: true }).hover()
      for (const label of labels) {
        const geometry = await change.getByText(label, { exact: true }).evaluate((element) => {
          const value = element.nextElementSibling
          if (value === null) throw new Error('Status label must have a value')
          const range = document.createRange()
          range.selectNodeContents(element)
          const name = range.getBoundingClientRect()
          const content = value.getBoundingClientRect()
          const row = element.parentElement!
          const icon = element.previousElementSibling!
          const rowRect = row.getBoundingClientRect()
          return {
            gap: content.left - name.right,
            iconInset: icon.getBoundingClientRect().left - rowRect.left,
            rowInset: rowRect.left - row.closest('[data-forge-change]')!.getBoundingClientRect().left,
            labelWidth: element.getBoundingClientRect().width,
            valueOffset: content.left - rowRect.left,
            right: content.right,
            width: document.documentElement.clientWidth,
          }
        })
        expect(geometry.gap).toBeGreaterThanOrEqual(8)
        expect(geometry.iconInset).toBe(8)
        expect(geometry.rowInset).toBeGreaterThanOrEqual(6)
        expect(geometry.rowInset).toBeLessThanOrEqual(7)
        if (locale === 'zh') {
          expect(geometry.labelWidth).toBe(32)
          expect(geometry.valueOffset).toBe(76)
        }
        expect(geometry.right).toBeLessThanOrEqual(geometry.width)
      }
    }
  }
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})

it.skipIf(MODE === 'record')('keeps long branch details accessible by touch and keyboard across the hero row breakpoints', async () => {
  const branch = 'feature/a-long-current-branch-name-for-mobile-review'
  const { page, scaffold, tripwire } = await launchPanel('web-e2e-forge-branch-details', 'normal', { branch, hasTouch: true })
  const option = page.locator('[data-forge-worktree]')
  const chip = option.locator('[data-forge-current-branch]')
  await chip.waitFor()
  await page.getByRole('button', { name: '收起侧边栏', exact: true }).click()
  for (const [locale, label] of [['zh', `当前分支：${branch}`], ['en', `Current branch: ${branch}`], ['de', `Aktueller Branch: ${branch}`]] as const) {
    await scaffold.ctx.settings.update('locale', { preference: locale })
    await option.getByRole('button', { name: label, exact: true }).waitFor()
    for (const width of [390, 600, 601, 700, 1280]) {
      await page.setViewportSize({ width, height: 844 })
      await chip.scrollIntoViewIfNeeded()
      await expect.poll(() => option.evaluate((element) => {
        const row = element.closest('[class*="heroWorkspaceRow"]')!
        const ancestors: Element[] = []
        for (let node: Element | null = row; node !== null; node = node.parentElement) ancestors.push(node)
        return {
          fits: element.getBoundingClientRect().right <= innerWidth,
          overflow: ancestors.filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.className),
        }
      })).toEqual({ fits: true, overflow: [] })
    }
  }
  await scaffold.ctx.settings.update('locale', { preference: 'en' })
  await option.getByRole('button', { name: `Current branch: ${branch}`, exact: true }).waitFor()
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await chip.locator('span').evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true)
  const tooltip = page.getByRole('tooltip', { exact: true, name: `Current branch: ${branch}` })
  await chip.tap()
  await tooltip.waitFor()
  await compareOrRefreshGolden(join(EXPECTED, 'branch-details.expected.md'), await tooltip.ariaSnapshot(), MODE)
  await chip.tap()
  await tooltip.waitFor({ state: 'hidden' })
  await chip.tap()
  await tooltip.waitFor()
  await page.locator('[class*="heroWorkspaceRow"]').tap({ position: { x: 1, y: 1 } })
  await tooltip.waitFor({ state: 'hidden' })
  await chip.focus()
  await page.keyboard.press('Tab')
  await page.keyboard.press('Shift+Tab')
  await tooltip.waitFor()
  await page.keyboard.press('Escape')
  await tooltip.waitFor({ state: 'hidden' })
  await page.keyboard.press('Enter')
  await tooltip.waitFor()
  await page.keyboard.press('Escape')
  await tooltip.waitFor({ state: 'hidden' })
  expect(await option.getByRole('checkbox').isChecked()).toBe(false)
  expect(await page.getByRole('menu').count()).toBe(0)
  await scaffold.ctx.settings.update('locale', { preference: 'zh' })
  await option.getByRole('checkbox', { name: '新建工作树', exact: true }).waitFor()
  const { settled } = await sendPrompt(page, scaffold)
  await settled
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})

it.skipIf(MODE === 'record').each(['darwin', 'win32'] as const)('closes diff menus when the %s desktop shortcut deactivates a retained tab', async (platform) => {
  const { page, scaffold, project, tripwire } = await launchPanel(`web-e2e-forge-menu-${platform}`, 'normal', { desktop: platform })
  await git(project, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  await git(project, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  await writeFile(join(project, 'README.md'), 'review this change\n')
  const { settled } = await sendPrompt(page, scaffold)
  const sessionId = await settled
  await page.locator('[data-forge-header]').click()
  await page.locator('[data-forge-panel]').getByRole('button', { name: '刷新状态', exact: true }).click()
  await page.locator('[data-forge-local]').getByRole('button', { name: /查看本会话的变更：1 个文件/ }).click()
  const view = page.locator('[data-forge-changes="local"]')
  await view.locator('[data-forge-diff-file="README.md"]').waitFor()
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

it.skipIf(MODE === 'record').each([120, 4000])('types a review comment beside %i changed lines', async (count) => {
  const { scaffold, page, root, tripwire } = await launchPanel('web-e2e-forge-review-typing')
  const patch = ['diff --git a/src/typing.ts b/src/typing.ts', 'index 1111111..2222222 100644',
    '--- a/src/typing.ts', '+++ b/src/typing.ts', `@@ -1,${count} +1,${count} @@`,
    ...Array.from({ length: count }, (_, index) => {
      const context = index % 80 === 0 ? 'wrapped context '.repeat(600) : index % 5 === 0 ? 'context '.repeat(30) : ''
      return `-export const value${index} = [${index}, '${context}']\n+export const value${index} = [${index + 1}, '${context}']`
    }), ''].join('\n')
  await writeFile(join(root, 'pr-7.diff'), patch)
  const { settled } = await sendPrompt(page, scaffold)
  const sessionId = await settled
  const session = scaffold.ctx.sessions.get(sessionId)
  if (session === undefined) throw new Error('Session must stay loaded')
  scaffold.ctx.forgeSession.track(session, PULL)
  await page.locator('[data-forge-header]').click()
  const change = page.locator(`[data-forge-change="${PULL}"]`)
  await change.getByRole('button', { name: '查看 #7 的变更：新增 128 行，删除 14 行', exact: true }).click()
  const file = page.locator('[data-forge-diff-file="src/typing.ts"]')
  const collapsed = file.getByRole('button', { name: /^文件较大，/ })
  await file.waitFor()
  if (count > 120) await collapsed.click()
  await file.getByRole('button', { name: '选择第 R5 行', exact: true }).click()
  await file.getByRole('button', { name: '添加评论', exact: true }).click()
  const input = file.getByRole('textbox', { name: '留下评论…', exact: true })
  await input.waitFor()
  const field = await input.boundingBox()
  if (field === null) throw new Error('Comment field must be visible')
  await page.mouse.move(field.x + field.width - 3, field.y + field.height - 3)
  await page.mouse.down()
  await page.mouse.move(field.x + field.width - 3, field.y + field.height + 77, { steps: 5 })
  await page.mouse.up()
  const resized = await input.boundingBox()
  if (resized === null) throw new Error('Resized comment field must remain visible')
  expect(resized.height).toBeGreaterThan(field.height + 50)
  await input.fill('Review a wrapped line. '.repeat(80))
  expect(await input.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
  expect(await input.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await input.fill('')
  await page.keyboard.type('Check the boundary')
  await page.keyboard.press('Enter')
  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send('Input.imeSetComposition', { text: '检查', selectionStart: 2, selectionEnd: 2 })
    expect(await input.inputValue()).toBe('Check the boundary\n检查')
    expect(await file.locator('[data-forge-review-thread]').count()).toBe(0)
    await cdp.send('Input.insertText', { text: '检查边界条件' })
  } finally { await cdp.detach() }
  expect(await input.inputValue()).toBe('Check the boundary\n检查边界条件')
  await input.fill(' \n')
  expect(await file.getByRole('button', { name: '开始评审', exact: true }).isDisabled()).toBe(true)
  await input.fill('检查边界条件')
  await file.getByRole('button', { name: '开始评审', exact: true }).click()
  await file.locator('[data-forge-review-thread="pending"]').getByText('检查边界条件', { exact: true }).waitFor()
  expect(tripwire.pageErrors).toEqual([])
})
