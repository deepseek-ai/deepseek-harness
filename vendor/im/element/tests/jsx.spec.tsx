/** @jsxRuntime automatic */
/** @jsxImportSource @deepseek-ai/satori-element */

import { describe, expect, it } from 'vitest'
import { normalize, toText } from '@deepseek-ai/satori-element'

function Item(props: { label: string; done?: boolean }) {
  return <li checked={props.done}>{props.label}</li>
}

describe('JSX', () => {
  it('renders intrinsic elements, fragments, components and conditionals', () => {
    const show = false as boolean
    const tree = (
      <message>
        <title theme="info">Report</title>
        <>intro <b>bold</b></>
        {show && <p>hidden</p>}
        <ul>
          <Item label="a" done />
          <Item label="b" />
        </ul>
        <markdown>{'md text'}</markdown>
        <button-group>
          <button type="action" id="ok">OK</button>
        </button-group>
      </message>
    )
    const out = normalize(tree)
    expect(out.toString()).toBe(
      '<message><title theme="info">Report</title><p>intro <b>bold</b></p>'
      + '<ul><li checked><p>a</p></li><li><p>b</p></li></ul><markdown content="md text"/>'
      + '<button-group><button type="action" id="ok">OK</button></button-group></message>',
    )
    expect(toText(out)).toBe('Report\nintro bold\n• ☑ a\n• b\nmd text\n[OK]')
  })
})
