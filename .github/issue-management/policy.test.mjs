import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'

import {
  initializeIssueStartDate,
  initializePullRequestStartDates,
  issueSnapshot,
  nextResolvingIssueStatus,
  parseReferences,
  projectDate,
  retainIssueReferences,
  resolvingIssueStatusCommand,
  requiresPullRequestPolicy,
  validateIssue,
  validatePullRequest,
} from './policy.mjs'

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

test('keeps ordinary pull request events as forward-only implementation signals', () => {
  for (const action of ['opened', 'edited', 'synchronize', 'reopened', 'labeled', 'unlabeled']) {
    assert.equal(resolvingIssueStatusCommand('pull_request', { action }), 'implementation')
  }
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
