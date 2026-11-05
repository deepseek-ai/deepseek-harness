/**
 * Runtime cases for the viewer endpoint classification.
 *
 * The completeness gate itself is the `satisfies Record<RemoteEndpoint, ViewerEndpointClass>` declaration
 * in `src/client/endpoint-classification.ts`, compiled by the package's Client face; this spec pins the
 * diagnostics the Host also uses when the derived action set drifts from the policy roles.
 */
import { describe, expect, it } from 'vitest'
import { COMPLETE_VIEWER_ENDPOINT_CLASSES } from '../src/client/endpoint-classification.ts'
import { VIEWER_ENDPOINT_CLASSES, assertSameViewerActions } from '../src/endpoint-classification.ts'

/** The table's keys, used as the expected set in the runtime cases. */
const CLASSIFIED = Object.keys(VIEWER_ENDPOINT_CLASSES)

describe('viewer endpoint classification', () => {
  it('exports the compiled classification without changing its keys', () => {
    expect(Object.keys(COMPLETE_VIEWER_ENDPOINT_CLASSES)).toEqual(CLASSIFIED)
  })

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
