/**
 * Runtime cases for the viewer endpoint classification.
 *
 * The Host derives `POLICY_DECIDED_ACTIONS` from this table and checks it against the policy roles at
 * runtime; these cases pin the diagnostics it reports when the derived action set drifts.
 */
import { describe, expect, it } from 'vitest'
import { VIEWER_ENDPOINT_CLASSES, assertSameViewerActions } from '../src/endpoint-classification.ts'

/** The table's keys, used as the expected set in the runtime cases. */
const CLASSIFIED = Object.keys(VIEWER_ENDPOINT_CLASSES)

describe('viewer endpoint classification', () => {
  it('reports the endpoint a classification is missing', () => {
    const incomplete = Object.fromEntries(
      Object.entries(VIEWER_ENDPOINT_CLASSES).filter(([endpoint]) => endpoint !== 'session/prompt'),
    )
    expect(() => { assertSameViewerActions(Object.keys(incomplete), CLASSIFIED, 'VIEWER_ENDPOINT_CLASSES') })
      .toThrow('liveshare: VIEWER_ENDPOINT_CLASSES must name exactly the same actions; '
        + 'missing ["session/prompt"]; unexpected []')
  })

  it('reports the endpoint a classification adds beyond the expected set', () => {
    const extra = { ...VIEWER_ENDPOINT_CLASSES, 'newPlugin/endpoint': 'plugin-offered' }
    expect(() => { assertSameViewerActions(Object.keys(extra), CLASSIFIED, 'VIEWER_ENDPOINT_CLASSES') })
      .toThrow('liveshare: VIEWER_ENDPOINT_CLASSES must name exactly the same actions; '
        + 'missing []; unexpected ["newPlugin/endpoint"]')
  })
})
