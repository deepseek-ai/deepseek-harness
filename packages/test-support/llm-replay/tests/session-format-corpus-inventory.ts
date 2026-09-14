/** Exact historical conversion refusals; current-generation fixtures never qualify. */
export const expectedUnsupported: Readonly<Partial<Record<string, { sourceVersion: number; reason: string }>>> = {
  'packages/experimental/webworker-runtime/tests/fixtures/vfs-example/home/sessions/--dsh-workspace--/preview-architecture-review/session.v2.jsonl': {
    sourceVersion: 2,
    reason: 'session snapshot line 3: format v2 surface before first step cannot acquire a system head without changing chronology',
  },
  'packages/experimental/webworker-runtime/tests/fixtures/vfs-example/home/sessions/--dsh-workspace--/preview-follow-up-builder/session.v2.jsonl': {
    sourceVersion: 2,
    reason: 'session snapshot line 3: format v2 surface before first step cannot acquire a system head without changing chronology',
  },
  'packages/experimental/webworker-runtime/tests/fixtures/vfs-example/home/sessions/--dsh-workspace--/preview-showcase/session.v2.jsonl': {
    sourceVersion: 2,
    reason: 'session snapshot line 3: format v2 surface before first step cannot acquire a system head without changing chronology',
  },
  'packages/test-support/session-snapshot/tests/fixtures/suite/pin-turn/session.v2.jsonl': {
    sourceVersion: 2,
    reason: 'session snapshot line 3: format v2 changed request prompt outside an open step cannot retain source chronology',
  },
  'packages/test-support/session-snapshot/tests/fixtures/suite/plain-turn/session.1.v2.jsonl': {
    sourceVersion: 2,
    reason: 'session snapshot line 3: format v2 changed request prompt outside an open step cannot retain source chronology',
  },
  'packages/test-support/session-snapshot/tests/fixtures/suite/plain-turn/session.v2.jsonl': {
    sourceVersion: 2,
    reason: 'session snapshot line 3: format v2 changed request prompt outside an open step cannot retain source chronology',
  },
  'packages/test-support/session-snapshot/tests/fixtures/suite/shared-pin/session.v2.jsonl': {
    sourceVersion: 2,
    reason: 'session snapshot line 3: format v2 changed request prompt outside an open step cannot retain source chronology',
  },
  'snapshots/web/message-feedback-protocol/session.v2.jsonl': {
    sourceVersion: 2,
    reason: 'session snapshot line 3: format v2 surface before first step cannot acquire a system head without changing chronology',
  },
  'snapshots/web/navigation-panes/session.v2.jsonl': {
    sourceVersion: 2,
    reason: 'session snapshot line 3: format v2 surface before first step cannot acquire a system head without changing chronology',
  },
  // This recording contains an event absent from the released V2 event inventory.
  'snapshots/web/present/session.v2.jsonl': {
    sourceVersion: 2,
    reason: 'session snapshot line 21: format v2 to v3 cannot safely transform unclassified event deliverables/presented',
  },
  'snapshots/web/pwsh-terminal/session.v2.jsonl': {
    sourceVersion: 2,
    reason: 'session snapshot line 3: format v2 surface before first step cannot acquire a system head without changing chronology',
  },
  'snapshots/web/schedule-catalog/session.v2.jsonl': {
    sourceVersion: 2,
    reason: 'session snapshot line 3: format v2 surface before first step cannot acquire a system head without changing chronology',
  },
  'snapshots/web/seeded-history/session.v2.jsonl': {
    sourceVersion: 2,
    reason: 'session snapshot line 3: format v2 surface before first step cannot acquire a system head without changing chronology',
  },
}

/** Headerless snapshot-harness protocol examples, not released Session artifacts. */
export const unversionedProtocolFixtures = new Set([
  'packages/test-support/session-snapshot/tests/fixtures/record-suite/rec-child/session.1.jsonl',
  'packages/test-support/session-snapshot/tests/fixtures/record-suite/rec-child/session.jsonl',
  'packages/test-support/session-snapshot/tests/fixtures/record-suite/rec-pin/session.1.jsonl',
  'packages/test-support/session-snapshot/tests/fixtures/record-suite/rec-pin/session.jsonl',
  'packages/test-support/session-snapshot/tests/fixtures/record-suite/rec-skip/session.jsonl',
  'packages/test-support/session-snapshot/tests/fixtures/suite/authored-error/session.jsonl',
  'packages/test-support/session-snapshot/tests/fixtures/suite/blocked-log/session.jsonl',
  'packages/test-support/session-snapshot/tests/fixtures/suite/no-model/session.jsonl',
  'packages/test-support/session-snapshot/tests/fixtures/suite/pin-turn/session.jsonl',
  'packages/test-support/session-snapshot/tests/fixtures/suite/plain-turn/session.1.jsonl',
  'packages/test-support/session-snapshot/tests/fixtures/suite/plain-turn/session.jsonl',
  'packages/test-support/session-snapshot/tests/fixtures/suite/shared-pin/session.jsonl',
])
