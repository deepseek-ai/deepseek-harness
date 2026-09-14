import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { api, graphql, initializeIssueStartDate, issueSnapshot } from './github.mjs'
import { auditIssue, initializePullRequestStartDates, repairIssueLabels, runLifecycle } from './lifecycle.mjs'
import {
  lifecyclePullRequestSnapshot,
  pullRequestSnapshot,
  runPullRequestCheck,
  runPullRequestPreflight,
} from './pull-request.mjs'
import {
  nextResolvingIssueStatus,
  parseReferences,
  projectDate,
  retainIssueReferences,
  resolvingIssueStatusCommand,
  requiresPullRequestPolicy,
  validateIssue,
  validatePullRequest,
} from './rules.mjs'

const projectGraphqlData = ({
  projectItem = true,
  priority = null,
  priorityField = true,
  priorityType = 'SINGLE_SELECT',
  priorityIsIssueField = false,
  startDate = null,
  startDateField = true,
  startDateType = 'DATE',
  startDateIsIssueField = false,
} = {}) => ({
  organization: {
    projectV2: {
      id: 'project-id',
      title: 'DSH Issue Management',
      fields: {
        nodes: [
          {
            id: 'status-field-id',
            name: 'Status',
            dataType: 'SINGLE_SELECT',
            isIssueField: false,
            options: [],
          },
          ...(priorityField
            ? [
                {
                  id: 'priority-project-field-id',
                  name: 'Priority',
                  dataType: priorityType,
                  isIssueField: priorityIsIssueField,
                  options: [],
                },
              ]
            : []),
          ...(startDateField
            ? [
                {
                  id: 'start-date-field-id',
                  name: 'Start Date',
                  dataType: startDateType,
                  isIssueField: startDateIsIssueField,
                },
              ]
            : []),
        ],
      },
    },
  },
  repository: {
    issue: {
      id: 'issue-id',
      projectItems: {
        nodes: projectItem
          ? [
              {
                id: 'item-id',
                project: { id: 'project-id' },
                fieldValueByName: { name: 'Inbox', optionId: 'inbox-option-id' },
                priorityValue:
                  priority === null ? null : { name: priority, optionId: `${priority}-option-id` },
                startDateValue: startDate === null ? null : { date: startDate },
              },
            ]
          : [],
      },
    },
  },
})

const mockGraphql = (t, resolve) => {
  const requests = []
  const previousToken = process.env.GH_TOKEN
  process.env.GH_TOKEN = 'test-token'
  t.after(() => {
    if (previousToken === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = previousToken
  })
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.github.com/graphql')
    assert.equal(options.headers.Authorization, 'Bearer test-token')
    const request = JSON.parse(options.body)
    requests.push(request)
    return Response.json({ data: resolve(request, requests.length - 1) })
  })
  return requests
}

const legalIssue = {
  labels: [],
  type: 'Idea',
  priority: null,
  status: 'In review',
  state: 'open',
  stateReason: null,
}

const canonicalKinds = [
  'kind/feature',
  'kind/bug-fix',
  'kind/doc',
  'kind/testing',
  'kind/cleanup',
  'kind/dependency',
]

// Keep an independent oracle rather than importing the implementation's reserved set.
const legacyLabels = [
  'kind/bug',
  'kind/documentation',
  'feature',
  'bug-fix',
  'doc',
  'cleanup',
  'testing',
  'dependencies',
  'ci',
  'cli',
  'llm',
  'web-search',
]

const reviewedPull = (labels) => ({
  isDraft: false,
  authorType: 'User',
  reviewRequestCount: 1,
  reviewCount: 0,
  labels,
  references: { all: [2], resolving: [], related: [2] },
  issues: new Map([[2, { priority: null }]]),
})

test('keeps only Bug, Feature, and Task Issue templates with used frontmatter', () => {
  const directory = new URL('../ISSUE_TEMPLATE/', import.meta.url)
  assert.deepEqual(readdirSync(directory).sort(), ['bug.md', 'config.yml', 'feature.md', 'task.md'])

  for (const file of ['bug.md', 'feature.md', 'task.md']) {
    const source = readFileSync(new URL(file, directory), 'utf8')
    const frontmatter = source.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? ''
    const keys = frontmatter
      .split('\n')
      .filter(Boolean)
      .map((line) => line.slice(0, line.indexOf(':')))
      .sort()
    assert.deepEqual(keys, ['about', 'name', 'type'], file)
    assert.match(source, /^## /m, file)
    assert.match(source, /<!-- [^\n]+ -->/, file)
    assert.doesNotMatch(source, /<details\b/i, file)
  }
  assert.equal(
    readFileSync(new URL('config.yml', directory), 'utf8'),
    'blank_issues_enabled: false\n',
  )
})

test('keeps Feature Issues limited to motivation and behavior', () => {
  const source = readFileSync(
    new URL('../ISSUE_TEMPLATE/feature.md', import.meta.url),
    'utf8',
  )
  assert.deepEqual(
    [...source.matchAll(/^## .+$/gm)].map(([heading]) => heading),
    ['## Motivation', '## Behavior'],
  )
})

test('keeps Bug Issues limited to the problem report', () => {
  const source = readFileSync(new URL('../ISSUE_TEMPLATE/bug.md', import.meta.url), 'utf8')
  assert.deepEqual(
    [...source.matchAll(/^## .+$/gm)].map(([heading]) => heading),
    ['## Summary', '## Reproduction', '## Current behavior', '## Expected behavior', '## Environment'],
  )
})

test('keeps Task Issues limited to summary and deliverables', () => {
  const source = readFileSync(new URL('../ISSUE_TEMPLATE/task.md', import.meta.url), 'utf8')
  assert.deepEqual(
    [...source.matchAll(/^## .+$/gm)].map(([heading]) => heading),
    ['## Summary', '## Deliverables'],
  )
})

test('structures the pull request template around motivation, changes, and testing', () => {
  const source = readFileSync(new URL('../pull_request_template.md', import.meta.url), 'utf8')
  for (const heading of ['## Motivation', '## Changes', '## Testing']) {
    assert.match(source, new RegExp(`^${heading.replaceAll('#', '\\#')}$`, 'm'))
  }
  assert.doesNotMatch(source, /^### /m)
  assert.match(
    source,
    /<!-- 高层次说明命令[^\n]+ -->\n<!-- 高层次说明用户[^\n]+ -->/,
  )
  assert.match(source, /- <!-- [^\n]+ -->\n\n  <details>\n  <summary>Proof<\/summary>/)
  assert.equal(source.match(/<details>/g)?.length, 1)
  assert.equal(source.match(/<\/details>/g)?.length, 1)
})

test('ignores Issue title, body presentation, and assignee ownership', () => {
  assert.deepEqual(
    validateIssue({
      ...legalIssue,
      title: '[Bug] English title',
      body: `Owner: @octocat\n\n${'visible '.repeat(60)}<details open>unclosed`,
      assignees: ['octocat', 'hubot'],
    }),
    [],
  )
})

test('allows optional metadata in every open Status', () => {
  assert.deepEqual(validateIssue(legalIssue), [])
  for (const status of ['Inbox', 'Backlog', 'Ready', 'In progress', 'In review']) {
    assert.deepEqual(validateIssue({ ...legalIssue, status }), [])
  }
})

test('reserves PR kind and legacy labels for pull requests', () => {
  for (const label of [
    ...canonicalKinds,
    'kind/experimental',
    ...legacyLabels,
  ]) {
    assert.ok(
      validateIssue({ ...legalIssue, labels: [label] }).some((error) =>
        error.startsWith('Issue 不得使用 PR kind 或旧版标签：'),
      ),
      label,
    )
  }
  assert.deepEqual(validateIssue({ ...legalIssue, labels: ['area/web', 'source/member'] }), [])
})

test('removes reserved labels from Issues before validation', async (t) => {
  const previousToken = process.env.GH_TOKEN
  process.env.GH_TOKEN = 'test-token'
  t.after(() => {
    if (previousToken === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = previousToken
  })
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, method: options.method })
    assert.equal(options.headers.Authorization, 'Bearer test-token')
    if (url.endsWith('/labels/bug-fix')) {
      return Response.json({ message: 'Label does not exist' }, { status: 404 })
    }
    return Response.json([])
  })

  const issue = {
    ...legalIssue,
    number: 42,
    labels: ['area/web', 'kind/bug-fix', 'bug-fix', 'source/member'],
  }
  const repaired = await repairIssueLabels(issue)

  assert.deepEqual(repaired.labels, ['area/web', 'source/member'])
  assert.deepEqual(issue.labels, ['area/web', 'kind/bug-fix', 'bug-fix', 'source/member'])
  assert.deepEqual(validateIssue(repaired), [])
  assert.deepEqual(requests, [
    {
      url: 'https://api.github.com/repos/deepseek-harness/deepseek-harness/issues/42/labels/kind%2Fbug-fix',
      method: 'DELETE',
    },
    {
      url: 'https://api.github.com/repos/deepseek-harness/deepseek-harness/issues/42/labels/bug-fix',
      method: 'DELETE',
    },
  ])
})

test('deletes a stale audit comment after repairing its only violation', async (t) => {
  const previousToken = process.env.GH_TOKEN
  process.env.GH_TOKEN = 'test-token'
  t.after(() => {
    if (previousToken === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = previousToken
  })
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, method: options.method ?? 'GET' })
    if (url.endsWith('/issues/42')) {
      return Response.json({
        node_id: 'issue-id',
        labels: [{ name: 'area/web' }, { name: 'kind/bug-fix' }],
        type: { name: 'Bug' },
        state: 'open',
        state_reason: null,
      })
    }
    if (url.endsWith('/graphql')) return Response.json({ data: projectGraphqlData() })
    if (url.endsWith('/labels/kind%2Fbug-fix')) return Response.json([{ name: 'area/web' }])
    if (url.endsWith('/issues/42/comments?per_page=100')) {
      return Response.json([
        {
          id: 99,
          user: { type: 'Bot' },
          body: '<!-- dsh-issue-policy -->\nold audit',
        },
      ])
    }
    if (url.endsWith('/issues/comments/99')) return new Response(null, { status: 204 })
    return Response.json({ message: 'unexpected request' }, { status: 500 })
  })

  assert.deepEqual(await auditIssue(42), [])
  assert.deepEqual(
    requests.map(({ url, method }) => ({ path: new URL(url).pathname + new URL(url).search, method })),
    [
      { path: '/repos/deepseek-harness/deepseek-harness/issues/42', method: 'GET' },
      { path: '/graphql', method: 'POST' },
      {
        path: '/repos/deepseek-harness/deepseek-harness/issues/42/labels/kind%2Fbug-fix',
        method: 'DELETE',
      },
      {
        path: '/repos/deepseek-harness/deepseek-harness/issues/42/comments?per_page=100',
        method: 'GET',
      },
      {
        path: '/repos/deepseek-harness/deepseek-harness/issues/comments/99',
        method: 'DELETE',
      },
    ],
  )
})

test('keeps terminal Status aligned with the native close reason', () => {
  assert.deepEqual(
    validateIssue({ ...legalIssue, status: 'Done', state: 'closed', stateReason: 'completed' }),
    [],
  )
  assert.deepEqual(
    validateIssue({
      ...legalIssue,
      status: 'No action',
      state: 'closed',
      stateReason: 'not_planned',
    }),
    [],
  )
  assert.ok(validateIssue({ ...legalIssue, status: 'Done' }).includes('Done 必须对应 Completed 关闭原因'))
})

test('separates resolving and informational references', () => {
  assert.deepEqual(
    parseReferences({
      body: 'Fixes #12\nRelated to #4\nRefs deepseekharness/dsh-test#7',
      repository: 'deepseekharness/dsh-test',
    }),
    { all: [4, 7, 12], resolving: [12], related: [4, 7] },
  )
})

test('converts PR creation timestamps to Shanghai Project dates', () => {
  assert.equal(projectDate('2026-08-27T15:59:59Z', 'Asia/Shanghai'), '2026-08-27')
  assert.equal(projectDate('2026-08-27T16:00:00Z', 'Asia/Shanghai'), '2026-08-28')
  assert.throws(() => projectDate('invalid', 'Asia/Shanghai'), /无效的 PR 创建时间/)
})

test('initializes every referenced Issue only for a PR opened event', async () => {
  const writes = []
  const pull = {
    createdAt: '2026-08-27T16:00:00Z',
    references: { all: [4, 7, 12] },
  }
  const initialize = async (number, date) => writes.push({ number, date })

  await initializePullRequestStartDates(pull, 'opened', initialize)
  assert.deepEqual(writes, [
    { number: 4, date: '2026-08-28' },
    { number: 7, date: '2026-08-28' },
    { number: 12, date: '2026-08-28' },
  ])

  for (const action of ['edited', 'synchronize', 'reopened']) {
    await initializePullRequestStartDates(pull, action, initialize)
  }
  assert.equal(writes.length, 3)
})

test('reads Priority and Status from Project custom fields', async (t) => {
  const previousGhToken = process.env.GH_TOKEN
  const previousGithubToken = process.env.GITHUB_TOKEN
  const previousProjectToken = process.env.PROJECT_TOKEN
  delete process.env.GH_TOKEN
  process.env.GITHUB_TOKEN = 'repository-token'
  process.env.PROJECT_TOKEN = 'project-token'
  t.after(() => {
    if (previousGhToken === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = previousGhToken
    if (previousGithubToken === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = previousGithubToken
    if (previousProjectToken === undefined) delete process.env.PROJECT_TOKEN
    else process.env.PROJECT_TOKEN = previousProjectToken
  })
  const urls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    urls.push(url)
    if (url.endsWith('/issues/42')) {
      assert.equal(options.headers.Authorization, 'Bearer repository-token')
      return Response.json({
        node_id: 'issue-id',
        title: 'Project metadata',
        body: null,
        assignees: [],
        labels: [],
        type: { name: 'Task' },
        state: 'open',
        state_reason: null,
      })
    }
    assert.equal(url, 'https://api.github.com/graphql')
    assert.equal(options.headers.Authorization, 'Bearer project-token')
    return Response.json({ data: projectGraphqlData({ priority: 'P1' }) })
  })

  const issue = await issueSnapshot(42)

  assert.equal(issue.priority, 'P1')
  assert.equal(issue.status, 'Inbox')
  assert.deepEqual(urls, [
    'https://api.github.com/repos/deepseek-harness/deepseek-harness/issues/42',
    'https://api.github.com/graphql',
  ])
})

test('writes an empty Project Start Date with the configured field', async (t) => {
  const requests = mockGraphql(t, (request) => {
    if (request.query.includes('query(')) return projectGraphqlData()
    return { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item-id' } } }
  })

  await initializeIssueStartDate(42, '2026-08-28')

  assert.equal(requests.length, 2)
  assert.match(requests[0].query, /isIssueField/)
  assert.doesNotMatch(requests[0].query, /issueField\s*\{/)
  assert.match(requests[0].query, /priorityValue: fieldValueByName/)
  assert.equal(requests[0].variables.priorityField, 'Priority')
  assert.match(requests[0].query, /ProjectV2ItemFieldDateValue/)
  assert.match(requests[1].query, /updateProjectV2ItemFieldValue/)
  assert.match(requests[1].query, /value: \{date: \$date\}/)
  assert.deepEqual(requests[1].variables, {
    projectId: 'project-id',
    itemId: 'item-id',
    fieldId: 'start-date-field-id',
    date: '2026-08-28',
  })
})

test('preserves an existing Project Start Date', async (t) => {
  const requests = mockGraphql(t, () => projectGraphqlData({ startDate: '2026-08-01' }))

  await initializeIssueStartDate(42, '2026-08-28')

  assert.equal(requests.length, 1)
})

test('adds a referenced Issue to the Project before setting Start Date', async (t) => {
  const requests = mockGraphql(t, (request) => {
    if (request.query.includes('query(')) return projectGraphqlData({ projectItem: false })
    if (request.query.includes('addProjectV2ItemById')) {
      return { addProjectV2ItemById: { item: { id: 'new-item-id' } } }
    }
    return { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'new-item-id' } } }
  })

  await initializeIssueStartDate(42, '2026-08-28')

  assert.equal(requests.length, 3)
  assert.deepEqual(requests[1].variables, { projectId: 'project-id', contentId: 'issue-id' })
  assert.deepEqual(requests[2].variables, {
    projectId: 'project-id',
    itemId: 'new-item-id',
    fieldId: 'start-date-field-id',
    date: '2026-08-28',
  })
})

test('rejects a missing, non-Date, or Issue-level Start Date field', async (t) => {
  let response = projectGraphqlData({ startDateField: false })
  const requests = mockGraphql(t, () => response)

  await assert.rejects(initializeIssueStartDate(42, '2026-08-28'), /Project 缺少 Start Date 字段/)
  response = projectGraphqlData({ startDateType: 'TEXT' })
  await assert.rejects(initializeIssueStartDate(42, '2026-08-28'), /Start Date 字段必须为 Date/)
  response = projectGraphqlData({ startDateIsIssueField: true })
  await assert.rejects(
    initializeIssueStartDate(42, '2026-08-28'),
    /Start Date 字段必须为 Project Date 字段/,
  )
  assert.equal(requests.length, 3)
})

test('rejects a missing, non-select, or Issue-level Priority field', async (t) => {
  let response = projectGraphqlData({ priorityField: false })
  const requests = mockGraphql(t, () => response)

  await assert.rejects(initializeIssueStartDate(42, '2026-08-28'), /Project 缺少 Priority 字段/)
  response = projectGraphqlData({ priorityType: 'TEXT' })
  await assert.rejects(
    initializeIssueStartDate(42, '2026-08-28'),
    /Priority 字段必须为 Single Select/,
  )
  response = projectGraphqlData({ priorityIsIssueField: true })
  await assert.rejects(
    initializeIssueStartDate(42, '2026-08-28'),
    /Priority 字段必须为 Project custom field/,
  )
  assert.equal(requests.length, 3)
})

test('does not treat pull request references as Issue associations', () => {
  const references = {
    all: [123, 1180, 1181],
    resolving: [123, 1180],
    related: [1181],
  }
  const issues = new Map([
    [1180, {}],
    [1181, {}],
  ])

  assert.deepEqual(retainIssueReferences(references, issues), {
    all: [1180, 1181],
    resolving: [1180],
    related: [1181],
  })
})

test('allows informational references without cross-object constraints', () => {
  const errors = validatePullRequest({
    isDraft: false,
    authorType: 'User',
    reviewRequestCount: 1,
    reviewCount: 0,
    labels: ['kind/cleanup', 'area/infra'],
    references: { all: [4], resolving: [], related: [4] },
    issues: new Map([[4, { type: 'Bug', priority: 'P0', labels: ['area/web'] }]]),
  })
  assert.deepEqual(errors, [])
})

test('enforces highest resolving Priority without Type or area synchronization', () => {
  const pull = {
    isDraft: false,
    authorType: 'User',
    reviewRequestCount: 0,
    reviewCount: 1,
    labels: ['kind/cleanup', 'p0', 'area/web'],
    references: { all: [2, 3], resolving: [2, 3], related: [] },
    issues: new Map([
      [2, { type: 'Feature', priority: 'P2', labels: ['area/web'] }],
      [3, { type: 'Bug', priority: 'P0', labels: ['area/session'] }],
    ]),
  }
  assert.deepEqual(validatePullRequest(pull), [])
  assert.ok(
    validatePullRequest({ ...pull, labels: ['kind/cleanup', 'p2', 'area/web'] }).includes(
      'PR Priority 应为 p0',
    ),
  )
})

test('requires policy only after a human PR enters review', () => {
  assert.equal(
    requiresPullRequestPolicy({
      isDraft: false,
      authorType: 'User',
      reviewRequestCount: 1,
      reviewCount: 0,
    }),
    true,
  )
  assert.equal(
    requiresPullRequestPolicy({
      isDraft: false,
      authorType: 'User',
      reviewRequestCount: 0,
      reviewCount: 0,
    }),
    false,
  )
})

test('maps only explicit review handoffs to review status commands', () => {
  assert.equal(
    resolvingIssueStatusCommand('pull_request', {
      action: 'review_requested',
    }),
    'review-requested',
  )
  assert.equal(
    resolvingIssueStatusCommand('pull_request_review', {
      action: 'submitted',
      review: { state: 'changes_requested' },
    }),
    'changes-requested',
  )
  for (const state of ['approved', 'commented']) {
    assert.equal(
      resolvingIssueStatusCommand('pull_request_review', {
        action: 'submitted',
        review: { state },
      }),
      null,
    )
  }
  assert.equal(
    resolvingIssueStatusCommand('pull_request_review', {
      action: 'dismissed',
      review: { state: 'changes_requested' },
    }),
    null,
  )
})

test('keeps PR opening, reopening, and body edits as implementation signals', () => {
  for (const action of ['opened', 'reopened']) {
    assert.equal(resolvingIssueStatusCommand('pull_request', { action }), 'implementation')
  }
  assert.equal(
    resolvingIssueStatusCommand('pull_request', { action: 'edited', changes: { body: { from: '' } } }),
    'implementation',
  )
  for (const action of ['synchronize', 'labeled', 'unlabeled', 'edited']) {
    assert.equal(resolvingIssueStatusCommand('pull_request', { action }), null)
  }
  assert.equal(
    resolvingIssueStatusCommand('pull_request', { action: 'edited', changes: { title: { from: '' } } }),
    null,
  )
  assert.equal(
    resolvingIssueStatusCommand('pull_request', { action: 'review_request_removed' }),
    null,
  )
})

test('toggles automation-owned work on request changes and repeated review request', () => {
  for (const status of ['Inbox', 'Backlog', 'Ready']) {
    assert.equal(nextResolvingIssueStatus(status, 'implementation'), 'In progress')
    assert.equal(nextResolvingIssueStatus(status, 'review-requested'), 'In review')
    assert.equal(nextResolvingIssueStatus(status, 'changes-requested'), 'In progress')
  }
  let status = nextResolvingIssueStatus(
    'In review',
    'changes-requested',
    'dsh-issue-management',
  )
  assert.equal(status, 'In progress')
  status = nextResolvingIssueStatus(status, 'review-requested')
  assert.equal(status, 'In review')
})

test('preserves human review status and terminal Issues', () => {
  assert.equal(nextResolvingIssueStatus('In progress', 'implementation'), null)
  assert.equal(nextResolvingIssueStatus('In review', 'implementation'), null)
  assert.equal(nextResolvingIssueStatus('In review', 'review-requested'), null)
  assert.equal(nextResolvingIssueStatus('In review', 'changes-requested', 'tianyicui'), null)
  assert.equal(nextResolvingIssueStatus('In review', 'changes-requested'), null)
  assert.equal(nextResolvingIssueStatus('Done', 'review-requested'), null)
  assert.equal(nextResolvingIssueStatus('No action', 'changes-requested'), null)
  assert.equal(nextResolvingIssueStatus(null, 'review-requested'), null)
})

test('keeps lifecycle projection independent of PR metadata enforcement', () => {
  const pull = {
    isDraft: false,
    authorType: 'User',
    reviewRequestCount: 1,
    reviewCount: 0,
    labels: [],
    references: { all: [2], resolving: [2], related: [] },
    issues: new Map([[2, { priority: null }]]),
  }

  assert.ok(validatePullRequest(pull).length > 0)
  assert.equal(nextResolvingIssueStatus('Inbox', 'review-requested'), 'In review')
})

test('exempts Draft, Bot, and App PRs', () => {
  const invalid = {
    isDraft: false,
    labels: [],
    references: { all: [], resolving: [], related: [] },
    issues: new Map(),
    reviewRequestCount: 1,
    reviewCount: 0,
  }
  assert.deepEqual(validatePullRequest({ ...invalid, authorType: 'Bot' }), [])
  assert.deepEqual(validatePullRequest({ ...invalid, authorType: 'App' }), [])
  assert.deepEqual(validatePullRequest({ ...invalid, authorType: 'User', isDraft: true }), [])
  assert.ok(validatePullRequest({ ...invalid, authorType: 'User' }).length > 0)
})

test('requires repository PR labels in the enforcement scope', () => {
  const errors = validatePullRequest({
    isDraft: false,
    authorType: 'User',
    reviewRequestCount: 1,
    reviewCount: 0,
    labels: [],
    references: { all: [2], resolving: [], related: [2] },
    issues: new Map([[2, { priority: null }]]),
  })
  assert.ok(errors.includes('PR 必须恰好有一个允许的 kind/*，当前为 0'))
  assert.ok(errors.includes('PR 必须至少有一个 area/*'))
})

test('accepts exactly the canonical kinds with extensible areas', () => {
  for (const kind of canonicalKinds) {
    assert.deepEqual(validatePullRequest(reviewedPull([kind, 'area/future-domain'])), [], kind)
  }
})

test('rejects multiple, unknown, legacy, and Issue-source PR labels', () => {
  assert.ok(
    validatePullRequest(
      reviewedPull(['kind/feature', 'kind/doc', 'area/web']),
    ).includes('PR 必须恰好有一个允许的 kind/*，当前为 2'),
  )
  assert.ok(
    validatePullRequest(reviewedPull(['kind/experimental', 'area/web'])).includes(
      'PR 含不支持的 kind/*：kind/experimental',
    ),
  )
  for (const label of legacyLabels) {
    assert.ok(
      validatePullRequest(reviewedPull(['kind/feature', 'area/web', label])).some((error) =>
        error.startsWith('PR 含旧版标签：'),
      ),
      label,
    )
  }
  assert.ok(
    validatePullRequest(
      reviewedPull(['kind/feature', 'area/web', 'source/internal-pr']),
    ).includes('source/* 仅用于 Issue：source/internal-pr'),
  )
})

const mockPolicyApi = (t, { pull = {}, requested = true, reviews = [], issues = {}, priority = 'P1', projectError = false } = {}) => {
  const environment = ['GH_TOKEN', 'GITHUB_TOKEN', 'PROJECT_TOKEN', 'GITHUB_API_URL', 'GITHUB_OUTPUT']
  const previous = new Map(environment.map((key) => [key, process.env[key]]))
  const directory = mkdtempSync(join(tmpdir(), 'dsh-policy-'))
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(directory, { recursive: true, force: true })
  })
  for (const key of environment) delete process.env[key]
  process.env.GITHUB_TOKEN = 'repository-token'
  process.env.GITHUB_OUTPUT = join(directory, 'output')
  const requests = []
  const output = []
  t.mock.method(process.stdout, 'write', (text) => { output.push(text); return true })
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const path = new URL(url).pathname + new URL(url).search
    requests.push(path)
    if (path.endsWith('/pulls/10')) return Response.json({
      draft: false, user: { type: 'User' }, body: 'Refs #2',
      labels: [{ name: 'kind/cleanup' }, { name: 'area/infra' }], ...pull,
    })
    if (path.endsWith('/requested_reviewers')) {
      return Response.json({ users: requested ? [{}] : [], teams: [] })
    }
    if (path.endsWith('/reviews?per_page=100')) return Response.json(reviews)
    if (path === '/graphql') {
      assert.equal(options.headers.Authorization, 'Bearer repository-token')
      if (projectError) return Response.json({ errors: [{ message: 'Project access denied' }] })
      return Response.json({ data: projectGraphqlData({ priority }) })
    }
    const number = Number(path.match(/\/issues\/(\d+)$/)?.[1])
    assert.ok(Object.hasOwn(issues, number), 'Unexpected request: ' + path)
    const issue = issues[number]
    return Response.json(issue ?? { message: 'Not Found' }, { status: issue === null ? 404 : 200 })
  })
  return { requests, output, workflowOutput: () => readFileSync(process.env.GITHUB_OUTPUT, 'utf8') }
}

for (const [name, pull, requested, count] of [
  ['draft', { draft: true }, true, 1],
  ['Bot', { user: { type: 'Bot' } }, true, 1],
  ['App', { user: { type: 'App' } }, true, 1],
  ['not reviewed', {}, false, 3],
]) {
  test('reads no Issue or Project for a currently exempt ' + name + ' PR', async (t) => {
    const fixture = mockPolicyApi(t, { pull: { body: 'Fixes #999', ...pull }, requested })
    const event = { pull_request: { number: 10, draft: false, user: { type: 'User' } } }
    assert.deepEqual(await runPullRequestPreflight(event), { eligible: false, needsProject: false })
    assert.equal(fixture.requests.length, count)
    assert.equal(fixture.workflowOutput(), 'eligible=false\nexempt=true\nneeds-project=false\n')
    await runPullRequestCheck(event)
    assert.equal(fixture.requests.length, count * 2)
    assert.ok(fixture.output.every((text) => text.includes('Issue policy exempt')))
  })
}

test('validates informational Issues and ignores PR numbers without Project reads', async (t) => {
  const fixture = mockPolicyApi(t, { pull: { body: 'Refs #2; Fixes #3' }, issues: { 2: {}, 3: { pull_request: {} } } })
  const event = { pull_request: { number: 10, draft: true, body: 'Fixes #999' } }
  assert.deepEqual(await runPullRequestPreflight(event), { eligible: true, needsProject: false })
  assert.equal(fixture.requests.length, 5)
  assert.equal(fixture.workflowOutput(), 'eligible=true\nexempt=false\nneeds-project=false\n')
  await runPullRequestCheck(event)
  assert.equal(fixture.requests.length, 10)
  assert.ok(!fixture.requests.includes('/graphql'))
})

test('requires a real Issue and explains why stacked PR references do not qualify', async (t) => {
  const fixture = mockPolicyApi(t, { pull: { body: 'Fixes #3' }, issues: { 3: { pull_request: {} } } })
  await assert.rejects(runPullRequestCheck({ pull_request: { number: 10 } }), /Issue policy 未通过/)
  assert.equal(fixture.requests.length, 4)
  assert.match(fixture.output.join(''), /PR 编号（包括堆叠依赖 PR）不算 Issue 引用/)
})

test('fetches Project Priority only for resolving Issues and enforces mismatch', async (t) => {
  const fixture = mockPolicyApi(t, { pull: { body: 'Fixes #2; Refs #4; Fixes #3' }, issues: { 2: {}, 4: {}, 3: { pull_request: {} } } })
  const event = { pull_request: { number: 10 } }
  assert.deepEqual(await runPullRequestPreflight(event), { eligible: true, needsProject: true })
  assert.equal(fixture.requests.length, 6)
  assert.equal(fixture.workflowOutput(), 'eligible=true\nexempt=false\nneeds-project=true\n')
  assert.ok(!fixture.requests.includes('/graphql'))
  await assert.rejects(runPullRequestCheck(event), /Issue policy 未通过/)
  assert.equal(fixture.requests.length, 13)
  assert.equal(fixture.requests.filter((path) => path === '/graphql').length, 1)
  assert.match(fixture.output.join(''), /PR Priority 应为 p1/)
})

test('enforces current metadata on title edits and prior reviews without requested reviewers', async (t) => {
  const fixture = mockPolicyApi(t, { requested: false, reviews: [{}], pull: { labels: [] }, issues: { 2: {} } })
  await assert.rejects(runPullRequestCheck({ action: 'edited', changes: { title: { from: 'old' } }, pull_request: { number: 10 } }), /Issue policy 未通过/)
  assert.equal(fixture.requests.length, 4)
  assert.match(fixture.output.join(''), /PR 必须至少有一个 area/)
})

test('fails closed on missing referenced numbers and unavailable Project access', async (t) => {
  const fixture = mockPolicyApi(t, { pull: { body: 'Fixes #2' }, issues: { 2: null } })
  await assert.rejects(runPullRequestPreflight({ pull_request: { number: 10 } }), /404/)
  assert.equal(fixture.requests.length, 4)
})

test('fails closed when current resolving Issues need a Project token preflight did not mint', async (t) => {
  const pull = { draft: true, body: 'Fixes #2' }
  const fixture = mockPolicyApi(t, { pull, issues: { 2: {} }, projectError: true })
  const event = { pull_request: { number: 10 } }
  assert.deepEqual(await runPullRequestPreflight(event), { eligible: false, needsProject: false })
  pull.draft = false
  await assert.rejects(runPullRequestCheck(event), /Project access denied/)
  assert.equal(fixture.requests.length, 6)
})

test('performs no lifecycle requests for removed signals or title-only edits', async (t) => {
  const fixture = mockPolicyApi(t)
  for (const action of ['synchronize', 'labeled', 'unlabeled']) {
    await runLifecycle('pull_request', { action, pull_request: { number: 10 } })
  }
  await runLifecycle('pull_request', { action: 'edited', changes: { title: { from: '' } }, pull_request: { number: 10 } })
  for (const state of ['approved', 'commented']) {
    await runLifecycle('pull_request_review', { action: 'submitted', review: { state }, pull_request: { number: 10 } })
  }
  assert.deepEqual(fixture.requests, [])
})

test('keeps trusted preflight before token minting and required policy unconditional', () => {
  const source = readFileSync(new URL('../workflows/issue-policy.yml', import.meta.url), 'utf8')
  const job = source.slice(source.indexOf('  policy:'))
  assert.ok(job.includes('    name: Issue policy'))
  assert.ok(!job.slice(0, job.indexOf('    steps:')).includes('    if:'))
  assert.ok(source.includes('types: [opened, edited, synchronize, reopened, labeled, unlabeled, ready_for_review, review_requested]'))
  const steps = job.split('      - name: ').slice(1)
  assert.equal(steps.length, 4)
  assert.ok(steps[0].includes('ref: ${{ github.event.repository.default_branch }}'))
  assert.ok(steps[0].includes('persist-credentials: false'))
  assert.doesNotMatch(source, /pull_request\.head|pull_request_target/)
  assert.ok(steps[1].includes('id: preflight'))
  assert.ok(steps[1].includes('GITHUB_TOKEN: ${{ github.token }}'))
  assert.ok(steps[1].includes('node .github/issue-management/policy.mjs pr-preflight'))
  assert.ok(steps[1].includes('if [ -f .github/issue-management/selective-preflight.json ]; then'))
  assert.doesNotMatch(steps[1], /secrets\.|PROJECT_TOKEN|if:/)
  assert.ok(steps[2].includes("if: ${{ steps.preflight.outputs.needs-project == 'true' }}"))
  assert.ok(steps[2].includes('permission-organization-projects: read'))
  assert.ok(steps[3].includes('PROJECT_TOKEN: ${{ steps.app-token.outputs.token }}'))
  assert.ok(steps[3].includes('run: node .github/issue-management/policy.mjs pr'))
  assert.ok(steps[3].includes("if: ${{ steps.preflight.outputs.legacy-automated != 'true' }}"))
})

test('runs trusted rollout selection with absent and present capability markers', { skip: process.platform === 'win32' ? 'The policy workflow executes under hosted Ubuntu bash' : false }, (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-policy-rollout-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const source = readFileSync(new URL('../workflows/issue-policy.yml', import.meta.url), 'utf8')
  const script = source.split('        run: |\n')[1].split('      - name: Create Project read token')[0]
    .split('\n').map((line) => line.slice(10)).join('\n')
  assert.deepEqual(JSON.parse(readFileSync(new URL('./selective-preflight.json', import.meta.url), 'utf8')), { version: 1 })
  const cases = [
    { name: 'legacy human draft', type: 'User', draft: true, marker: false, expected: 'legacy-automated=false\nneeds-project=true\n' },
    { name: 'legacy human ready', type: 'User', draft: false, marker: false, expected: 'legacy-automated=false\nneeds-project=true\n' },
    { name: 'legacy bot', type: 'Bot', marker: false, expected: 'legacy-automated=true\nneeds-project=false\n' },
    { name: 'legacy app', type: 'App', marker: false, expected: 'legacy-automated=true\nneeds-project=false\n' },
    { name: 'modern exempt', type: 'Bot', marker: true, expected: 'exempt=true\nneeds-project=false\n' },
    { name: 'modern failure', type: 'User', marker: true, failure: true, expected: '' },
  ]
  for (const [index, fixture] of cases.entries()) {
    const cwd = join(directory, String(index))
    const policyDirectory = join(cwd, '.github', 'issue-management')
    mkdirSync(policyDirectory, { recursive: true })
    const eventPath = join(cwd, 'event.json')
    const outputPath = join(cwd, 'output')
    writeFileSync(eventPath, JSON.stringify({ pull_request: { user: { type: fixture.type }, draft: fixture.draft } }))
    writeFileSync(outputPath, '')
    if (fixture.marker) writeFileSync(join(policyDirectory, 'selective-preflight.json'), '{"version":1}\n')
    writeFileSync(join(policyDirectory, 'policy.mjs'), fixture.marker && !fixture.failure
      ? "import fs from 'node:fs'; if (process.argv[2] !== 'pr-preflight') throw Error('wrong command'); fs.appendFileSync(process.env.GITHUB_OUTPUT, 'exempt=true\\nneeds-project=false\\n')\n"
      : "throw new Error('preflight unavailable or failed')\n")
    const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
      cwd,
      env: { PATH: process.env.PATH, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath },
      encoding: 'utf8',
      timeout: 30_000,
    })
    assert.equal(result.error, undefined, fixture.name)
    assert.equal(result.signal, null, fixture.name)
    assert.equal(result.status, fixture.failure ? 1 : 0, fixture.name + ': ' + result.stderr)
    assert.equal(readFileSync(outputPath, 'utf8'), fixture.expected, fixture.name)
    if (fixture.marker) assert.doesNotMatch(result.stdout, /preserving legacy/)
    else assert.match(result.stdout, /preserving legacy policy enforcement/)
  }
})

test('allocates lifecycle runners only for relevant reviews and PR body edits', () => {
  const source = readFileSync(new URL('../workflows/issue-lifecycle.yml', import.meta.url), 'utf8')
  const issues = source.split('  issues:')[1].split('  pull_request:')[0]
  const pulls = source.split('  pull_request:')[1].split('  pull_request_review:')[0]
  const actions = (block) => [...block.matchAll(/^      - (\w+)$/gm)].map((match) => match[1])
  assert.deepEqual(actions(issues), ['opened', 'edited', 'labeled', 'unlabeled', 'closed', 'reopened', 'typed', 'untyped', 'field_added', 'field_removed'])
  assert.deepEqual(actions(pulls), ['opened', 'edited', 'reopened', 'review_requested'])
  const job = source.slice(source.indexOf('  lifecycle:'))
  const beforeSteps = job.slice(0, job.indexOf('    steps:'))
  assert.ok(beforeSteps.includes('    if: >-'))
  assert.ok(beforeSteps.includes("(github.event_name != 'pull_request_review' || github.event.review.state == 'changes_requested') &&"))
  assert.ok(beforeSteps.includes("(github.event_name != 'pull_request' || github.event.action != 'edited' || github.event.changes.body != null)"))
  assert.ok(source.includes('ref: ${{ github.event.repository.default_branch }}'))
  assert.ok(source.includes('persist-credentials: false'))
})

test('keeps REST headers, null responses, and transport errors unchanged', async (t) => {
  mockPolicyApi(t)
  process.env.GH_TOKEN = 'preferred-token'
  process.env.PROJECT_TOKEN = 'project-token'
  process.env.GITHUB_API_URL = 'https://github.example/api/v3'
  const requests = []
  const responses = [
    Response.json({ ok: true }),
    new Response(null, { status: 204 }),
    new Response('missing', { status: 404 }),
    new Response('denied', { status: 403 }),
    Response.json({ errors: [{ message: 'first' }, { message: 'second' }] }),
  ]
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options })
    return responses.shift()
  })
  assert.deepEqual(await api('/example'), { ok: true })
  assert.deepEqual(requests[0], {
    url: 'https://github.example/api/v3/example',
    options: { headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer preferred-token',
      'X-GitHub-Api-Version': '2026-03-10',
      'User-Agent': 'dsh-issue-policy',
    } },
  })
  assert.equal(await api('/empty'), null)
  assert.equal(await api('/missing', { allow404: true }), null)
  await assert.rejects(api('/denied', { method: 'PATCH' }), { message: 'PATCH /denied: 403 denied' })
  await assert.rejects(graphql('query { viewer { login } }', {}), { message: 'first; second' })
  assert.equal(requests[4].options.headers.Authorization, 'Bearer project-token')
  assert.equal(requests[4].options.method, 'POST')
  assert.equal(requests[4].options.body, JSON.stringify({ query: 'query { viewer { login } }', variables: {} }))
  assert.equal(requests.length, 5)
})

test('reads policy snapshots in reference order and only resolving Project priorities', async (t) => {
  const fixture = mockPolicyApi(t, {
    pull: { body: 'Refs #4; Fixes #3; Fixes #2' },
    issues: { 2: {}, 3: { pull_request: {} }, 4: {} },
  })
  assert.deepEqual(await pullRequestSnapshot(10), {
    number: 10,
    isDraft: false,
    authorType: 'User',
    reviewRequestCount: 1,
    reviewCount: 0,
    labels: ['kind/cleanup', 'area/infra'],
    references: { all: [2, 4], resolving: [2], related: [4] },
    issues: new Map([[2, { priority: 'P1' }], [4, { priority: null }]]),
  })
  const repo = '/repos/deepseek-harness/deepseek-harness'
  assert.deepEqual(fixture.requests, [
    repo + '/pulls/10',
    repo + '/pulls/10/requested_reviewers',
    repo + '/pulls/10/reviews?per_page=100',
    repo + '/issues/2',
    repo + '/issues/3',
    repo + '/issues/4',
    '/graphql',
  ])
  assert.deepEqual(fixture.output, [])
})

test('reads lifecycle references for draft Bot PRs without review or Project requests', async (t) => {
  const fixture = mockPolicyApi(t, {
    pull: { draft: true, user: { type: 'Bot' }, body: 'Fixes #2; Refs #4', created_at: '2026-08-27T16:00:00Z' },
    issues: { 2: {}, 4: {} },
  })
  assert.deepEqual(await lifecyclePullRequestSnapshot(10), {
    number: 10,
    references: { all: [2, 4], resolving: [2], related: [4] },
    issues: new Map([[2, { priority: null }], [4, { priority: null }]]),
    createdAt: '2026-08-27T16:00:00Z',
  })
  const repo = '/repos/deepseek-harness/deepseek-harness'
  assert.deepEqual(fixture.requests, [repo + '/pulls/10', repo + '/issues/2', repo + '/issues/4'])
  assert.deepEqual(fixture.output, [])
})

test('allows missing Priority only when resolving Issues are also unprioritized', () => {
  const pull = {
    isDraft: false,
    authorType: 'User',
    reviewRequestCount: 1,
    reviewCount: 0,
    labels: ['kind/feature', 'area/web'],
    references: { all: [2], resolving: [2], related: [] },
    issues: new Map([[2, { priority: null }]]),
  }
  assert.deepEqual(validatePullRequest(pull), [])
  assert.ok(
    validatePullRequest({ ...pull, issues: new Map([[2, { priority: 'P2' }]]) }).includes(
      'PR Priority 应为 p2',
    ),
  )
  assert.ok(
    validatePullRequest({ ...pull, labels: [...pull.labels, 'p2'] }).includes(
      '有 Priority 的解决型 PR 要求每个被解决 Issue 都设置 Priority',
    ),
  )
})
