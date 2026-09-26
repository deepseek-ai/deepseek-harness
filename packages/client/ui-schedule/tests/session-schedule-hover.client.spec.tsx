// @vitest-environment jsdom
import { act, cleanup, render, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { ScheduleCatalogEntry, ScheduleDeleteResult } from '@deepseek-ai/dsh-schedule/client'
import { ScheduleId } from '@deepseek-ai/dsh-schedule'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-ui-renderer/src/client/bind.ts'
import { createCatalogSource, type CatalogInjected } from '../src/client/catalog-source.ts'
import {
  formatScheduleAbsolute, formatScheduleFrequency, formatScheduleRelative,
} from '../src/client/schedule-format.ts'
import { SessionScheduleHover, type SessionScheduleHoverProps } from '../src/client/SessionScheduleHover.tsx'
import { en, zh } from '../src/client/locales.ts'
import css from '../src/client/SessionScheduleMark.module.css'

const SESSION = 'hover-session' as SessionId
const OTHER_SESSION = 'other-hover-session' as SessionId
const START = Date.parse('2026-08-25T12:00:00.000Z')

/** Device zone the cases pin, so the card's absolute stamp is deterministic. */
const DEVICE_ZONE = 'Asia/Shanghai'

/**
 * Pin the browser-resolved zone the absolute next-run stamp reads.
 * @param timeZone - IANA zone the component must resolve as the device zone.
 */
function pinSystemZone(timeZone: string): void {
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
    ...new Intl.DateTimeFormat().resolvedOptions(), timeZone,
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(START)
  pinSystemZone(DEVICE_ZONE)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function record(
  id: string,
  prompt: string,
  scheduledAt: number,
  sessionId: SessionId = SESSION,
  status: 'active' | 'inactive' = 'active',
  title?: string,
): ScheduleCatalogEntry {
  return {
    id: ScheduleId(id),
    sessionId,
    status,
    kind: 'every',
    title: title ?? prompt,
    prompt,
    everySeconds: 300,
    scheduledAt: new Date(scheduledAt).toISOString(),
  }
}

function sourceFor(
  list: () => Promise<RemoteResult<ScheduleCatalogEntry[]>>,
): CatalogInjected<ScheduleCatalogEntry> {
  return createCatalogSource<ScheduleCatalogEntry>({
    list,
    remove: async (): Promise<RemoteResult<ScheduleDeleteResult>> =>
      ({ ok: true, value: { id: ScheduleId('unused'), deleted: true } }),
    subscribeChanged: () => () => {},
    subscribeReset: () => () => {},
  })
}

function renderHover(
  source: CatalogInjected<ScheduleCatalogEntry>,
  sessionId: SessionId = SESSION,
  dictionary: typeof en | typeof zh = en,
) {
  const props = {
    sessionId,
    useCatalog: bindSnapshotSelector(source.hooks.catalog),
    t: makeTranslate(dictionary),
  } as SessionScheduleHoverProps
  return render(<SessionScheduleHover {...props} />)
}

/** Flush the source's initial read and its publication. */
async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

function section(container: HTMLElement): HTMLElement {
  const element = container.querySelector('[data-session-schedule-tasks]')
  if (element === null) throw new Error('task section must render')
  return element as HTMLElement
}

describe('Session hover-card task section', () => {
  it('shows two tasks and reports the omitted remainder', async () => {
    const rows = [
      record('first', 'First task', START + 300_000),
      record('second', 'Second task', START + 600_000),
      record('third', 'Third task', START + 900_000),
    ]
    const view = renderHover(sourceFor(async () => ({ ok: true, value: rows })))
    await settle()

    const tasks = section(view.container)
    expect(tasks.querySelectorAll('[data-session-schedule-task]')).toHaveLength(2)
    expect(within(tasks).getByText('First task')).toBeDefined()
    expect(within(tasks).getByText('Second task')).toBeDefined()
    expect(within(tasks).queryByText('Third task')).toBeNull()
    expect(within(tasks).getByText(en['hover.more'].replace('{count}', '1'))).toBeDefined()
  })

  it('keeps the two-row cap and elides every further task into the remainder count', async () => {
    const view = renderHover(sourceFor(async () => ({
      ok: true,
      value: [
        record('a', 'Task A', START + 300_000),
        record('b', 'Task B', START + 600_000),
        record('c', 'Task C', START + 900_000),
        record('d', 'Task D', START + 1_200_000),
      ],
    })))
    await settle()

    const tasks = section(view.container)
    expect(tasks.querySelectorAll('[data-session-schedule-task]')).toHaveLength(2)
    expect(within(tasks).queryByText('Task C')).toBeNull()
    expect(within(tasks).queryByText('Task D')).toBeNull()
    expect(within(tasks).getByText(en['hover.more'].replace('{count}', '2'))).toBeDefined()
  })

  it('shows every task with its frequency and next run when none are omitted', async () => {
    const view = renderHover(sourceFor(async () => ({
      ok: true,
      value: [record('only', 'Check metrics', START + 120_000)],
    })))
    await settle()

    const tasks = section(view.container)
    expect(within(tasks).getByText('Check metrics')).toBeDefined()
    expect(tasks.textContent).toContain('Every 5 minutes')
    expect(tasks.textContent).toContain('in 2 minutes')
    expect(tasks.textContent).not.toContain(en['hover.more'].replace('{count}', '1'))
    expect(view.container.textContent).not.toContain('{count}')
  })

  it.each([['English', en], ['Chinese', zh]] as const)(
    'states the next run in the same shape as the other three surfaces in %s',
    async (_name, dictionary) => {
      const only = record('only', 'Check metrics', START + 300_000)
      const view = renderHover(sourceFor(async () => ({ ok: true, value: [only] })), SESSION, dictionary)
      await settle()

      const timing = section(view.container).querySelector<HTMLElement>(`.${css.taskTiming!}`)!
      const translate = makeTranslate(dictionary)
      // Frequency, then the device-zone stamp, then the distance in parentheses.
      const absolute = formatScheduleAbsolute(only.scheduledAt, dictionary['time.locale'])
      const relative = formatScheduleRelative(only.scheduledAt, START, translate)
      expect(timing.textContent)
        .toBe(`${formatScheduleFrequency(only, translate)} · ${absolute} (${relative})`)
      const stamp = timing.querySelector('time')!
      expect(stamp.dateTime).toBe(only.scheduledAt)
      expect(stamp.textContent).toBe(absolute)
      // The distance carries the card's own weakened step, one below the stamp.
      expect(timing.querySelector<HTMLElement>(`.${css.taskRelative!}`)?.textContent).toBe(`(${relative})`)
    },
  )

  it('names each row with the stored title rather than the instruction', async () => {
    const view = renderHover(sourceFor(async () => ({
      ok: true,
      value: [
        record('named', 'Summarize the incident\nand every follow-up', START + 120_000, SESSION, 'active', 'Weekly review'),
      ],
    })))
    await settle()

    const tasks = section(view.container)
    expect(within(tasks).getByText('Weekly review')).toBeDefined()
    expect(tasks.textContent).not.toContain('Summarize the incident')
  })

  it('lists only the hovered Session tasks from the shared catalog', async () => {
    const view = renderHover(sourceFor(async () => ({
      ok: true,
      value: [
        record('mine', 'My task', START + 120_000),
        record('other', 'Other session task', START + 120_000, OTHER_SESSION),
      ],
    })))
    await settle()

    const tasks = section(view.container)
    expect(within(tasks).getByText('My task')).toBeDefined()
    expect(within(tasks).queryByText('Other session task')).toBeNull()
  })

  it('renders nothing while the read is unresolved, failed, empty, or holds only ended tasks', async () => {
    const pending = renderHover(sourceFor(() => new Promise(() => {})))
    expect(pending.container.querySelector('[data-session-schedule-tasks]')).toBeNull()
    pending.unmount()

    const failed = renderHover(sourceFor(async () => ({
      ok: false, error: new RemoteError('gateway/internal', 'Unavailable', {}),
    })))
    await settle()
    expect(failed.container.querySelector('[data-session-schedule-tasks]')).toBeNull()

    const empty = renderHover(sourceFor(async () => ({ ok: true, value: [] })))
    await settle()
    expect(empty.container.querySelector('[data-session-schedule-tasks]')).toBeNull()

    const ended = renderHover(sourceFor(async () => ({
      ok: true,
      value: [record('ended', 'Finished task', START + 120_000, SESSION, 'inactive')],
    })))
    await settle()
    expect(ended.container.querySelector('[data-session-schedule-tasks]')).toBeNull()
  })
})
