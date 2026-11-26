import type { ChangeRequestActivityItem, ForgeCommentAuthor, ForgeCommit } from '@deepseek-ai/dsh-experimental-forge'
import { describe, expect, it } from 'vitest'
import { ACTIVITY_QUERY, noteEntries, readActivity, withListedCommitNames } from '../src/activity.ts'
import type { ActivityNote } from '../src/activity.ts'
import { GitLabApi } from '../src/api.ts'
import type { GlabOutput } from '../src/glab.ts'
import { app, fakeGlab, HOST, json, merge, mrPath, output, sent, sha } from './fixtures.ts'

const signal = new AbortController().signal

/** Global id of the project the notes belong to. */
const PROJECT = 'gid://gitlab/Project/278'

/** The time of a note unless a test gives it another. */
const AT = '2026-11-08T12:00:00+08:00'

/** Web page of the note with `id`. */
function page(id: number): string {
  return `https://${HOST}/group/sub/app/-/merge_requests/6#note_${id}`
}

type Author = NonNullable<ActivityNote['author']>

const lin: Author = { username: 'lin', avatarUrl: '/uploads/-/system/user/avatar/7/lin.png', bot: false }
const zhou: Author = { username: 'zhou', avatarUrl: 'https://assets.example.test/zhou.png', bot: false }
const robot: Author = { username: 'project_278_bot', avatarUrl: null, bot: true }

/** A position on a text line of the diff. */
const onDiff = { positionType: 'text' }

/** A note a person wrote outside the diff, with any other fields. */
function note(fields: Partial<ActivityNote> = {}): ActivityNote {
  const person = { system: false, body: 'Looks right.', createdAt: AT, url: page(1), author: lin, position: null, systemNoteMetadata: null }
  return { ...person, ...fields }
}

/** A system note that records `action` with the sentence `body`. */
function system(action: string | null, body: string, fields: Partial<ActivityNote> = {}): ActivityNote {
  return note({ system: true, body, systemNoteMetadata: action === null ? null : { action }, ...fields })
}

/** The actor of an entry by `author`. */
function actor(author: Author): ForgeCommentAuthor {
  const avatarUrl = author.avatarUrl?.startsWith('/') === true ? `https://${HOST}${author.avatarUrl}` : author.avatarUrl
  return { login: author.username, avatarUrl, bot: author.bot }
}

/** What an entry holds besides its time and its actor. */
type Detail = ChangeRequestActivityItem extends infer Item ? Item extends unknown ? Omit<Item, 'at' | 'actor'> : never : never

/** An entry at {@link AT} by `author`. */
function entry(detail: Detail, author: Author | null = lin, at = AT): ChangeRequestActivityItem {
  return { at, actor: author === null ? null : actor(author), ...detail }
}

/** The note query's answer for a merge request with `nodes`. */
function notesAnswer(
  nodes: readonly (ActivityNote | null)[], fields: { readonly cut?: boolean; readonly createNote?: boolean } = {},
): GlabOutput {
  return json({ data: { project: { id: PROJECT, mergeRequest: {
    userPermissions: { createNote: fields.createNote ?? true },
    notes: { pageInfo: { hasPreviousPage: fields.cut ?? false }, nodes },
  } } } })
}

/** One state change as the REST list reports it. */
function stateEvent(state: string, at: string, user: Author | null = lin): unknown {
  return { id: 1, state, created_at: at, user: user === null ? null : { id: 7, username: user.username, avatar_url: user.avatarUrl } }
}

/** A GitLab that answers the note query with `notes` and the state change read with `states`. */
function gitlab(notes: GlabOutput, states: GlabOutput = json([])) {
  const glab = fakeGlab(path => path === 'graphql' ? notes : states)
  return { subject: new GitLabApi(glab.run), calls: glab.calls }
}

describe('GitLab activity reads', () => {
  it('reads the latest notes and the state changes through two requests and orders their entries by time', async () => {
    const upload = '0123456789abcdef0123456789abcdef'
    const { subject, calls } = gitlab(notesAnswer([
      note({ body: `Please split the parser.\n\n![shot](/uploads/${upload}/shot.png)`, createdAt: '2026-11-08T12:00:00+08:00' }),
      system('approved', 'approved this merge request', { createdAt: '2026-11-08T12:05:00+08:00', url: page(2), author: zhou }),
      note({ body: 'Rebased.', createdAt: '2026-11-08T12:07:00+08:00', url: null, author: null }),
      note({ body: 'Pipeline passed.', createdAt: '2026-11-08T12:08:00+08:00', url: page(4), author: robot }),
    ]), json([
      stateEvent('closed', '2026-11-08T12:02:10.500+08:00'),
      stateEvent('reopened', '2026-11-08T12:03:00.000+08:00', null),
      stateEvent('locked', '2026-11-08T12:06:00.000+08:00', zhou),
      stateEvent('merged', '2026-11-08T12:09:00.250+08:00', zhou),
    ]))

    const result = await readActivity(subject, merge(6), signal)

    expect(calls.map(call => call.args)).toEqual([
      ['api', 'graphql', '--hostname', HOST, '--input', '-', '-H', 'Content-Type: application/json'],
      ['api', '--hostname', HOST, `${mrPath(6)}/resource_state_events?per_page=100`],
    ])
    expect(sent(calls[0])).toEqual({ query: ACTIVITY_QUERY, variables: { path: 'group/sub/app', iid: '6' } })
    const shot = `https://${HOST}/-/project/278/uploads/${upload}/shot.png`
    expect(result).toEqual({
      items: [
        entry({ kind: 'comment', body: `Please split the parser.\n\n![shot](${shot})`, url: page(1) }),
        entry({ kind: 'closed' }, lin, '2026-11-08T12:02:10.500+08:00'),
        entry({ kind: 'reopened' }, null, '2026-11-08T12:03:00.000+08:00'),
        entry({ kind: 'review', verdict: 'approved', body: '', comments: 0, url: page(2) }, zhou, '2026-11-08T12:05:00+08:00'),
        entry({ kind: 'other', text: 'locked' }, zhou, '2026-11-08T12:06:00.000+08:00'),
        entry({ kind: 'comment', body: 'Rebased.', url: null }, null, '2026-11-08T12:07:00+08:00'),
        entry({ kind: 'comment', body: 'Pipeline passed.', url: page(4) }, robot, '2026-11-08T12:08:00+08:00'),
        entry({ kind: 'merged' }, zhou, '2026-11-08T12:09:00.250+08:00'),
      ],
      truncated: false,
      viewerCanComment: true,
    })
  })

  it('lists a note before a state change of its second, and denies comments to a user who may add no note', async () => {
    const { subject } = gitlab(notesAnswer([note()], { createNote: false }), json([
      stateEvent('closed', '2026-11-08T11:59:59.900+08:00'), stateEvent('reopened', '2026-11-08T12:00:00.400+08:00'),
    ]))
    const result = await readActivity(subject, merge(6), signal)
    expect(result).toMatchObject({ viewerCanComment: false, truncated: false })
    expect('items' in result && result.items.map(item => item.kind)).toEqual(['closed', 'comment', 'reopened'])
  })

  it('drops the state changes before the first note of a page that leaves out earlier notes', async () => {
    const { subject } = gitlab(notesAnswer([note({ createdAt: '2026-11-08T12:10:00+08:00' })], { cut: true }), json([
      stateEvent('closed', '2026-11-08T12:00:00.000+08:00'), stateEvent('reopened', '2026-11-08T12:20:00.000+08:00'),
    ]))
    const result = await readActivity(subject, merge(6), signal)
    expect(result).toMatchObject({ truncated: true })
    expect('items' in result && result.items.map(item => item.kind)).toEqual(['comment', 'reopened'])
  })

  it('skips a note GitLab returns as null, keeping every state change beside a page without a note', async () => {
    const { subject } = gitlab(notesAnswer([null], { cut: true }), json([stateEvent('closed', '2026-11-08T12:00:00.000+08:00')]))
    await expect(readActivity(subject, merge(6), signal)).resolves.toEqual({
      items: [entry({ kind: 'closed' }, lin, '2026-11-08T12:00:00.000+08:00')], truncated: true, viewerCanComment: true,
    })
  })

  it('returns the latest 100 entries of a merge request with more', async () => {
    const commits = Array.from({ length: 101 }, (_, index) => `<li>${(index + 0x1000_0000).toString(16)} - step ${index}</li>`).join('')
    const { subject } = gitlab(notesAnswer([
      system('commit', `added 101 commits\n\n<ul>${commits}</ul>`), note({ createdAt: '2026-11-08T12:01:00+08:00' }),
    ]))
    const result = await readActivity(subject, merge(6), signal)
    expect(result).toMatchObject({ truncated: true })
    const items = 'items' in result ? result.items : []
    expect(items).toHaveLength(100)
    expect(items[0]).toEqual(entry({ kind: 'commit', sha: '10000002', title: 'step 2' }))
    expect(items.at(-1)).toMatchObject({ kind: 'comment' })
  })

  it.each([
    ['a missing merge request', json({ data: { project: { id: PROJECT, mergeRequest: null } } }), json([]),
      { code: 'not-found', message: 'merge request 3 was not found' }],
    ['a missing project', json({ data: { project: null } }), output('', 1, 'glab: 404 Project Not Found (HTTP 404)'),
      { code: 'not-found', message: 'merge request 3 was not found' }],
    ['an unexpected answer', json({ data: { project: { id: PROJECT, mergeRequest: { notes: 1 } } } }), json([]),
      { code: 'unavailable', message: 'unexpected GitLab response to the activity read' }],
    ['a note without a time', notesAnswer([note({ createdAt: 'yesterday' })]), json([]),
      { code: 'unavailable', message: 'unexpected GitLab response to the activity read' }],
    ['a refused note read', output('', 1, 'glab: 502 Bad Gateway (HTTP 502)'), json([]),
      { code: 'unavailable', message: '502 Bad Gateway (HTTP 502)' }],
    ['a refused state change read', notesAnswer([note()]), output('', 1, 'glab: 500 Internal Server Error (HTTP 500)'),
      { code: 'unavailable', message: '500 Internal Server Error (HTTP 500)' }],
    ['an unexpected state change answer', notesAnswer([note()]), json([{ state: 'closed' }]),
      { code: 'unavailable', message: 'unexpected GitLab response to the state change read' }],
  ])('reports %s', async (_label, notes, states, failure) => {
    await expect(readActivity(gitlab(notes, states).subject, merge(3), signal)).resolves.toEqual(failure)
  })

  it('rejects a project path GitLab cannot hold before any request', async () => {
    const { subject, calls } = gitlab(notesAnswer([]))
    await expect(readActivity(subject, merge(6, { ...app, name: 'a b' }), signal))
      .rejects.toThrow('forge-gitlab: invalid project "group/sub/a b"')
    expect(calls).toEqual([])
  })
})

describe('GitLab activity commit names', () => {
  it('gives an entry the full name of the one listed commit its abbreviation starts, and leaves every other entry', () => {
    const listed = (sha: string): ForgeCommit => ({ sha, parent: null, title: 'T', author: null, authoredAt: 'D' })
    const commit = (sha: string): ChangeRequestActivityItem => ({ at: 'D', actor: null, kind: 'commit', sha, title: 'T' })
    const closed: ChangeRequestActivityItem = { at: 'D', actor: null, kind: 'closed' }
    const commits = [listed('1a2b3c4d'.padEnd(40, '0')), listed('5e6f0000'.padEnd(40, '1')), listed('5e6f0000'.padEnd(40, '2'))]
    expect(withListedCommitNames([commit('1a2b3c4d'), closed, commit('5e6f0000'), commit('77777777')], commits)).toEqual([
      commit('1a2b3c4d'.padEnd(40, '0')), closed,
      // Two listed commits start with the abbreviation, and none starts with the last one.
      commit('5e6f0000'), commit('77777777'),
    ])
  })
})

describe('GitLab notes as activity entries', () => {
  it('counts the diff comments one author wrote in a row as one review, leaving out the system notes of diff threads', () => {
    const entries = noteEntries(HOST, PROJECT, [
      note({ position: onDiff, url: page(1) }),
      note({ position: onDiff, url: page(2), createdAt: '2026-11-08T12:00:05+08:00' }),
      note({ position: onDiff, url: page(3), author: zhou }),
      note({ position: onDiff, url: page(4) }),
      system('outdated', 'changed this line in [version 2 of the diff](/group/sub/app/-/merge_requests/6/diffs)', { position: onDiff }),
      note({ position: onDiff, url: page(6) }),
      note({ body: 'Two questions above.', url: page(7) }),
      note({ position: onDiff, url: page(8), author: null }),
      note({ position: onDiff, url: page(9), author: null }),
    ])
    const review = (comments: number, url: string): Detail => ({ kind: 'review', verdict: 'commented', body: '', comments, url })
    expect(entries).toEqual([
      entry(review(2, page(1))), entry(review(1, page(3)), zhou), entry(review(1, page(4))), entry(review(1, page(6))),
      entry({ kind: 'comment', body: 'Two questions above.', url: page(7) }), entry(review(2, page(8)), null),
    ])
  })

  it.each<[string, string | null, string, Detail[]]>([
    ['an approval', 'approved', 'approved this merge request',
      [{ kind: 'review', verdict: 'approved', body: '', comments: 0, url: page(1) }]],
    ['a change request', 'requested_changes', 'requested changes',
      [{ kind: 'review', verdict: 'changes-requested', body: '', comments: 0, url: page(1) }]],
    ['a review without a decision', 'reviewed', 'left review comments',
      [{ kind: 'review', verdict: 'commented', body: '', comments: 0, url: page(1) }]],
    ['review requests', 'reviewer', 'requested review from @lin, @zhou.yu, and @wang-',
      [{ kind: 'review-requested', reviewer: 'lin' }, { kind: 'review-requested', reviewer: 'zhou.yu' },
        { kind: 'review-requested', reviewer: 'wang-' }]],
    ['a review request beside a withdrawn one', 'reviewer', 'requested review from @l and removed review request for @zhou',
      [{ kind: 'review-requested', reviewer: 'l' }, { kind: 'other', text: 'removed review request for @zhou' }]],
    ['a withdrawn review request', 'reviewer', 'removed review request for @zhou',
      [{ kind: 'other', text: 'removed review request for @zhou' }]],
    ['a review request in the language of the user who asked again', 'reviewer', '请求审核 @lin',
      [{ kind: 'review-requested', reviewer: 'lin' }]],
    ['a reviewer note that names no account', 'reviewer', 'changed the reviewers', [{ kind: 'other', text: 'changed the reviewers' }]],
    ['a cleared draft mark', 'title', 'marked this merge request as **ready**', [{ kind: 'ready-for-review' }]],
    ['a draft mark', 'title', 'marked this merge request as **draft**', [{ kind: 'converted-to-draft' }]],
    ['a title change written as HTML', 'title',
      '<p>changed title from <code class="idiff">Draft: <span class="idiff left right deletion">Add</span> parser &amp; lexer</code>'
      + ' to <code class="idiff">Draft: <span class="idiff left right addition">Split the</span> parser &amp; lexer</code></p>',
      [{ kind: 'renamed', from: 'Draft: Add parser & lexer', to: 'Draft: Split the parser & lexer' }]],
    ['a title change written as Markdown', 'title', 'changed title from **{-Add-} parser** to **{+Split the+} parser{+ and lexer+}**',
      [{ kind: 'renamed', from: 'Add parser', to: 'Split the parser and lexer' }]],
    ['a title note in other words', 'title', 'marked this merge request as **blocked**',
      [{ kind: 'other', text: 'marked this merge request as blocked' }]],
    ['added commits', 'commit',
      'added 15 commits\n\n<ul><li>1a2b3c4d - 1 commit from branch <code>main</code></li><li>2b3c4d5e...3c4d5e6f - 12 earlier commits</li>'
      + '<li>4d5e6f7a - fix: don&#39;t drop &lt;T&gt; &amp; &quot;U&quot;</li><li>5e6f7a8b - test: cover it</li></ul>\n\n'
      + `[Compare with previous version](/group/sub/app/-/merge_requests/6/diffs?diff_id=9&start_sha=${sha('b')})`,
      [
        { kind: 'other', text: '1a2b3c4d - 1 commit from branch main' },
        { kind: 'other', text: '2b3c4d5e...3c4d5e6f - 12 earlier commits' },
        { kind: 'commit', sha: '4d5e6f7a', title: 'fix: don\'t drop <T> & "U"' },
        { kind: 'commit', sha: '5e6f7a8b', title: 'test: cover it' },
      ]],
    ['a commit note without a list', 'commit',
      'added 2 commits\n\n[Compare with previous version](/group/sub/app/-/merge_requests/6/diffs)',
      [{ kind: 'other', text: 'added 2 commits Compare with previous version' }]],
    ['an enabled automatic merge', 'merge', `enabled an automatic merge when all merge checks for ${sha('a')} pass`,
      [{ kind: 'auto-merge-enabled' }]],
    ['a cancelled automatic merge', 'merge', 'canceled the automatic merge', [{ kind: 'auto-merge-disabled' }]],
    ['an aborted automatic merge', 'merge',
      'aborted the automatic merge because the source branch was updated. [Learn more](https://gitlab.example.test/help/merge).',
      [{ kind: 'auto-merge-disabled' }]],
    ['another note about merging', 'merge', 'started a merge train', [{ kind: 'other', text: 'started a merge train' }]],
    ['an action without a kind of its own', 'branch', 'changed target branch from `main` to `release/2`',
      [{ kind: 'other', text: 'changed target branch from main to release/2' }]],
    ['a sentence with Markdown', 'task', 'marked the checklist item **Add the [guide](https://example.test/guide)** as completed',
      [{ kind: 'other', text: 'marked the checklist item Add the guide as completed' }]],
    ['a sentence with HTML', 'pinned_embed',
      '<p>moved the <code>cache</code> setting</p>\n\n<ul><li>first</li><li>second &amp; last</li></ul>',
      [{ kind: 'other', text: 'moved the cache setting first second & last' }]],
    ['a system note without an action', null, 'changed the description', [{ kind: 'other', text: 'changed the description' }]],
  ])('maps %s', (_label, action, body, details) => {
    expect(noteEntries(HOST, PROJECT, [system(action, body)])).toEqual(details.map(detail => entry(detail)))
  })

  it('maps a system note whose metadata names no action as a record in GitLab\'s words', () => {
    expect(noteEntries(HOST, PROJECT, [note({ system: true, body: 'resolved all threads', systemNoteMetadata: { action: null } })]))
      .toEqual([entry({ kind: 'other', text: 'resolved all threads' })])
  })
})
