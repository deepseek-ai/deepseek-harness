// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { NewSessionLimit } from '../src/client/NewSessionLimit.tsx'
import { en, zh } from '../src/client/task-manager-locales.ts'

afterEach(cleanup)

it.each([
  { dictionary: en, seconds: 7200, interval: '2 hours' },
  { dictionary: zh, seconds: 3600, interval: '1小时' },
  { dictionary: en, seconds: 5400, interval: '90 minutes' },
  { dictionary: en, seconds: 90, interval: '90 seconds' },
])('shows $seconds seconds using the configured limit and locale', async ({ dictionary, seconds, interval }) => {
  const t = makeTranslate(dictionary)
  render(<NewSessionLimit load={async () => seconds} t={t} />)
  expect(screen.getByRole('status', { name: dictionary['host.limitsLoading'] })).toBeDefined()
  await screen.findByText(t('host.newSessionInterval', { interval }))
})

it('reports a failed read and retries without inventing a default limit', async () => {
  const load = vi.fn<() => Promise<number | undefined>>().mockResolvedValueOnce(undefined).mockResolvedValueOnce(7200)
  const t = makeTranslate(en)
  render(<NewSessionLimit load={load} t={t} />)
  expect((await screen.findByRole('alert')).textContent).toBe(en['host.limitsError'])
  fireEvent.click(screen.getByRole('button', { name: en['list.retry'] }))
  await screen.findByText(t('host.newSessionInterval', { interval: '2 hours' }))
  expect(load).toHaveBeenCalledTimes(2)
})

it('ignores a late read from a replaced source and after unmount', async () => {
  const earlier = Promise.withResolvers<number | undefined>()
  const later = Promise.withResolvers<number | undefined>()
  const t = makeTranslate(en)
  const view = render(<NewSessionLimit load={() => earlier.promise} t={t} />)
  view.rerender(<NewSessionLimit load={() => later.promise} t={t} />)
  await act(async () => { later.resolve(7200); await later.promise })
  await act(async () => { earlier.resolve(3600); await earlier.promise })
  expect(screen.getByText(t('host.newSessionInterval', { interval: '2 hours' }))).toBeDefined()
  const final = Promise.withResolvers<number | undefined>()
  view.rerender(<NewSessionLimit load={() => final.promise} t={t} />)
  view.unmount()
  await act(async () => { final.resolve(60); await final.promise })
  expect(screen.queryByRole('status')).toBeNull()
})
