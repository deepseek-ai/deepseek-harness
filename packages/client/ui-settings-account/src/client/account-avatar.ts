/** One account picture load shared by the sidebar and Settings for this plugin lifetime. */

/** Browser image outcome for the latest profile picture URL. */
export interface AccountAvatarSnapshot {
  /** Profile picture whose browser load produced this state. */
  url: string
  /** Both account surfaces show the picture only after its shared load succeeds. */
  status: 'loading' | 'ready' | 'failed'
}

/** Owns the browser image and discards callbacks after URL replacement or plugin unload. */
export class AccountAvatarLoader {
  private snapshot: AccountAvatarSnapshot | undefined
  private image: HTMLImageElement | undefined
  private disposed = false

  /** @param publish - publishes picture changes through the account snapshot. */
  constructor(private readonly publish: (snapshot: AccountAvatarSnapshot | undefined) => void) {}

  /**
   * Load a changed URL once; an absent or empty URL clears the picture.
   * @param url - latest successful profile's picture, absent when no picture is available.
   */
  setUrl(url: string | null | undefined): void {
    if (this.disposed) return
    const source = url || undefined
    if (this.snapshot?.url === source) return
    if (source === undefined) {
      this.detach()
      this.update(undefined)
    }
    else this.load(source)
  }

  /** Retry a failed picture once; successful and pending loads remain shared. */
  retry(): void {
    if (!this.disposed && this.snapshot?.status === 'failed') this.load(this.snapshot.url)
  }

  /**
   * Return both surfaces to fallback when a rendered picture fails.
   * @param snapshot - picture attempt rendered by the failing element; superseded attempts are ignored.
   */
  failed(snapshot: AccountAvatarSnapshot): void {
    if (this.disposed || this.snapshot !== snapshot || snapshot.status !== 'ready') return
    this.detach()
    this.update({ url: snapshot.url, status: 'failed' })
  }

  /** Release the picture without publishing; the owner publishes an empty avatar with the replacement account frame. */
  reset(): void {
    this.detach()
    this.snapshot = undefined
  }

  /** Release the browser image and prevent further loads or publications. */
  dispose(): void {
    this.disposed = true
    this.reset()
  }

  private load(url: string): void {
    this.detach()
    const image = new Image()
    this.image = image
    image.referrerPolicy = 'no-referrer'
    const settle = (status: 'ready' | 'failed'): void => {
      if (this.image !== image) return
      image.onload = null
      image.onerror = null
      this.update({ url, status })
    }
    image.onload = () => { settle('ready') }
    image.onerror = () => { settle('failed') }
    this.update({ url, status: 'loading' })
    if (this.image === image) image.src = url
  }

  private update(snapshot: AccountAvatarSnapshot | undefined): void {
    this.snapshot = snapshot
    this.publish(snapshot)
  }

  private detach(): void {
    const image = this.image
    this.image = undefined
    if (image === undefined) return
    image.onload = null
    image.onerror = null
    image.removeAttribute('src')
  }
}
