/** The staged host list of a provider row: what a typed host stages, what is refused, and what one save writes. */
import { expect, it, vi } from 'vitest'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { HostSettingsForm, typedHost, type HostSettings } from '../src/client/host-settings-form.ts'

/** A form over a row that serves `gitlab.com`, with the hosts `taken` by other rows. */
function mounted(taken: readonly string[] = []) {
  const scope = stubConfigForm<HostSettings>()
  scope.publish({ status: 'ready', value: { hosts: ['gitlab.com'] }, base: { hosts: ['gitlab.com'] }, user: {}, writable: true, revision: 4 })
  const form = new HostSettingsForm(scope.scope, () => taken)
  const { hooks, ...actions } = form.inject()
  return { scope, form, state: () => hooks.hostForm.getSnapshot(), ...actions }
}

it.each([
  [' GitLab.Example.com ', 'gitlab.example.com'],
  ['https://GitLab.example.com:8443/group/app/-/merge_requests/2', 'gitlab.example.com:8443'],
  ['ssh://git@gitlab.example.com/group/app.git', 'gitlab.example.com'],
  ['https://', 'https://'],
  ['a b', 'a b'],
  ['', ''],
])('reads %j as the host %j', (text, host) => {
  expect(typedHost(text)).toBe(host)
})

it('shows no hosts before the Host serves the row', () => {
  const scope = stubConfigForm<HostSettings>()
  const form = new HostSettingsForm(scope.scope, () => [])
  try {
    expect(form.inject().hooks.hostForm.getSnapshot()).toMatchObject({ available: false, dirty: false, saved: [], draft: [] })
  } finally { form.dispose() }
})

it('stages added hosts and writes the whole list in one save', async () => {
  const m = mounted()
  try {
    expect(m.state()).toMatchObject({ available: true, dirty: false, saved: ['gitlab.com'], draft: ['gitlab.com'] })

    expect(m.add('https://GitLab.Example.com/group/app/-/merge_requests/2')).toBeUndefined()
    expect(m.add('git.corp.example:8443')).toBeUndefined()

    expect(m.state()).toMatchObject({ dirty: true, invalid: false, saved: ['gitlab.com'], draft: ['gitlab.com', 'gitlab.example.com', 'git.corp.example:8443'] })
    expect(m.scope.mutate).not.toHaveBeenCalled()
    m.save()
    await vi.waitFor(() => {
      expect(m.scope.mutate).toHaveBeenCalledWith([{ op: 'set', path: ['hosts'], value: ['gitlab.com', 'gitlab.example.com', 'git.corp.example:8443'] }], 4)
    })
  } finally { m.form.dispose() }
  expect(m.scope.listenerCount()).toBe(0)
})

it('stages nothing for blank text, a malformed host, a listed host, or a host another row serves', () => {
  const m = mounted(['GitHub.com'])
  try {
    expect(m.add('   ')).toBeUndefined()
    expect(m.add('a b')).toEqual({ kind: 'invalid' })
    expect(m.add('-gitlab.example.com')).toEqual({ kind: 'invalid' })
    expect(m.add('GITLAB.com')).toEqual({ kind: 'duplicate', host: 'gitlab.com' })
    expect(m.add('https://github.com/octo/demo/pull/1')).toEqual({ kind: 'taken', host: 'github.com' })

    expect(m.state()).toMatchObject({ dirty: false, draft: ['gitlab.com'] })
  } finally { m.form.dispose() }
})

it('stages removals but keeps the last host, and drops the staged list on discard', async () => {
  const m = mounted()
  try {
    m.remove('gitlab.com')
    expect(m.state()).toMatchObject({ dirty: false, draft: ['gitlab.com'] })

    m.add('gitlab.example.com')
    m.remove('gitlab.com')
    expect(m.state()).toMatchObject({ dirty: true, draft: ['gitlab.example.com'] })
    m.discard()
    expect(m.state()).toMatchObject({ dirty: false, draft: ['gitlab.com'] })

    m.add('gitlab.example.com')
    m.remove('gitlab.com')
    m.save()
    await vi.waitFor(() => { expect(m.scope.mutate).toHaveBeenCalledWith([{ op: 'set', path: ['hosts'], value: ['gitlab.example.com'] }], 4) })
  } finally { m.form.dispose() }
})
