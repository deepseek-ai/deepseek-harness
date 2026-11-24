/** Fixed-size frames of whole 16-bit samples cut from a PCM byte stream. */

/**
 * Re-cut a PCM byte stream whose chunks split anywhere into frames that each decode on their own.
 * @param audio - 16-bit PCM bytes in playback order.
 * @param frameBytes - even, positive size of every frame but the last.
 * @returns frames of `frameBytes` bytes, then one shorter frame of whole samples; a final odd byte is dropped.
 */
export async function* pcmFrames(audio: AsyncIterable<Uint8Array>, frameBytes: number): AsyncGenerator<Uint8Array> {
  let pending: Uint8Array = new Uint8Array(0)
  for await (const chunk of audio) {
    pending = pending.byteLength === 0 ? chunk : Buffer.concat([pending, chunk])
    let offset = 0
    for (; pending.byteLength - offset >= frameBytes; offset += frameBytes) yield pending.subarray(offset, offset + frameBytes)
    pending = pending.subarray(offset)
  }
  const whole = pending.byteLength - pending.byteLength % 2
  if (whole > 0) yield pending.subarray(0, whole)
}
