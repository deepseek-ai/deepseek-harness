/** The client reader for share access and endpoint offers: only a complete record becomes presentable. */

import { describe, expect, it } from 'vitest'
import { readAccess, readOfferedPlugins, readPluginAccess, readViewerPolicies } from '../src/client/share-types.ts'

describe('confirmed share access', () => {
  it('summarizes the mode and both subject counts', () => {
    expect(readAccess({
      mode: 'selected',
      selected: [{ subjectId: 'a' }, { subjectId: 'b' }],
      deploymentAllowedSubjectIds: ['c'],
    })).toEqual({ mode: 'selected', selectedCount: 2, deploymentCount: 1 })
    expect(readAccess({ mode: 'open', selected: [], deploymentAllowedSubjectIds: [] }))
      .toEqual({ mode: 'open', selectedCount: 0, deploymentCount: 0 })
  })

  it('reads nothing as confirmed from a value that is not an access record', () => {
    for (const refused of [undefined, null, 'selected', 3]) expect(readAccess(refused)).toBeUndefined()
    // A legacy record states no mode; a malformed one states a mode this build cannot confirm.
    expect(readAccess({})).toBeUndefined()
    expect(readAccess({ mode: 'everyone', selected: [], deploymentAllowedSubjectIds: [] })).toBeUndefined()
    expect(readAccess({ mode: 'open', selected: [], deploymentAllowedSubjectIds: 'all' })).toBeUndefined()
  })
})

describe('viewer endpoint catalog', () => {
  it('reads one plugin entry with its package and endpoint list', () => {
    expect(readOfferedPlugins([{
      plugin: 'ui-chat', package: '@deepseek-ai/dsh-client-ui-chat', endpoints: ['session/list'],
    }])).toEqual([{
      plugin: 'ui-chat', package: '@deepseek-ai/dsh-client-ui-chat', endpoints: ['session/list'],
    }])
  })

  it('drops a package field the host left empty', () => {
    expect(readOfferedPlugins([{ plugin: 'ui-chat', package: '', endpoints: ['session/list'] }]))
      .toEqual([{ plugin: 'ui-chat', endpoints: ['session/list'] }])
  })

  it('leaves out every entry this build cannot present', () => {
    expect(readOfferedPlugins([
      { endpoints: ['session/list'] },
      { plugin: '', endpoints: [] },
      { plugin: 'no-endpoints' },
      { plugin: 'bad-entry', endpoints: ['session/list', 3] },
      { plugin: 'ui-chat', endpoints: [] },
    ])).toEqual([{ plugin: 'ui-chat', endpoints: [] }])
  })

  it('reads no offer at all from a host that reports none', () => {
    for (const empty of [undefined, null, 'ui-chat', 3]) expect(readOfferedPlugins(empty)).toEqual([])
    expect(readOfferedPlugins([null, 'ui-chat'])).toEqual([])
  })

  it('keeps readable titles and descriptions and drops malformed ones', () => {
    expect(readOfferedPlugins([{
      plugin: 'ui-chat',
      endpoints: ['ui-chat/send'],
      titles: { zh: '聊天', en: '' },
      descriptions: { 'ui-chat/send': '发送消息', 'ui-chat/empty': '' },
    }])).toEqual([{
      plugin: 'ui-chat',
      endpoints: ['ui-chat/send'],
      titles: { zh: '聊天' },
      descriptions: { 'ui-chat/send': '发送消息' },
    }])
    expect(readOfferedPlugins([{
      plugin: 'plain', endpoints: ['plain/send'], titles: ['bad'], descriptions: { only: '' },
    }])).toEqual([{ plugin: 'plain', endpoints: ['plain/send'] }])
  })
})

describe('viewer plugin policies', () => {
  it('reads all, none, and a selected subset', () => {
    expect(readViewerPolicies([
      { plugin: 'ui-chat', mode: 'all' },
      { plugin: 'job', mode: 'none' },
      { plugin: 'files', mode: 'selected', endpoints: ['files/read'] },
    ])).toEqual([
      { plugin: 'ui-chat', mode: 'all' },
      { plugin: 'job', mode: 'none' },
      { plugin: 'files', mode: 'selected', endpoints: ['files/read'] },
    ])
  })

  it('drops legacy groups and malformed modes', () => {
    expect(readViewerPolicies([
      { plugin: 'ui-chat', readable: ['session/list'], writable: [] },
      { plugin: 'job', mode: 'sometimes' },
      { plugin: 'files', mode: 'selected', endpoints: [3] },
      { plugin: '', mode: 'all' },
    ])).toEqual([])
    expect(readViewerPolicies(undefined)).toEqual([])
    expect(readViewerPolicies([null, 'bad'])).toEqual([])
  })
})

describe('global plugin access', () => {
  it('reads only an explicit all as open', () => {
    expect(readPluginAccess('all')).toBe('all')
    for (const closed of [undefined, null, 'none', 'sometimes', 1]) expect(readPluginAccess(closed)).toBe('none')
  })
})
