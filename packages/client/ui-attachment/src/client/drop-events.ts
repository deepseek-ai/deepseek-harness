/** Document drag-and-drop listeners owned by one mounted attachment view. */
import type { ComposerAttachmentsProps } from '@deepseek-ai/dsh-client-ui-conversation/client'

/**
 * Install one attachment view's file-drop listeners.
 * @param canAcceptDrop - whether this view accepts the dropped files.
 * @param onAddFiles - attachment intake callback.
 * @param dragDepth - the view's retained nested-drag counter.
 * @param setDragActive - publish whether a file drag is active.
 * @returns cleanup for exactly these listeners.
 */
export function installDocumentDropEvents(
  canAcceptDrop: ComposerAttachmentsProps['canAcceptDrop'],
  onAddFiles: ComposerAttachmentsProps['onAddFiles'],
  dragDepth: { current: number },
  setDragActive: (active: boolean) => void,
): () => void {
  const fileTransfer = (event: globalThis.DragEvent): DataTransfer | null => {
    const dataTransfer = event.dataTransfer
    if (dataTransfer === null || !dataTransfer.types.includes('Files')) return null
    return dataTransfer
  }
  const reset = (): void => {
    dragDepth.current = 0
    setDragActive(false)
  }
  const onDragEnter = (event: globalThis.DragEvent): void => {
    if (fileTransfer(event) === null) return
    event.preventDefault()
    dragDepth.current += 1
    setDragActive(true)
  }
  const onDragOver = (event: globalThis.DragEvent): void => {
    const dataTransfer = fileTransfer(event)
    if (dataTransfer === null) return
    event.preventDefault()
    dataTransfer.dropEffect = canAcceptDrop ? 'copy' : 'none'
  }
  const onDragLeave = (event: globalThis.DragEvent): void => {
    if (fileTransfer(event) === null) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragActive(false)
    const leftViewport = event.clientX <= 0 || event.clientY <= 0
      || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight
    if ((event.target === document.documentElement || event.target === document.body) && leftViewport) reset()
  }
  const onDrop = (event: globalThis.DragEvent): void => {
    const dataTransfer = fileTransfer(event)
    if (dataTransfer === null) return
    event.preventDefault()
    reset()
    if (canAcceptDrop) onAddFiles([...dataTransfer.files])
  }
  document.addEventListener('dragenter', onDragEnter)
  document.addEventListener('dragover', onDragOver)
  document.addEventListener('dragleave', onDragLeave)
  document.addEventListener('drop', onDrop)
  window.addEventListener('dragend', reset)
  return () => {
    document.removeEventListener('dragenter', onDragEnter)
    document.removeEventListener('dragover', onDragOver)
    document.removeEventListener('dragleave', onDragLeave)
    document.removeEventListener('drop', onDrop)
    window.removeEventListener('dragend', reset)
  }
}
