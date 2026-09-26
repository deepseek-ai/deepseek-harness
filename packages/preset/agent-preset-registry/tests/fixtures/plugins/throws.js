// A loadable plugin whose activation rejects with its configured message.
export const name = 'throws'

export function apply(_ctx, config) {
  throw new Error(config.message)
}
