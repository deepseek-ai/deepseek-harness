/** Read-only text viewer the page shows when the worker's `xdg-open` names a VFS file. */

const VIEWER_STYLE = `
  [data-preview-text-viewer] {
    width: min(960px, calc(100vw - 32px));
    height: min(720px, calc(100dvh - 32px));
    padding: 0;
    box-sizing: border-box;
    border: 1px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%));
    border-radius: var(--dsw-radius-lg, 16px);
    color: var(--dsw-alias-label-primary, #0f1115);
    background: var(--dsw-alias-bg-base, #fff);
    font-family: var(--dsw-font-family, inherit);
  }
  [data-preview-text-viewer][open] { display: flex; flex-direction: column; }
  [data-preview-text-viewer]::backdrop { background: rgb(0 0 0 / 32%); }
  [data-preview-text-viewer] header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--dsw-alias-border-l1, rgb(0 0 0 / 6%));
  }
  [data-preview-text-viewer] h2 {
    flex: 1;
    min-width: 0;
    margin: 0;
    overflow: hidden;
    font-size: 14px;
    line-height: 22px;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  [data-preview-text-viewer] button {
    height: 28px;
    padding: 0 12px;
    border: 1px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 10%));
    border-radius: var(--dsw-radius-sm, 8px);
    color: inherit;
    background: transparent;
    font: inherit;
    cursor: pointer;
  }
  [data-preview-text-viewer] pre {
    flex: 1;
    margin: 0;
    padding: 16px;
    overflow: auto;
    background: var(--dsw-alias-markdown-code-block, transparent);
    font: 13px/20px ui-monospace, SFMono-Regular, Menlo, monospace;
    white-space: pre;
  }
`

/**
 * Show one file in the page's modal viewer, replacing any file it already shows.
 * @param path - Absolute VFS path used as the title.
 * @param text - File contents, rendered as plain text.
 */
export function showTextViewer(path: string, text: string): void {
  let dialog = document.querySelector<HTMLDialogElement>('dialog[data-preview-text-viewer]')
  if (dialog === null) {
    const style = document.createElement('style')
    style.textContent = VIEWER_STYLE
    document.head.append(style)
    dialog = document.createElement('dialog')
    dialog.dataset.previewTextViewer = ''
    const header = document.createElement('header')
    const title = document.createElement('h2')
    const close = document.createElement('button')
    close.type = 'button'
    close.textContent = 'Close'
    const shown = dialog
    close.addEventListener('click', () => { shown.close() })
    // The app's modal layers own Escape and Tab through document listeners;
    // keys pressed in this top-layer dialog belong to its native handling.
    dialog.addEventListener('keydown', (event) => { event.stopPropagation() })
    header.append(title, close)
    dialog.append(header, document.createElement('pre'))
    document.body.append(dialog)
  }
  const title = dialog.querySelector('h2') as HTMLHeadingElement
  title.textContent = path
  title.title = path
  ;(dialog.querySelector('pre') as HTMLPreElement).textContent = text
  if (!dialog.open) dialog.showModal()
}
