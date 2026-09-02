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
import { fileURLToPath } from 'node:url'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  SESSION_FORMAT_VERSION, SessionId as sessionId, type SessionEvent, type SessionHeader, type SessionId,
} from '@deepseek-ai/dsh-session'
import { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, seedSession, watchConsole,
  webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import {
  connectFreshWorkspace, newEnglishPage, saveFailureShot, writeComposerDraft,
} from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/agent-preset-selection', import.meta.url))
const HERO_EXPECTED = join(SNAPSHOT_DIR, 'hero.expected.md')
const MENU_EXPECTED = join(SNAPSHOT_DIR, 'menu.expected.md')
const HEADER_EXPECTED = join(SNAPSHOT_DIR, 'header.expected.md')
const MODE = webSnapshotMode()
const SEED_ID = 'agent-preset-selection-web-e2e'
/** A project skill only a preset that mounts `skill-filesystem` can discover. */
const SKILL_NAME = 'preset-catalog-demo'
/** The preset whose rows resolve and then refuse to start. */
const REFUSING_ID = 'zz-refusing'

/**
 * Seed a preset discovery reports healthy and the mount refuses.
 *
 * Every row resolves — the module is right there beside the composition — so
 * health has nothing to report and the chip offers the preset like any other.
 * Only starting it finds out, which is the case the chip's banner exists for.
 * @param root - the lane's writable preset root.
 */
async function seedRefusingPreset(root: string): Promise<void> {
  const directory = join(root, REFUSING_ID)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'refuses.mjs'),
    'export const name = \'refuses\'\nexport function apply() { throw new Error(\'this row refuses to start\') }\n')
  await writeFile(join(directory, 'agent.cordis.yml'), '- id: refuses\n  name: ./refuses.mjs\n')
  await writeFile(join(directory, 'preset.yml'),
    'name: Refusing mode\ndescription: Resolves, then refuses to start.\n')
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
 * the golden to a provider's wording for no gain.
 * @returns a tokenized session log ending on a closed turn.
 */
function seedLog(): string {
  const time = 1784974100000
  const at = (index: number, event: Record<string, unknown>): string =>
    JSON.stringify({ ...event, seq: index, time: time + index })
  return [
    JSON.stringify({ type: 'session', version: 0, id: '{{sessionId}}', createdAt: time, cwd: '{{cwd}}/workspace' }),
    at(0, { type: 'turn/start', data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user', rpcId: 'seed' } } } }),
    at(1, {
      type: 'user/message',
      data: {
        id: '00000000-0000-4000-9000-000000000001',
        role: 'user',
        content: [{ type: 'text', text: 'Seeded turn.' }],
        source: { kind: 'user', rpcId: 'seed' },
      },
      surfaceOp: 'append',
    }),
    at(2, { type: 'session/title', data: { title: 'Seeded turn', messageSeqs: [1], source: { kind: 'fallback' } } }),
    at(3, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }),
  ].join('\n')
}

/**
 * Persist one child so the assembled header snapshot exercises both action
 * contributors whose relative order is the product contract under test.
 * @param scaffold - the booted Web scaffold.
 * @param parentId - the seeded session whose header the browser opens.
 */
async function seedSubagent(scaffold: WebScaffold, parentId: SessionId): Promise<void> {
  const childId = sessionId('agent-preset-selection-child')
  const createdAt = 1784974100100
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: childId,
    isSeeded: false,
    createdAt,
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
      time: createdAt,
      data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } },
    },
    {
      type: 'user/message',
      seq: 1,
      time: createdAt + 1,
      data: {
        content: [{ type: 'text', text: 'Check the session-header action order.' }],
        source: { kind: 'user' },
      },
      surfaceOp: 'append',
    },
    {
      type: 'subagent/descriptor',
      seq: 2,
      time: createdAt + 2,
      data: snapshotSubagentDescriptor({
        mode: 'one-shot', provider: 'spawn', label: 'header order probe',
      }),
    },
    {
      type: 'turn/end',
      seq: 3,
      time: createdAt + 3,
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
 * @returns the live session's preset, or undefined before it is listed.
 */
async function livePreset(scaffold: WebScaffold): Promise<string | undefined> {
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
  const preset = body.result.value?.items.find(item => item.sessionId !== SEED_ID)
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
  let presetRoot: string

  beforeAll(async () => {
    // The shipped presets, plus one lane-owned preset that mounts and refuses:
    // the chip's own failure path needs a preset the roster offers.
    presetRoot = await realpath(await mkdtemp(join(tmpdir(), 'dsh-web-e2e-refusing-')))
    await seedRefusingPreset(presetRoot)
    scaffold = await launchWebScaffold({
      agentPresets: { roots: [{ path: presetRoot, trust: 'user' }], default: 'standard' },
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
  })

  it('offers the chip on the new-session screen, beside the workspace picker', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-agent-preset-hero'))
    await connectFreshWorkspace(page, scaffold.workspaceCwd)

    const snapshot = await captureStableAria(page, '[class*="heroWorkspaceRow"]', scaffold.workspaceCwd)

    await compareOrRefreshGolden(HERO_EXPECTED, snapshot, MODE)
    // The chip opens on the deployment default, by the name that preset
    // publishes rather than its directory name.
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
  })

  it('says why a switch was refused instead of letting the chip revert in silence', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-agent-preset-refused'))
    await page.getByRole('button', { name: 'Minimal mode' }).click()
    await page.getByRole('menuitem', { name: /Refusing mode/ }).click()

    // Health cleared every row, so nothing on the settings page says this
    // preset is unusable — the banner is where the host's reason lands, and
    // without it the chip just snaps back to the preset it already ran.
    const banner = page.getByRole('alert').filter({ hasText: 'Refusing mode' })
    await banner.waitFor({ timeout: 15_000 })
    expect(await banner.textContent()).toContain('this row refuses to start')
    await expect.poll(() => livePreset(scaffold), { timeout: 15_000 }).toBe('minimal')
    await page.getByRole('button', { name: 'Minimal mode' }).waitFor({ timeout: 10_000 })
  }, 60_000)

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
    const onMinimal = await menuOptions(page)
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
    const onStandard = await menuOptions(page)
    expect(onStandard.some(option => option.startsWith('compact'))).toBe(true)
    expect(onStandard.some(option => option.startsWith('goal'))).toBe(true)
    expect(onStandard.some(option => option.startsWith('plan'))).toBe(true)
    await writeComposerDraft(page, composer, '')
  }, 90_000)

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
    expect(snapshot.indexOf('Minimal mode')).toBeLessThan(snapshot.indexOf('button "Session log"'))
    // Static chrome, not a control: the header can only report a composition
    // the host would refuse to change.
    expect(snapshot).not.toContain('button "Minimal mode"')
  })

  it('drove every surface without a page error or a stream warning', () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
