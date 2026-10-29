// @vitest-environment jsdom
/** The owner's share-permission section: one endpoint tier, the share's own tier and fork switch, and one save for all three. */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '../src/client/index.ts'
import { LiveshareShareDialog, type LiveshareShareDialogProps } from '../src/client/ShareDialog.tsx'
import { ShareCapabilitiesPicker } from '../src/client/ShareCapabilitiesPicker.tsx'
import { en } from '../src/client/locales.ts'
import css from '../src/client/ShareDialog.module.css'
import type { ShareCapabilityGroup } from '../src/share-api-types.ts'
import {
  accepted, DOUBLE_RELAY, ownerSharesDouble, refused, requestOf, type OwnerSharesCall,
} from './owner-shares-double.client.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const translate: LiveshareShareDialogProps['t'] = (key, params) => {
  let result: string = (en as Readonly<Record<string, string>>)[key] ?? key
  for (const [name, value] of Object.entries(params ?? {})) result = result.replace(`{${name}}`, String(value))
  return result
}

const READABLE = 'mekGit/getGraph'
const SECOND_READABLE = 'mekGit/listBranches'
const WRITABLE = 'mekGit/commit'
const SEARCH_READABLE = 'mekSearch/query'

/** Read-only offers, like the Git plugin: no plugin declares a writable endpoint. */
const READ_ONLY_OFFERED = [
  { plugin: 'mekGit', readable: [READABLE, SECOND_READABLE], writable: [] },
  { plugin: 'mekSearch', readable: [SEARCH_READABLE], writable: [] },
]
/** Offers with one writable endpoint, so the wider tier is available. */
const WRITABLE_OFFERED = [
  { plugin: 'mekGit', readable: [READABLE, SECOND_READABLE], writable: [WRITABLE] },
  { plugin: 'mekSearch', readable: [SEARCH_READABLE], writable: [] },
]
/** Offers of writable endpoints only, so the read tier has nothing to expose. */
const WRITE_ONLY_OFFERED = [{ plugin: 'mekGit', readable: [], writable: [WRITABLE] }]
/** One plugin with more endpoints than fit on screen, which the scrolling body holds. */
const LONG_OFFERED = [{
  plugin: 'mekGit',
  readable: Array.from({ length: 26 }, (_value, index) => `mekGit/op${String(index).padStart(2, '0')}`),
  writable: [],
}]
/** What the read tier expands to: every readable endpoint, no writable one. */
const READ_TIER = [
  { plugin: 'mekGit', readable: [READABLE, SECOND_READABLE], writable: [] },
  { plugin: 'mekSearch', readable: [SEARCH_READABLE], writable: [] },
]
/** What the write tier expands to: every readable endpoint plus every writable one. */
const WRITE_TIER = [
  { plugin: 'mekGit', readable: [READABLE, SECOND_READABLE], writable: [WRITABLE] },
  { plugin: 'mekSearch', readable: [SEARCH_READABLE], writable: [] },
]
/** What the read tier expands to for the offer that carries 26 readable endpoints. */
const LONG_READ_TIER = [{ plugin: 'mekGit', readable: LONG_OFFERED[0]!.readable, writable: [] }]

/** The record one case starts from, as the fake host has it stored. */
interface StoredShare {
  sessionMode?: 'view' | 'write'
  allowsFork: boolean
  viewerCapabilities: readonly ShareCapabilityGroup[]
}

interface CapabilityResponses {
  /** What the `capabilities` method offers; the default is a host that offers nothing. */
  readonly offered?: readonly ShareCapabilityGroup[]
  /** Grant the dialog a share session-scoped to it (the default), or none at all. */
  readonly share?: 'existing' | 'none'
  /** The stored record the fake host serves and updates. */
  readonly stored?: Partial<StoredShare>
  /** Whether the fake host refuses a permission write. */
  readonly permissionRefused?: boolean
  /** Whether the fake host refuses an endpoint write. */
  readonly capabilityRefused?: boolean
  /** Whether the fake host transport throws while writing endpoints. */
  readonly capabilityThrows?: boolean
}

interface Harness {
  /** Every Remote call the dialog made. */
  readonly calls: readonly OwnerSharesCall[]
  /** The fake host's record, which the writes above update. */
  readonly stored: StoredShare
  /** How many times the dialog read the host's share list, including a confirming re-read. */
  readonly shareReads: () => number
}

/** The permission write the dialog sent, or undefined when it sent none. */
function permissionWrite(harness: Harness) {
  return requestOf(harness.calls, 'updatePermissions')
}

/** The endpoint write the dialog sent, or undefined when it sent none. */
function capabilityWrite(harness: Harness) {
  return requestOf(harness.calls, 'setCapabilities')
}

/** The management writes the dialog sent, in order. */
function writeMethods(harness: Harness): readonly string[] {
  return harness.calls
    .map(call => call.method)
    .filter(method => method === 'updatePermissions' || method === 'setCapabilities')
}

async function showDialog(options: CapabilityResponses = {}, onClose: () => void = () => {}): Promise<Harness> {
  const stored: StoredShare = {
    allowsFork: false,
    viewerCapabilities: [],
    ...options.stored,
    ...(options.stored?.sessionMode === undefined ? { sessionMode: 'view' } : {}),
  }
  const link = `${DOUBLE_RELAY}/?shareId=existing`
  let shareReads = 0
  // Read afresh on every call: a write through the fake host must be visible to the confirming read.
  const listed = () => ({
    shareId: 'existing', sessionId: 'session', sessionTitle: 'Capability session', link,
    createdAt: '2026-09-05T00:00:00Z', online: true,
    access: { mode: 'open' as const, selected: [], deploymentAllowedSubjectIds: [],
      shareAllowedSubjectIds: [], broadenedByDeploymentSubjects: false, identityKeyAcl: true as const },
    ...stored,
  })
  const host = ownerSharesDouble({
    list: async () => {
      shareReads += 1
      return accepted({ shares: (options.share === 'none' ? [] : [listed()]) as never })
    },
    capabilities: async () => accepted({ capabilities: options.offered ?? [] }),
    updatePermissions: async (request) => {
      if (options.permissionRefused === true) return refused('gateway/internal', {})
      if (request.sessionMode !== undefined) stored.sessionMode = request.sessionMode
      if (request.allowsFork !== undefined) stored.allowsFork = request.allowsFork
      return accepted({
        shareId: 'existing',
        sessionMode: request.sessionMode ?? stored.sessionMode ?? 'view',
        allowsFork: request.allowsFork ?? stored.allowsFork,
      })
    },
    setCapabilities: async (request) => {
      if (options.capabilityThrows === true) throw new Error('host lost')
      if (options.capabilityRefused === true) return refused('gateway/internal', {})
      stored.viewerCapabilities = request.capabilities ?? []
      return accepted({ shareId: 'existing', viewerCapabilities: stored.viewerCapabilities })
    },
    relay: async () => accepted({ override: link, effective: link }),
    identity: async () => accepted({ state: 'verified', relay: link, displayName: 'Owner' }),
    testRelay: async () => accepted({ ok: true, httpReachable: true, blocking: false }),
    testPublish: async () => accepted({ ok: true, blocking: false }),
  })
  await act(async () => {
    render(<LiveshareShareDialog
      sessionId={'session' as SessionId}
      sessionTitle="Capability session"
      defaultRelay={link}
      shares={host.shares}
      onClose={onClose}
      t={translate}
    />)
  })
  return { calls: host.calls, stored, shareReads: () => shareReads }
}

/** The tier control's three segments, in display order. */
/** The endpoint-tier control, which shares its tab role with the session-permission control. */
function tierControl(): HTMLElement {
  return screen.getByRole('tablist', { name: 'Plugin endpoints' })
}

/** One segment of that control. */
function tierTab(name: 'Unavailable' | 'Read-only' | 'Writable'): HTMLElement {
  return within(tierControl()).getByRole('tab', { name })
}

/** The tier the control shows as selected. */
function selectedTier(): string | null {
  return within(tierControl()).getAllByRole('tab')
    .find(tab => tab.getAttribute('aria-selected') === 'true')?.textContent ?? null
}

/** The dialog's own footer, which sits outside the scrolling body. */
function panelFooter(): HTMLElement {
  const footer = document.querySelector<HTMLElement>(`.${css.panelFooter}`)
  if (footer === null) throw new Error('the dialog has no panel footer')
  return footer
}

/** The scrolling body the fields live in. */
function dialogBody(): HTMLElement {
  const body = document.querySelector<HTMLElement>(`.${css.body}`)
  if (body === null) throw new Error('the dialog has no body')
  return body
}

/** Save the permission section through the dialog's one save action. */
async function save(): Promise<void> {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save changes' })) })
}

/**
 * Drive the dialog's own polling read instead of waiting for its interval.
 * @returns A callback that runs every registered poll once.
 */
function interceptPolling(): () => void {
  const callbacks: (() => void)[] = []
  vi.stubGlobal('setInterval', (callback: () => void) => {
    callbacks.push(callback)
    return 0
  })
  return () => { for (const callback of callbacks) callback() }
}

/** Whether the save control is disabled right now. */
function saveDisabled(): boolean {
  const control = screen.getByRole('button', { name: 'Save changes' })
  if (!(control instanceof HTMLButtonElement)) throw new TypeError('the save control is not a button')
  return control.disabled
}

/** The permission the segmented control currently selects. */
function selectedMode(): 'view' | 'write' | undefined {
  const tablist = screen.getByRole('tablist', { name: 'Session permission' })
  const selected = tablist.querySelector<HTMLElement>('[aria-selected="true"]')
  if (selected?.textContent === 'Read only') return 'view'
  if (selected?.textContent === 'Workspace write') return 'write'
  return undefined
}

/** One permission segment for the share on hand. */
function modeTab(name: 'Read only' | 'Workspace write'): HTMLElement {
  return screen.getByRole('tab', { name })
}

/** The fork switch for the share on hand. */
function forkSwitch(): HTMLElement {
  return screen.getByRole('switch', { name: en['dialog.allowsFork'] })
}

/** Whether a switch primitive is on. */
function switchOn(element: HTMLElement): boolean {
  return element.getAttribute('aria-checked') === 'true'
}

describe('owner share permission section', () => {
  it('edits the same permission fields before and after a share exists', async () => {
    await showDialog({ offered: READ_ONLY_OFFERED, share: 'none' })
    // The create form owns the same fields as the stored-share editor; only the save action differs.
    expect(screen.getByText('Share permissions')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Create share' })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull()
    // The retired Advanced disclosure is gone rather than left as an empty shell.
    expect(screen.queryByText('Advanced')).toBeNull()
  })

  it('configures plugin endpoints before the share exists and stores them after create', async () => {
    const harness = await showDialog({ offered: READ_ONLY_OFFERED, share: 'none' })
    // The create form owns the same share-wide tier control the edit panel owns.
    expect(tierControl()).toBeDefined()
    await act(async () => { fireEvent.click(tierTab('Read-only')) })
    const create = screen.getByRole('button', { name: 'Create share' })
    await vi.waitFor(() => { expect(create).toHaveProperty('disabled', false) })
    await act(async () => { fireEvent.click(create) })
    // Creation is one host write; the endpoint tier is the second, addressed to the created share.
    expect(requestOf(harness.calls, 'create')).toBeDefined()
    expect(capabilityWrite(harness)).toEqual({ shareId: 'created', capabilities: READ_TIER })
  })

  it('creates without an endpoint write when the default tier is kept', async () => {
    const harness = await showDialog({ offered: READ_ONLY_OFFERED, share: 'none' })
    const create = screen.getByRole('button', { name: 'Create share' })
    await vi.waitFor(() => { expect(create).toHaveProperty('disabled', false) })
    await act(async () => { fireEvent.click(create) })
    expect(requestOf(harness.calls, 'create')).toBeDefined()
    expect(capabilityWrite(harness)).toBeUndefined()
  })

  it('states a created share whose endpoint write failed', async () => {
    const harness = await showDialog({ offered: READ_ONLY_OFFERED, share: 'none', capabilityRefused: true })
    await act(async () => { fireEvent.click(tierTab('Read-only')) })
    const create = screen.getByRole('button', { name: 'Create share' })
    await vi.waitFor(() => { expect(create).toHaveProperty('disabled', false) })
    await act(async () => { fireEvent.click(create) })
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', en['dialog.capabilities.createFailed'])
    // The share itself exists, and the write that failed is the endpoint write after it.
    expect(requestOf(harness.calls, 'create')).toBeDefined()
    expect(capabilityWrite(harness)).toEqual({ shareId: 'created', capabilities: READ_TIER })
  })

  it('states a created share whose endpoint write threw', async () => {
    const harness = await showDialog({ offered: READ_ONLY_OFFERED, share: 'none', capabilityThrows: true })
    await act(async () => { fireEvent.click(tierTab('Read-only')) })
    const create = screen.getByRole('button', { name: 'Create share' })
    await vi.waitFor(() => { expect(create).toHaveProperty('disabled', false) })
    await act(async () => { fireEvent.click(create) })
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', en['dialog.capabilities.createFailed'])
    expect(requestOf(harness.calls, 'create')).toBeDefined()
  })

  it('hides the endpoint control before the host offers one', async () => {
    await showDialog({ share: 'none' })
    expect(screen.queryByRole('tablist', { name: 'Plugin endpoints' })).toBeNull()
    expect(screen.getByRole('switch', { name: 'Plugin endpoints' })).toHaveProperty('disabled', true)
    expect(screen.getByText(en['dialog.capabilities.empty'])).toBeDefined()
  })

  it('opens plugin endpoints through one switch and closes them again', async () => {
    await showDialog({ offered: READ_ONLY_OFFERED })
    const pluginSwitch = screen.getByRole('switch', { name: 'Plugin endpoints' })
    expect(pluginSwitch).toHaveProperty('disabled', false)
    expect(switchOn(pluginSwitch)).toBe(false)
    await act(async () => { fireEvent.click(pluginSwitch) })
    expect(switchOn(screen.getByRole('switch', { name: 'Plugin endpoints' }))).toBe(true)
    expect(selectedTier()).toBe('Read-only')
    expect(screen.getByText('Read-only · 3 endpoints')).toBeDefined()
    await act(async () => { fireEvent.click(screen.getByRole('switch', { name: 'Plugin endpoints' })) })
    expect(switchOn(screen.getByRole('switch', { name: 'Plugin endpoints' }))).toBe(false)
    expect(selectedTier()).toBe('Unavailable')
  })

  it('is one share-wide endpoint tier, not a box per plugin endpoint', async () => {
    await showDialog({ offered: READ_ONLY_OFFERED })
    expect(screen.getByText('Share permissions')).toBeDefined()
    // One tier for the whole share, so no plugin name and no endpoint name is presented at all.
    expect(screen.queryByText('mekGit')).toBeNull()
    expect(screen.queryByText(READABLE)).toBeNull()
    expect(screen.queryByLabelText(`mekGit: ${READABLE}`)).toBeNull()
  })

  it('states the share permission and fork switch the host reported', async () => {
    await showDialog({ offered: READ_ONLY_OFFERED, stored: { sessionMode: 'write', allowsFork: true, viewerCapabilities: [] } })
    expect(selectedMode()).toBe('write')
    expect(switchOn(forkSwitch())).toBe(true)
  })

  it('offers no endpoint tier and nothing to save when no plugin declares an endpoint', async () => {
    await showDialog({ offered: [] })
    expect(screen.getByText('Share permissions')).toBeDefined()
    expect(screen.queryByRole('tablist', { name: 'Plugin endpoints' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Save changes' })).toHaveProperty('disabled', true)
    // Nothing is exposed and nothing was picked, so the dialog warns about no unsaved change.
    expect(screen.queryByText('Unsaved changes.')).toBeNull()
  })

  it('starts at the default endpoint tier and saves nothing until something changes', async () => {
    const harness = await showDialog({ offered: READ_ONLY_OFFERED })
    expect(selectedTier()).toBe('Unavailable')
    expect(screen.getByText('Not open to viewers')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Save changes' })).toHaveProperty('disabled', true)
    expect(writeMethods(harness)).toEqual([])
  })

  it('submits every plugin readable endpoint under the read-only tier, with the share permission', async () => {
    const harness = await showDialog({ offered: READ_ONLY_OFFERED })
    await act(async () => { fireEvent.click(tierTab('Read-only')) })
    expect(selectedTier()).toBe('Read-only')
    expect(screen.getByText('Read-only · 3 endpoints')).toBeDefined()
    expect(screen.getByText('Unsaved changes.')).toBeDefined()
    await save()
    expect(permissionWrite(harness)).toEqual({
      shareId: 'existing', sessionMode: 'view', allowsFork: false,
    })
    expect(capabilityWrite(harness)).toEqual({
      shareId: 'existing', capabilities: READ_TIER,
    })
    expect(screen.getByText('Share permissions and plugin endpoints saved.')).toBeDefined()
    expect(screen.queryByText('Unsaved changes.')).toBeNull()
  })

  it('submits every readable and writable endpoint under the writable tier', async () => {
    const harness = await showDialog({ offered: WRITABLE_OFFERED })
    await act(async () => { fireEvent.click(tierTab('Writable')) })
    expect(selectedTier()).toBe('Writable')
    expect(screen.getByText('Writable · 3 read-only + 1 writable')).toBeDefined()
    await save()
    expect(capabilityWrite(harness)).toEqual({
      shareId: 'existing', capabilities: WRITE_TIER,
    })
  })

  it('keeps the writable tier unavailable when no plugin declares a writable endpoint', async () => {
    await showDialog({ offered: READ_ONLY_OFFERED })
    expect(tierTab('Writable')).toHaveProperty('disabled', true)
    expect(screen.getByText('No plugin offers a writable endpoint, so Writable cannot be chosen.')).toBeDefined()
    // The caveat about writable endpoints is stated only where one exists to open.
    expect(screen.queryByText(/destructive inside a writable share/)).toBeNull()
  })

  it('keeps the read-only tier unavailable when no plugin declares a readable endpoint', async () => {
    const harness = await showDialog({ offered: WRITE_ONLY_OFFERED })
    // The master switch can only enable the tier the offer actually fills.
    await act(async () => { fireEvent.click(screen.getByRole('switch', { name: 'Plugin endpoints' })) })
    expect(selectedTier()).toBe('Writable')
    expect(tierTab('Read-only')).toHaveProperty('disabled', true)
    expect(tierTab('Writable')).toHaveProperty('disabled', false)
    expect(screen.getByText('No plugin offers a read-only endpoint, so Read-only cannot be chosen.')).toBeDefined()
    await act(async () => { fireEvent.click(tierTab('Writable')) })
    await save()
    expect(capabilityWrite(harness)).toEqual({
      shareId: 'existing',
      capabilities: [{ plugin: 'mekGit', readable: [], writable: [WRITABLE] }],
    })
  })

  it('reads a stored record of exactly every readable endpoint as the read-only tier', async () => {
    await showDialog({ offered: READ_ONLY_OFFERED, stored: { allowsFork: false, viewerCapabilities: READ_TIER } })
    expect(selectedTier()).toBe('Read-only')
    expect(screen.getByText('Read-only · 3 endpoints')).toBeDefined()
    expect(screen.queryByText('Unsaved changes.')).toBeNull()
  })

  it('reads a stored record of every readable and writable endpoint as the writable tier', async () => {
    await showDialog({ offered: WRITABLE_OFFERED, stored: { allowsFork: false, viewerCapabilities: WRITE_TIER } })
    expect(selectedTier()).toBe('Writable')
    expect(screen.getByText('Writable · 3 read-only + 1 writable')).toBeDefined()
    expect(screen.queryByText('Unsaved changes.')).toBeNull()
  })

  it('shows a stored record that is no whole tier as the default and says saving replaces it', async () => {
    await showDialog({
      offered: READ_ONLY_OFFERED,
      stored: { allowsFork: false, viewerCapabilities: [{ plugin: 'mekGit', readable: [READABLE], writable: [] }] },
    })
    expect(selectedTier()).toBe('Unavailable')
    expect(screen.getByText('The saved selection is not one whole tier; saving again replaces it with the tier you pick.')).toBeDefined()
  })

  it('edits the share permission, the fork switch, and the endpoints in one save', async () => {
    const harness = await showDialog({ offered: WRITABLE_OFFERED })
    await act(async () => { fireEvent.click(modeTab('Workspace write')) })
    await act(async () => { fireEvent.click(forkSwitch()) })
    await act(async () => { fireEvent.click(tierTab('Writable')) })
    await save()

    expect(permissionWrite(harness)).toEqual({
      shareId: 'existing', sessionMode: 'write', allowsFork: true,
    })
    expect(capabilityWrite(harness)).toEqual({
      shareId: 'existing', capabilities: WRITE_TIER,
    })
    // The fields read the host's record back, which is what the writes stored.
    expect(harness.stored.sessionMode).toBe('write')
    expect(harness.stored.allowsFork).toBe(true)
    expect(selectedMode()).toBe('write')
    expect(switchOn(forkSwitch())).toBe(true)
    expect(selectedTier()).toBe('Writable')
    expect(saveDisabled()).toBe(true)
  })

  it('keeps the save reachable outside the scrolling list, however many endpoints are offered', async () => {
    const harness = await showDialog({ offered: LONG_OFFERED })
    const saveButton = screen.getByRole('button', { name: 'Save changes' })
    const footer = panelFooter()
    expect(footer.contains(saveButton)).toBe(true)
    // The fields scroll; the save does not live in that scroll container.
    expect(dialogBody().contains(footer)).toBe(false)
    expect(dialogBody().contains(screen.getByRole('tablist', { name: 'Plugin endpoints' }))).toBe(true)
    // And the whole expansion is what the save submits, not the part that happens to be in view.
    await act(async () => { fireEvent.click(tierTab('Read-only')) })
    await save()
    expect(capabilityWrite(harness)).toEqual({
      shareId: 'existing', capabilities: LONG_READ_TIER,
    })
  })

  it('states a refused permission write, keeps the owner picks, and stays usable', async () => {
    const harness = await showDialog({ offered: READ_ONLY_OFFERED, permissionRefused: true })
    await act(async () => { fireEvent.click(tierTab('Read-only')) })
    await save()
    expect(screen.getByRole('alert').textContent).toBe('The share permissions were not saved. Try again.')
    // Nothing landed, so the endpoint write that expands the refused tier is never sent either.
    expect(writeMethods(harness)).toEqual(['updatePermissions'])
    // The endorsement stays on screen after a refusal: the owner retries the same save.
    expect(selectedTier()).toBe('Read-only')
    expect(screen.getByText('Unsaved changes.')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Save changes' })).toHaveProperty('disabled', false)
  })

  it('states the permission that landed when only the endpoint write was refused, and re-reads it', async () => {
    const harness = await showDialog({ offered: READ_ONLY_OFFERED, capabilityRefused: true })
    await act(async () => { fireEvent.click(tierTab('Read-only')) })
    const readsBefore = harness.shareReads()
    await save()
    // Both writes were sent, and only the endpoint one was refused.
    expect(writeMethods(harness)).toEqual([
      'updatePermissions', 'setCapabilities',
    ])
    // The message names what actually happened instead of claiming nothing was saved.
    expect(screen.getByRole('alert').textContent)
      .toBe('The session permission was updated, but the plugin endpoints were not saved. Try again.')
    // The host's record is read again once the refusal is known, so the panel states it, not the old one.
    expect(harness.shareReads()).toBe(readsBefore + 1)
    // The endpoint pick stays for the retry, and the panel still says the endpoints are unsaved.
    expect(selectedTier()).toBe('Read-only')
    expect(screen.getByText('Unsaved changes.')).toBeDefined()
    expect(saveDisabled()).toBe(false)
  })

  it('follows the host record while nothing is unsaved, and keeps an unsaved pick', async () => {
    const poll = interceptPolling()
    const harness = await showDialog({ offered: READ_ONLY_OFFERED })

    // A change made in Share management reaches the host, and this panel states the same record.
    harness.stored.sessionMode = 'write'
    harness.stored.viewerCapabilities = READ_TIER
    await act(async () => { poll() })
    expect(selectedMode()).toBe('write')
    expect(selectedTier()).toBe('Read-only')

    // An unsaved pick of the owner's own is not replaced by a later poll of the host's record.
    await act(async () => { fireEvent.click(forkSwitch()) })
    harness.stored.sessionMode = 'view'
    await act(async () => { poll() })
    expect(switchOn(forkSwitch())).toBe(true)
    expect(selectedMode()).toBe('write')
  })

  it('warns once before closing with unsaved changes, then closes', async () => {
    const onClose = vi.fn()
    await showDialog({ offered: READ_ONLY_OFFERED }, onClose)
    await act(async () => { fireEvent.click(tierTab('Read-only')) })
    const done = within(panelFooter()).getByRole('button', { name: 'Done' })

    await act(async () => { fireEvent.click(done) })
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByText('Unsaved changes; choosing Done again discards them.')).toBeDefined()

    await act(async () => { fireEvent.click(done) })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes without a warning when nothing was changed', async () => {
    const onClose = vi.fn()
    await showDialog({ offered: READ_ONLY_OFFERED }, onClose)
    await act(async () => { fireEvent.click(within(panelFooter()).getByRole('button', { name: 'Done' })) })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/discards them/u)).toBeNull()
  })
})

describe('endpoint tier control', () => {
  it('renders nothing while no plugin offers an endpoint', () => {
    const view = render(
      <ShareCapabilitiesPicker
        offered={[]}
        tier="none"
        stale={false}
        disabled={false}
        controlId="capabilities"
        onPick={() => {}}
        t={translate}
      />,
    )
    expect(view.container.innerHTML).toBe('')
  })
})
