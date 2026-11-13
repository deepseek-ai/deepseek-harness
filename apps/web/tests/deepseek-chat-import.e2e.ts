/**
 * Web snapshot: the optional DeepSeek chat import bundle stores a synthetic
 * export as Sessions through its owner upload route, and one imported Session
 * continues with one recorded model turn. The committed Session is the imported
 * history the model receives: the newest-leaf branch, reasoning, the
 * `web_search` / `web_fetch` pair, and an excluded reply; a content-filtered
 * round is left out entirely.
 * Record: DSH_SNAPSHOT=record writes the current Session generation; a keyless
 * DSH_SNAPSHOT=refresh then writes the system-prompt and tool-schema pins.
 */
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { strToU8, zipSync } from 'fflate'
import { chromium, type Browser } from 'playwright'
import { expect, it, onTestFailed } from 'vitest'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import {
  assertFixtureInventory, fixtureUserPrompts, launchWebScaffold, recordFixture, selectedSessionFixture,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const DIR = fileURLToPath(new URL('../../../snapshots/web/deepseek-chat-import', import.meta.url))
const FIXTURE = join(DIR, `session.v${SESSION_FORMAT_VERSION}.jsonl`)
const BUNDLE_DIR = fileURLToPath(new URL('../../../packages/experimental/deepseek-chat-import', import.meta.url))
const UPLOAD_PATH = '/api/deepseek-chat-import/archive'
const MODE = webSnapshotMode()

// Record sends this prompt; replay asserts the committed fixture recorded exactly it.
const PROMPT = 'Without calling any tools, answer in one short sentence: which bus did you recommend earlier, and which of my earlier questions has no answer yet?'

const BASE = Date.UTC(2026, 10, 11, 2, 0, 0)
const at = (seconds: number): string => new Date(BASE + seconds * 1000).toISOString()
const ROUTE_URL = 'https://transit.example/routes/12'
const RESUMED_TITLE = 'Bus to the city museum'
const FIRST_QUESTION = 'Which bus goes from Central Station to the City Museum?'

/**
 * The continued conversation in the 2026-11-12 export structure.
 * `current_message_id` 8 selects the branch through messages 1, 2, 5, 6, 7,
 * and 8 and drops the side branch 3/4. The question 5 with its CONTENT_FILTER
 * reply 6 is left out entirely; the INCOMPLETE reply 8 ends its turn with an
 * error and stays out of model history.
 */
const RESUMED = {
  id: 'museum-route', title: RESUMED_TITLE, current_message_id: 8, inserted_at: at(0),
  messages: [
    { id: 1, parent_id: null, role: 'USER', status: 'FINISHED', inserted_at: at(10), fragments: [{ type: 'REQUEST', content: FIRST_QUESTION }] },
    {
      id: 2, parent_id: 1, role: 'ASSISTANT', status: 'FINISHED', inserted_at: at(12), fragments: [
        { type: 'THINK', content: 'Check the current route before answering.', elapsed_secs: 2 },
        { type: 'READ_LINK', results: [{ url: ROUTE_URL, title: 'Route 12 timetable' }] },
        {
          type: 'TOOL_SEARCH', queries: ['Central Station City Museum bus'], status: 'FINISHED', stage_id: 1, results: [{
            url: ROUTE_URL, title: 'Route 12 timetable', snippet: 'Route 12 runs from Central Station to the City Museum every 10 minutes.', published_at: null,
          }],
        },
        { type: 'TOOL_OPEN', status: 'FINISHED', url: ROUTE_URL, title: 'Route 12 timetable', stage_id: 2 },
        { type: 'THINK', content: 'Route 12 stops at the museum.', elapsed_secs: 1 },
        { type: 'RESPONSE', content: 'Take bus 12 from Central Station; it stops at the City Museum.' },
      ],
    },
    { id: 3, parent_id: 2, role: 'USER', status: 'FINISHED', inserted_at: at(60), fragments: [{ type: 'REQUEST', content: 'How long is the ride?' }] },
    { id: 4, parent_id: 3, role: 'ASSISTANT', status: 'FINISHED', inserted_at: at(62), fragments: [{ type: 'RESPONSE', content: 'About 25 minutes.' }] },
    { id: 5, parent_id: 2, role: 'USER', status: 'FINISHED', inserted_at: at(120), fragments: [{ type: 'REQUEST', content: 'Is there a night bus?' }] },
    { id: 6, parent_id: 5, role: 'ASSISTANT', status: 'CONTENT_FILTER', inserted_at: at(122), fragments: [{ type: 'RESPONSE', content: 'Withdrawn night bus answer.' }] },
    { id: 7, parent_id: 6, role: 'USER', status: 'FINISHED', inserted_at: at(180), fragments: [{ type: 'REQUEST', content: 'Does bus 12 run on Sundays?' }] },
    { id: 8, parent_id: 7, role: 'ASSISTANT', status: 'INCOMPLETE', inserted_at: at(182), fragments: [{ type: 'RESPONSE', content: 'Interrupted Sunday answer.' }] },
  ],
}

/** An older conversation imported beside the continued one. */
const OTHER = {
  id: 'packing-list', title: 'Day trip packing list', current_message_id: 2, inserted_at: at(-86_400),
  messages: [
    { id: 1, parent_id: null, role: 'USER', status: 'FINISHED', inserted_at: at(-86_390), fragments: [{ type: 'REQUEST', content: 'List three things to pack for a day trip.' }] },
    { id: 2, parent_id: 1, role: 'ASSISTANT', status: 'FINISHED', inserted_at: at(-86_388), fragments: [{ type: 'RESPONSE', content: 'Water, a snack, and a phone charger.' }] },
  ],
}

/** The final line of the upload route's NDJSON answer. */
interface ImportOutcomeLine {
  readonly type: 'outcome'
  readonly outcome:
    | { readonly ok: true; readonly value: { readonly sessionIds: readonly string[] } & Record<string, unknown> }
    | { readonly ok: false; readonly error: { readonly reason: string; readonly message: string } }
}

/** A `deepseek_data` ZIP holding the manifest and both conversations. */
function exportArchive(): Uint8Array<ArrayBuffer> {
  return new Uint8Array(zipSync({
    'manifest.json': strToU8(JSON.stringify({ export_format_version: 3 })),
    'chat_session_index.json': strToU8(JSON.stringify([RESUMED, OTHER].map(file => ({
      id: file.id, title: file.title, pinned: false, inserted_at: file.inserted_at,
      updated_at: file.messages[file.messages.length - 1]?.inserted_at ?? file.inserted_at,
      message_count: file.messages.length,
    })))),
    ...Object.fromEntries([RESUMED, OTHER].map(file => [`chat_sessions/${file.id}.json`, strToU8(JSON.stringify(file))])),
  }))
}

/**
 * Upload the archive the way the bundle's browser half does and read the outcome line.
 * @param scaffold - the booted Web scaffold, whose cookie authenticates the owner.
 * @param workspaceId - Workspace receiving the imported Sessions.
 * @returns the outcome, which must be the only outcome line and the last line.
 */
async function importArchive(scaffold: WebScaffold, workspaceId: string): Promise<ImportOutcomeLine['outcome']> {
  const response = await scaffold.hostFetch(`${UPLOAD_PATH}?workspaceId=${encodeURIComponent(workspaceId)}`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: exportArchive(),
  })
  expect(response.status).toBe(200)
  const lines = (await response.text()).split('\n').filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as { readonly type?: string })
  const outcomes = lines.filter((line): line is ImportOutcomeLine => line.type === 'outcome')
  expect(outcomes, 'the import answer carries exactly one outcome line').toHaveLength(1)
  expect(lines.at(-1)).toBe(outcomes[0])
  return outcomes[0]!.outcome
}

it('continues a Session imported from a DeepSeek chat export with one model turn', async () => {
  if (MODE !== 'record') {
    expect(fixtureUserPrompts(await readFile(await selectedSessionFixture(FIXTURE), 'utf8')).at(-1)).toBe(PROMPT)
  }
  const scaffold = await launchWebScaffold({
    profile: { packages: [{ dir: BUNDLE_DIR, enabled: true }] },
    ...(MODE === 'record' ? {} : { replayFixture: FIXTURE, compareReplaySession: true }),
  })
  let browser: Browser | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const outcome = await importArchive(scaffold, workspace.id)
    expect(outcome).toMatchObject({ ok: true, value: { workspaceId: workspace.id, conversationCount: 2, omittedByLimit: 0, skipped: [] } })
    const sessionIds = outcome.ok ? outcome.value.sessionIds : []
    expect(sessionIds).toHaveLength(2)

    browser = await chromium.launch()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-deepseek-chat-import'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('treeitem').filter({ has: page.getByText(RESUMED_TITLE, { exact: true }) }).click({ timeout: 20_000 })
    await page.getByText(FIRST_QUESTION, { exact: true }).first().waitFor({ timeout: 20_000 })
    const input = page.locator('[data-composer-input][contenteditable="true"]').first()
    await input.waitFor({ timeout: 15_000 })
    const settled = scaffold.whenTurnSettled()
    await input.fill(PROMPT)
    await input.press('Enter')
    const sessionId = await settled
    expect(sessionIds).toContain(sessionId)

    const session = scaffold.ctx.agents.get(sessionId)?.session
    if (session === undefined) throw new Error('the continued Session has no live Agent')
    const events = session.snapshotEvents()
    const turn = events.slice(events.findLastIndex(event => event.type === 'turn/start'))
    expect(turn.filter(event => event.type === 'tool/call'), 'the continued turn answers without tools').toEqual([])
    expect(turn.find(event => event.type === 'turn/end')).toMatchObject({ data: { reason: { kind: 'completed' } } })
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    // Every check precedes the write, so a failed record run leaves no fixture behind.
    if (MODE === 'record') await recordFixture(scaffold, sessionId, FIXTURE)
  } finally {
    try {
      await browser?.close()
    } finally {
      await scaffold.close()
    }
  }
}, 240_000)

it.skipIf(MODE === 'record')('keeps a closed fixture inventory', async () => {
  await assertFixtureInventory(DIR, [basename(FIXTURE), 'system-prompt.expected.md', 'tool-schemas.expected.json'])
})
