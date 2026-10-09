// Web e2e scenario: agent-preset selection. Every lane mounts the plugin's
// own shipped presets; this is the lane that puts them in front of a browser.
//
// Two surfaces, one host rule: a session's composition is fixed when the
// session starts. Before that, the new-session chip stages the choice beside
// the workspace picker — the only screen where it still works. After it, the
// session header names what the session runs and offers no control at all,
// because the host answers `agent-preset-locked` to anything else.
//
// Zero model calls: no replay fixture mounts, so a stray stream fails loud.
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  SESSION_FORMAT_VERSION, SessionId as sessionId, type SessionEvent, type SessionHeader, type SessionId,
} from '@deepseek-ai/dsh-session'
import { SUBAGENT_DESCRIPTOR_VERSION } from '@deepseek-ai/dsh-subagent'
import { createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, seedSession, watchConsole,
  webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { openSettings,
  connectFreshWorkspace, newEnglishPage, saveFailureShot, writeComposerDraft,
} from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/agent-preset-selection', import.meta.url))
const HERO_EXPECTED = join(SNAPSHOT_DIR, 'hero.expected.md')
const MENU_EXPECTED = join(SNAPSHOT_DIR, 'menu.expected.md')
const HEADER_EXPECTED = join(SNAPSHOT_DIR, 'header.expected.md')
const MODE = webSnapshotMode()
const SEED_ID = 'agent-preset-selection-web-e2e'
const SEED_TIME = 1784974100000
const SEEDED_CHILD_ID = sessionId('agent-preset-selection-child')
const SEEDED_CHILD_CREATED_AT = 1784974100100
/** A project skill only a preset that mounts `skill-filesystem` can discover. */
const SKILL_NAME = 'preset-catalog-demo'
/** The preset whose rows resolve and then refuse to start. */
const REFUSING_ID = 'zz-refusing'

/** Write the fixture module whose declaration fails during eager activation.
 * @param root Temporary directory holding the fixture module.
 */
async function seedRefusingPreset(root: string): Promise<void> {
  const directory = join(root, REFUSING_ID)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'refuses.mjs'),
    'export const name = \'refuses\'\nexport function apply() { throw new Error(\'this row refuses to start\') }\n')

}

/**
 * Seed one project skill under the connected workspace.
 *
 * Local skill discovery is a PRESET row, so this file is visible through
 * `standard` and invisible through `minimal` — which makes the '/' menu's
 * skill group a statement about the session's composition.
 * @param workspaceCwd - the scaffold's temp project parent.
 */
async function seedWorkspaceSkill(workspaceCwd: string): Promise<void> {
  const directory = join(workspaceCwd, 'workspace', '.agents', 'skills', SKILL_NAME)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), [
    '---',
    `name: ${SKILL_NAME}`,
    'description: Prove the slash catalog follows the session composition',
    '---',
    '',
    'Body.',
    '',
  ].join('\n'))
}

/**
 * A settled one-turn session with no model content: this lane asserts chrome
 * around a conversation, not a conversation, and a recorded turn would tie
 * the golden to a provider's wording for no gain. Its empty system head
 * belongs to the first step, before the user message.
 * @returns a tokenized session log ending on a closed turn.
 */
function seedLog(): string {
  const at = (index: number, event: Record<string, unknown>): string =>
    JSON.stringify({ ...event, seq: index, time: SEED_TIME + index })
  return [
    JSON.stringify({
      type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}',
      createdAt: SEED_TIME, cwd: '{{cwd}}/workspace', isSeeded: false, delegationDepth: 0,
    }),
    at(0, { type: 'turn/start', data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user', rpcId: 'seed' } } } }),
    at(1, { type: 'step/start', data: { turn: 1, step: 1 } }),
    at(2, {
      type: 'system/message',
      data: { turn: 1, step: 1, message: createSystemMessage('') },
      surfaceOp: 'append',
    }),
    at(3, {
      type: 'user/message',
      data: {
        id: '00000000-0000-4000-9000-000000000001',
        role: 'user',
        content: [{ type: 'text', text: 'Seeded turn.' }],
        source: { kind: 'user', rpcId: 'seed' },
      },
      surfaceOp: 'append',
    }),
    at(4, { type: 'session/title', data: { title: 'Seeded turn', messageSeqs: [3], source: { kind: 'fallback' } } }),
    at(5, { type: 'step/end', data: { turn: 1, step: 1 } }),
    at(6, {
      type: 'subagent/catalog',
      data: {
        version: 0,
        childId: SEEDED_CHILD_ID,
        childCreatedAt: SEEDED_CHILD_CREATED_AT,
        mode: 'one-shot',
        label: 'header order probe',
      },
    }),
    at(7, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }),
  ].join('\n')
}

/**
 * Persist one child so the assembled header snapshot exercises both action
 * contributors whose relative order is the product contract under test.
 * @param scaffold - the booted Web scaffold.
 * @param parentId - the seeded session whose header the browser opens.
 */
async function seedSubagent(scaffold: WebScaffold, parentId: SessionId): Promise<void> {
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: SEEDED_CHILD_ID,
    isSeeded: false,
    createdAt: SEEDED_CHILD_CREATED_AT,
    cwd: scaffold.workspaceCwd,
    parentSession: parentId,
    origin: 'subagent',
    delegationDepth: 1,
    agentPreset: 'minimal',
  }
  const handle = await scaffold.ctx.sessionPersistence.create(header)
  await handle.append([
    {
      type: 'turn/start',
      seq: 0,
      time: SEEDED_CHILD_CREATED_AT,
      data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } },
    },
    {
      type: 'user/message',
      seq: 1,
      time: SEEDED_CHILD_CREATED_AT + 1,
      data: createUserMessage({
        content: [{ type: 'text', text: 'Check the session-header action order.' }],
        source: { kind: 'user' },
      }),
      surfaceOp: 'append',
    },
    {
      type: 'subagent/descriptor',
      seq: 2,
      time: SEEDED_CHILD_CREATED_AT + 2,
      data: {
        version: SUBAGENT_DESCRIPTOR_VERSION,
        mode: 'one-shot', provider: 'spawn', label: 'header order probe',
      },
    },
    {
      type: 'turn/end',
      seq: 3,
      time: SEEDED_CHILD_CREATED_AT + 3,
      data: { turn: 1, reason: { kind: 'completed' } },
    },
  ] as SessionEvent[])
  await handle.close()
}

/**
 * The preset the host reports for the blank session the workspace connect
 * produced. Addressed by id rather than by scanning the serialized list: the
 * seeded session records `minimal` too, so a substring match over the whole
 * list answers before the switch has landed.
 * @param scaffold - authenticated Web Host scaffold.
 * @param targetId - exact Session to inspect after several Sessions have been created.
 * @returns the live session's preset, or undefined before it is listed.
 */
async function livePreset(scaffold: WebScaffold, targetId?: SessionId): Promise<string | undefined> {
  const response = await scaffold.hostFetch('/api/session/list', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request', rpcId: 'agent-preset-live', method: 'session/list',
      payload: { args: { _request: {} } },
    }),
  })
  const body = await response.json() as {
    result: {
      value?: {
        items: {
          sessionId: string
          projections?: { values: { agentPreset?: string | null } }
        }[]
      }
    }
  }
  const preset = body.result.value?.items.find(item => targetId === undefined ? item.sessionId !== SEED_ID : item.sessionId === targetId)
    ?.projections?.values.agentPreset
  return typeof preset === 'string' ? preset : undefined
}

/** Every option label the trigger menu currently lists. */
async function menuOptions(page: Page): Promise<string[]> {
  const menu = page.getByRole('listbox', { name: 'Trigger suggestions' })
  await menu.waitFor({ timeout: 10_000 })
  return await menu.getByRole('option').allTextContents()
}

describe('web e2e: agent-preset selection', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let fixtureRoot: string

  beforeAll(async () => {
    // The failed declaration remains in the registry, outside the selectable options.
    fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), 'dsh-web-e2e-refusing-')))
    await seedRefusingPreset(fixtureRoot)
    scaffold = await launchWebScaffold({
      agentPresets: { default: 'standard', definitions: [{ id: REFUSING_ID, name: 'Refusing mode', description: 'Refuses to start.', plugins: [{ name: pathToFileURL(join(fixtureRoot, REFUSING_ID, 'refuses.mjs')).href }] }] },
    })
    // A resumed session runs what it was created with; seeding one that
    // records `minimal` is what makes the header label a claim about the
    // session rather than an echo of the current default.
    const seededId = await seedSession(scaffold, seedLog(), SEED_ID, 'minimal')
    await seedSubagent(scaffold, seededId)
    await seedWorkspaceSkill(scaffold.workspaceCwd)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await rm(fixtureRoot, { recursive: true, force: true })
  })

  it('clears an unapplied hidden pick and creates a Standard session with the roster editable in Settings', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-agent-preset-hero'))
    expect(await livePreset(scaffold)).toBeUndefined()
    await page.getByRole('button', { name: 'Standard mode', exact: true }).click()
    await page.getByRole('menuitem', { name: /^Minimal mode/ }).click()
    await page.getByRole('button', { name: 'Minimal mode', exact: true }).waitFor()
    await openSettings(page, 'en')
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    const codingTools = dialog.getByRole('switch', { name: 'Show coding view' })
    await codingTools.click()
    await expect.poll(() => codingTools.getAttribute('aria-checked')).toBe('false')
    await dialog.getByRole('button', { name: 'Close' }).last().click()
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    await page.getByRole('button', { name: 'Standard mode', exact: true }).waitFor({ timeout: 10_000 })
    await expect.poll(() => livePreset(scaffold)).toBe('standard')

    await openSettings(page, 'en')
    await codingTools.click()
    await expect.poll(() => codingTools.getAttribute('aria-checked')).toBe('true')
    await dialog.getByRole('button', { name: 'Agent presets' }).click()
    await dialog.getByRole('button', { name: 'New task default: Standard mode' }).waitFor({ timeout: 10_000 })
    expect(await dialog.getByRole('switch').count()).toBe(0)
    await dialog.getByRole('button', { name: 'Set as new task default: Minimal mode' }).waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: 'Close' }).last().click()

    const snapshot = await captureStableAria(page, '[class*="heroWorkspaceRow"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(HERO_EXPECTED, snapshot, MODE)
    expect(snapshot).toContain('Standard mode')
  })

  it('names every preset and what it is for', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-agent-preset-menu'))
    await page.getByRole('button', { name: 'Standard mode' }).click()
    const menu = page.getByRole('menu')
    await menu.waitFor({ timeout: 10_000 })

    const snapshot = await captureStableAria(page, '[role="menu"]', scaffold.workspaceCwd)

    await compareOrRefreshGolden(MENU_EXPECTED, snapshot, MODE)
    // Every shipped preset, each with the sentence saying what it composes —
    // the id alone never said what a preset does.
    expect(snapshot).toContain('Minimal mode')
    expect(snapshot).toContain('Creator mode')
    await page.keyboard.press('Escape')
  })

  it('applies the staged pick to the blank session, and the host honors it', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-agent-preset-stage'))
    await page.getByRole('button', { name: 'Standard mode' }).click()
    await page.getByRole('menuitem', { name: /Minimal mode/ }).click()

    // The chip stages; the blank session the workspace connect produced is
    // what the stage lands on. The host's own answer is what comes back.
    await expect.poll(() => livePreset(scaffold), { timeout: 15_000 }).toBe('minimal')
    const roster = await scaffold.ctx.agentPresets.remoteExportList()
    expect(roster.presets.find(preset => preset.isDefault)?.id).toBe('standard')
  })

  it('omits eagerly failed presets from selection and retains their diagnostics', async () => {
    await page.getByRole('button', { name: 'Minimal mode' }).click()
    await page.getByRole('menu').waitFor()
    expect(await page.getByRole('menuitem', { name: /Refusing mode/ }).count()).toBe(0)
    await page.keyboard.press('Escape')
    expect((await scaffold.ctx.agentPresets.resolve(REFUSING_ID)).broken).toContain('this row refuses to start')
  })

  it('re-reads the slash catalog through the composition the switch installed', async () => {
    // Continues 'applies the staged pick': the chip has already applied `minimal` to
    // the blank session, and this one reads the menu that switch left behind.
    onTestFailed(() => saveFailureShot(page, 'web-e2e-agent-preset-slash-catalog'))
    const composer = page.locator('[data-composer-input][contenteditable="true"]').last()

    // `minimal` mounts neither the compaction group nor plan mode nor local
    // skill discovery, so the catalog the composer warmed under the
    // deployment default must not survive the switch.
    await writeComposerDraft(page, composer, '/')
    await expect.poll(() => menuOptions(page), { timeout: 15_000 })
      .not.toEqual(expect.arrayContaining([expect.stringContaining(SKILL_NAME)]))
    // Rows read as `Title Description`; the title is the capitalized command name.
    const onMinimal = (await menuOptions(page)).map(option => option.toLowerCase())
    expect(onMinimal.some(option => option.startsWith('compact'))).toBe(false)
    expect(onMinimal.some(option => option.startsWith('plan'))).toBe(false)
    // Preset-scoped commands follow the switch; the client's own model command
    // remains outside every preset.
    expect(onMinimal.some(option => option.startsWith('goal'))).toBe(false)
    expect(onMinimal.some(option => option.startsWith('model'))).toBe(true)
    await writeComposerDraft(page, composer, '')

    // Switching back up reaches the host at all — the chip compares the pick
    // against its list row, so a row that never reprojected the first switch
    // answers "already standard" and sends nothing — and restores the catalog
    // instead of leaving the session reading the narrower composition.
    await page.getByRole('button', { name: 'Minimal mode' }).click()
    await page.getByRole('menuitem', { name: /^Standard mode/ }).first().click()
    await expect.poll(() => livePreset(scaffold), { timeout: 15_000 }).toBe('standard')

    await writeComposerDraft(page, composer, '/')
    await expect.poll(() => menuOptions(page), { timeout: 15_000 })
      .toEqual(expect.arrayContaining([expect.stringContaining(SKILL_NAME)]))
    const onStandard = (await menuOptions(page)).map(option => option.toLowerCase())
    expect(onStandard.some(option => option.startsWith('compact'))).toBe(true)
    expect(onStandard.some(option => option.startsWith('goal'))).toBe(true)
    expect(onStandard.some(option => option.startsWith('plan'))).toBe(true)
    await writeComposerDraft(page, composer, '')
  }, 90_000)

  it('preserves the current mode while New Session uses the reset Standard default', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-agent-preset-disabled'))
    await expect.poll(() => livePreset(scaffold), { timeout: 15_000 }).toBe('standard')

    await openSettings(page, 'en')
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.getByRole('button', { name: 'Agent presets' }).click()
    await dialog.getByRole('button', { name: 'Set as new task default: Minimal mode' }).click()
    await dialog.getByRole('button', { name: 'New task default: Minimal mode' }).waitFor({ timeout: 10_000 })
    await expect.poll(() => livePreset(scaffold), { timeout: 15_000 }).toBe('minimal')
    await dialog.getByRole('button', { name: 'General', exact: true }).click()
    const developerTools = dialog.getByRole('switch', { name: 'Show coding view' })
    await developerTools.click()
    await expect.poll(() => developerTools.getAttribute('aria-checked')).toBe('false')
    await dialog.getByRole('button', { name: 'Close' }).last().click()

    await expect.poll(() => livePreset(scaffold), { timeout: 15_000 }).toBe('minimal')
    await page.getByRole('button', { name: 'Minimal mode', exact: true }).click()
    await page.getByRole('menu').waitFor()
    expect(await page.getByRole('menuitem', { name: /^PTC mode|^Minimal mode/ }).count()).toBe(0)
    expect(await page.getByRole('menuitem', { name: /^Standard mode|^Creator mode/ }).count()).toBe(2)
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await scaffold.ctx.agentPresets.remoteExportList()).presets.find(preset => preset.isDefault)?.id).toBe('standard')

    const creation = page.waitForResponse('**/api/session/create')
    await page.getByRole('button', { name: 'New session', exact: true }).last().click()
    const created = await creation
    expect(created.request().postDataJSON()).not.toHaveProperty('payload.args.request.sessionId')
    const createdBody = await created.json() as { result: { value: { sessionId: SessionId; agentPreset: string } } }
    expect(createdBody).toMatchObject({ result: { ok: true, value: { agentPreset: 'standard' } } })
    const freshSessionId = createdBody.result.value.sessionId
    const freshConversation = page.locator(`[data-conversation-session="${freshSessionId}"]`)
    await freshConversation.waitFor()
    await page.reload()
    await freshConversation.waitFor()
    await page.getByRole('button', { name: 'Standard mode', exact: true }).waitFor()

    await openSettings(page, 'en')
    const reopened = page.getByRole('dialog', { name: 'Settings' })
    await reopened.getByRole('button', { name: 'General', exact: true }).click()
    const reopenedDeveloperTools = reopened.getByRole('switch', { name: 'Show coding view' })
    await expect.poll(() => reopenedDeveloperTools.getAttribute('aria-checked')).toBe('false')
    await reopenedDeveloperTools.click()
    await expect.poll(() => reopenedDeveloperTools.getAttribute('aria-checked')).toBe('true')
    await reopened.getByRole('button', { name: 'Agent presets' }).click()
    await reopened.getByRole('button', { name: 'New task default: Standard mode' }).waitFor({ timeout: 10_000 })
    await reopened.getByRole('button', { name: 'Set as new task default: Minimal mode' }).waitFor({ timeout: 10_000 })
    await reopened.getByRole('button', { name: 'Close' }).last().click()
    await expect.poll(() => livePreset(scaffold, freshSessionId), { timeout: 15_000 }).toBe('standard')
    await page.getByRole('button', { name: 'Standard mode' }).waitFor({ timeout: 10_000 })
  })

  it('labels a resumed session with the preset it was created under', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-agent-preset-header'))
    // The seeded session's cwd is the scaffold root rather than the connected
    // workspace, so it lists under Ungrouped; the group collapses by default.
    await page.getByRole('treeitem', { name: /^Ungrouped/ }).click()
    await page.locator('[role="treeitem"]').last().click()
    await page.getByText('Seeded turn.').waitFor({ timeout: 15_000 })

    const snapshot = await captureStableAria(page, '[class*="titleRow"]', scaffold.workspaceCwd)

    await compareOrRefreshGolden(HEADER_EXPECTED, snapshot, MODE)
    expect(snapshot).toContain('Minimal mode')
    expect(snapshot).toContain('button "1 subagent"')
    expect(snapshot.indexOf('button "1 subagent"')).toBeLessThan(snapshot.indexOf('Minimal mode'))
    expect(snapshot.indexOf('button "1 subagent"')).toBeLessThan(snapshot.indexOf('button "More actions"'))
    // Static chrome, not a control: the header can only report a composition
    // the host would refuse to change.
    expect(snapshot).not.toContain('button "Minimal mode"')
  })

  it('drove every surface without a page error or a stream warning', () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})

it.each([false, true])('starts Creator from Plugins with Coding Tools=%s without changing drafts or defaults', async (developerTools) => {
  const scaffold = await launchWebScaffold({ developerTools, agentPresets: { default: 'standard' } })
  let browser: Browser | undefined
  try {
    browser = await chromium.launch()
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-creator'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const creator = scaffold.ctx.agents.list()[0]
    if (creator === undefined) throw new Error('Connecting the workspace did not create a Session')
    expect(scaffold.ctx.agentPresets.composedPreset(creator.ctx)).toBe('standard')
    await page.getByRole('button', { name: 'Standard mode', exact: true }).waitFor()
    const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
    const draft = 'Keep this unsent plugin idea.'
    await writeComposerDraft(page, composer, draft)

    await page.getByRole('navigation', { name: 'Global panels' }).getByRole('button', { name: 'Plugins', exact: true }).click()
    await page.getByRole('button', { name: 'Choose how to add a plugin', exact: true }).click()
    await Promise.all([
      page.waitForResponse('**/api/agentPresets/select'),
      page.getByRole('menuitem', { name: /^Let the agent create a plugin/ }).click(),
    ])
    const picker = page.getByTitle('Choose the agent preset for your new task', { exact: true }).filter({ hasText: 'Creator mode' })
    await picker.waitFor()
    await composer.filter({ hasText: draft }).waitFor()
    expect(await composer.innerText()).toBe(draft)
    expect(await picker.getAttribute('aria-haspopup')).toBe('menu')
    expect(await page.getByRole('dialog', { name: 'Add plugin', exact: true }).count()).toBe(0)
    expect(scaffold.ctx.sessionProjections.stateOf(creator.session, 'agentPreset')).toBe('cordis')
    expect(scaffold.ctx.agentPresets.composedPreset(creator.ctx)).toBe('cordis')
    expect(scaffold.ctx.tools.schemas(creator).map(tool => tool.name))
      .toEqual(expect.arrayContaining(['cordis_inspect_list', 'cordis_inspect_query', 'plugin_manager']))
    expect(creator.session.snapshotEvents().some(event => event.type === 'agent-preset/selected'
      && event.data.agentPreset === 'cordis')).toBe(true)
    expect(creator.session.snapshotEvents().some(event => event.type === 'user/message' || event.type === 'turn/start')).toBe(false)
    expect(scaffold.ctx.settings.describe().find(row => row.ns === 'ui-settings')?.value).toMatchObject({ enabled: developerTools })
    expect(scaffold.ctx.agentPresets.defaultId).toBe('standard')

    // Close a fixture turn on the real Creator Session without requesting a model.
    await writeComposerDraft(page, composer, '')
    creator.session.append('turn/start', { turn: 1 })
    creator.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Creator fixture completed without a model call.' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    creator.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await scaffold.ctx.sessions.flush(creator.session)
    await page.getByText('Creator fixture completed without a model call.', { exact: true }).waitFor()
    const newSession = page.getByRole('button', { name: 'New session', exact: true }).filter({ hasText: 'New Session' })
    await Promise.all([page.waitForResponse('**/api/session/create'), newSession.click()])
    expect(scaffold.ctx.agents.list().find(agent => agent.id !== creator.id)).toBeDefined()
    const next = scaffold.ctx.agents.list().find(agent => agent.id !== creator.id)!
    expect(next.id).not.toBe(creator.id)
    expect(next.session.header.agentPreset).toBe('standard')
    expect(scaffold.ctx.sessionProjections.stateOf(next.session, 'agentPreset')).toBe('standard')
    expect(scaffold.ctx.agentPresets.composedPreset(next.ctx)).toBe('standard')
    expect(scaffold.ctx.sessionProjections.stateOf(creator.session, 'agentPreset')).toBe('cordis')
    await page.getByRole('button', { name: 'Standard mode', exact: true }).waitFor()
    expect(scaffold.ctx.settings.describe().find(row => row.ns === 'ui-settings')?.value).toMatchObject({ enabled: developerTools })
    expect(scaffold.ctx.agentPresets.defaultId).toBe('standard')
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  } finally {
    await browser?.close()
    await scaffold.close()
  }
})
