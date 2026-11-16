/** Copy of one changes view that names the change request's code host and what the host calls a change request. */

import { useMemo } from 'react'
import type { ForgeDescription } from '@deepseek-ai/dsh-experimental-forge/types'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locales.ts'

/** The `forge` and `noun` parameters of copy that names the code host; a type alias so it passes as notice parameters. */
export type HostParams = {
  /** Product name of the code host, such as `GitHub`. */
  readonly forge: string
  /** The code host's word for a change request, such as `PR`. */
  readonly noun: string
}

/** The view's copy, given the `forge` and `noun` parameters, and those parameters for its notices. */
export interface ForgeCopy {
  /** Translate a key; the caller's parameters override `forge` and `noun`. */
  readonly t: TranslateNS<typeof NS>
  /** The parameters, for notices whose copy names the code host. */
  readonly host: HostParams
}

/**
 * Give every string of a changes view the code host's name as `forge` and its word for a change request as `noun`.
 * Without a provider for the change request, `forge` is the host name of its URL and `noun` the pull request word,
 * which only appears beside the read failures such a view shows.
 * @param translate - forge panel copy.
 * @param url - web URL of the change request, or null for local changes.
 * @param forge - how the change request's provider names itself, or null without one.
 * @returns copy with both parameters, and the parameters.
 */
export function useForgeCopy(translate: TranslateNS<typeof NS>, url: string | null, forge: ForgeDescription | null): ForgeCopy {
  const label = forge?.label ?? (url === null ? '' : hostOf(url))
  const noun = translate(forge?.changeRequestNoun === 'merge-request' ? 'noun.mergeRequest' : 'noun.pullRequest')
  return useMemo(() => {
    const host = { forge: label, noun }
    return { t: (key, params) => translate(key, { ...host, ...params }), host }
  }, [translate, label, noun])
}

/**
 * Read the host name of a web URL.
 * @param url - web URL.
 * @returns the host as written, or the whole URL when it names none.
 */
function hostOf(url: string): string {
  return /^[a-z][a-z\d+.-]*:\/\/([^/?#]+)/i.exec(url)?.[1] ?? url
}
