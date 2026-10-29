/** Document drag-and-drop listeners owned by one mounted attachment view. */
import { FILE_DRAG_TOKEN_TYPE } from '@deepseek-ai/dsh-util-file-drag'
import type { ComposerAttachmentsProps } from '@deepseek-ai/dsh-client-ui-conversation/client'

/**
 * Members of a drop that are directories. The `File` a directory drop yields
 * is indistinguishable from an empty file, so the entry API is the only
 * source of that fact; browsers without it report no directories.
 */
function droppedDirectories(dataTransfer: DataTransfer, files: readonly File[]): ReadonlySet<File> {
  const directories = new Set<File>()
  let fileIndex = 0
  for (const item of dataTransfer.items) {
    if (item.kind !== 'file') continue
    const file = files[fileIndex++]
    if (typeof item.webkitGetAsEntry !== 'function') continue
    if (item.webkitGetAsEntry()?.isDirectory !== true) continue
    if (file !== undefined) directories.add(file)
  }
  return directories
}

/**
 * Install one attachment view's file-drop listeners.
 * @param canAcceptDrop - whether this view accepts the dropped files.
 * @param onAddFiles - attachment intake callback.
 * @param dragDepth - the view's retained nested-drag counter.
 * @param setDragActive - publish whether a file drag is active.
 * @param readFileDrag - resolve an original image retained by this application during a browser drag.
 * @returns cleanup for exactly these listeners.
 */
export function installDocumentDropEvents(
  canAcceptDrop: ComposerAttachmentsProps['canAcceptDrop'],
  onAddFiles: ComposerAttachmentsProps['onAddFiles'],
  dragDepth: { current: number },
  setDragActive: (active: boolean) => void,
  readFileDrag: (transfer: DataTransfer) => File | undefined,
): () => void {
  const fileTransfer = (event: globalThis.DragEvent): DataTransfer | null => {
    const dataTransfer = event.dataTransfer
    if (dataTransfer === null || (!dataTransfer.types.includes('Files') && !dataTransfer.types.includes(FILE_DRAG_TOKEN_TYPE))) return null
    if (dataTransfer.types.includes(FILE_DRAG_TOKEN_TYPE)
      && (!(event.target instanceof Element) || event.target.closest('[data-composer-card]') === null)) return null
    return dataTransfer
  }
  const reset = (): void => {
    dragDepth.current = 0
    setDragActive(false)
  }
  const onDragEnter = (event: globalThis.DragEvent): void => {
    const dataTransfer = fileTransfer(event)
    if (dataTransfer === null) return
    event.preventDefault()
    dragDepth.current += 1
    if (!dataTransfer.types.includes(FILE_DRAG_TOKEN_TYPE)) setDragActive(true)
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
    if (canAcceptDrop) {
      const image = dataTransfer.types.includes(FILE_DRAG_TOKEN_TYPE) ? readFileDrag(dataTransfer) : undefined
      const files = image === undefined ? [...dataTransfer.files] : [image]
      if (files.length > 0) onAddFiles(files, droppedDirectories(dataTransfer, files))
    }
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
