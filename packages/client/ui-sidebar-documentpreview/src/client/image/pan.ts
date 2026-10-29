/** Mouse panning for overflowing image previews; contained images keep native file dragging. */

/**
 * Bind image panning to its existing scrollport without changing zoom or replacing the image.
 * @param image - mounted preview image inside a document zoom scrollport.
 * @returns cleanup releasing observation, pointer capture, and window listeners.
 */
export function bindImagePan(image: HTMLImageElement): () => void {
  const scrollport = image.closest<HTMLElement>('[data-document-zoom-scrollport]')
  if (scrollport === null) throw new Error('Image panning requires a document zoom scrollport')
  let pointer: { id: number; x: number; y: number; pan: boolean } | undefined
  const overflowing = (): boolean => scrollport.scrollWidth > scrollport.clientWidth
    || scrollport.scrollHeight > scrollport.clientHeight
  const measure = (): void => {
    if (pointer !== undefined) return
    const pan = overflowing()
    image.dataset.pan = pan ? 'available' : 'none'
    image.draggable = !pan
  }
  const finish = (): void => {
    const previous = pointer
    pointer = undefined
    if (previous !== undefined && image.hasPointerCapture(previous.id)) image.releasePointerCapture(previous.id)
    measure()
  }
  const down = (event: PointerEvent): void => {
    if (event.button !== 0 || event.pointerType !== 'mouse') return
    measure()
    const pan = overflowing()
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, pan }
    if (!pan) return
    event.preventDefault()
    image.dataset.pan = 'active'
    image.setPointerCapture(event.pointerId)
  }
  const move = (event: PointerEvent): void => {
    if (pointer === undefined || !pointer.pan || event.pointerId !== pointer.id) return
    if (event.buttons !== 1) { finish(); return }
    event.preventDefault()
    scrollport.scrollLeft = Math.max(0, Math.min(scrollport.scrollWidth - scrollport.clientWidth,
      scrollport.scrollLeft + pointer.x - event.clientX))
    scrollport.scrollTop = Math.max(0, Math.min(scrollport.scrollHeight - scrollport.clientHeight,
      scrollport.scrollTop + pointer.y - event.clientY))
    pointer.x = event.clientX
    pointer.y = event.clientY
  }
  const up = (event: PointerEvent): void => { if (event.pointerId === pointer?.id) finish() }
  const drag = (event: DragEvent): void => {
    if (pointer?.pan ?? overflowing()) event.preventDefault()
    else finish()
  }
  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
  observer?.observe(image)
  observer?.observe(scrollport)
  image.addEventListener('load', measure)
  image.addEventListener('pointerenter', measure)
  image.addEventListener('pointerdown', down)
  image.addEventListener('pointermove', move)
  image.addEventListener('pointerup', up)
  image.addEventListener('pointercancel', up)
  image.addEventListener('lostpointercapture', finish)
  image.addEventListener('dragstart', drag)
  image.addEventListener('dragend', finish)
  window.addEventListener('pointerup', up)
  window.addEventListener('blur', finish)
  measure()
  return () => {
    observer?.disconnect()
    image.removeEventListener('load', measure)
    image.removeEventListener('pointerenter', measure)
    image.removeEventListener('pointerdown', down)
    image.removeEventListener('pointermove', move)
    image.removeEventListener('pointerup', up)
    image.removeEventListener('pointercancel', up)
    image.removeEventListener('lostpointercapture', finish)
    image.removeEventListener('dragstart', drag)
    image.removeEventListener('dragend', finish)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('blur', finish)
    finish()
  }
}
