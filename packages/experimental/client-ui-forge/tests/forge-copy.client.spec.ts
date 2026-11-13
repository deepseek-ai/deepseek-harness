// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en } from '../src/client/locales.ts'
import { useForgeCopy } from '../src/client/forge-copy.ts'

const translate = makeTranslate(en)

afterEach(cleanup)

describe('forge copy of a changes view', () => {
  it('names the provider and its word for a merge request', () => {
    const { result } = renderHook(() => useForgeCopy(translate, 'https://gitlab.example.test/group/app/-/merge_requests/6',
      { forge: 'gitlab', label: 'GitLab', changeRequestNoun: 'merge-request' }))

    expect(result.current.host).toEqual({ forge: 'GitLab', noun: 'MR' })
    expect(result.current.t('review.stale')).toBe('The MR has new commits. Refresh and select the comment lines again.')
    expect(result.current.t('thread.writeFailed', { message: 'denied', forge: 'Mirror' })).toBe('Mirror did not apply this: denied')
  })

  it.each([
    ['the host of its URL', 'https://code.example.test/a/b/pull/3', 'code.example.test'],
    ['the whole URL without a host', 'not a url', 'not a url'],
    ['nothing for local changes', null, ''],
  ])('names %s without a provider, with the pull request word', (_label, url, forge) => {
    const { result } = renderHook(() => useForgeCopy(translate, url, null))

    expect(result.current.host).toEqual({ forge, noun: 'PR' })
  })
})
