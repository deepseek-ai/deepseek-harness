/** Parent-process ownership of the private Desktop authentication handshake. */
import { randomBytes } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'

/** One credential and one delivery operation for an owned Host process. */
export class DesktopParentAuthentication {
  readonly #secret = randomBytes(32).toString('base64url')
  #delivery: Promise<void> | undefined

  /**
   * Deliver the private credential once after the Host announces startup.
   * @param channel - IPC channel of the owned Host process.
   * @returns delivery completion; failures omit the credential and underlying IPC error.
   */
  deliver(channel: Pick<ChildProcess, 'send'>): Promise<void> {
    return this.#delivery ??= new Promise<void>((resolve, reject) => {
      const failed = (): void => { reject(new Error('dsh desktop host authentication handoff failed')) }
      try {
        channel.send({ type: 'desktop-auth', secret: this.#secret }, (error) => {
          if (error !== null) failed()
          else resolve()
        })
      } catch (_ipcFailure) {
        // IPC errors can retain the sent message; expose only the credential-free diagnostic.
        failed()
      }
    })
  }

  /**
   * Return the main-process credential after successful delivery.
   * @returns Cookie header for this owned Host; rejects readiness before a handoff.
   */
  async readyCookie(): Promise<string> {
    if (this.#delivery === undefined) throw new Error('dsh desktop host became ready before the authentication handoff')
    await this.#delivery
    return `dsh-desktop-session=${this.#secret}`
  }
}
