import { Counter, counter } from 'runner:counter'
import { env } from 'node:process'

if (Object.keys(env).length !== 0) throw new Error('Expected an empty program environment')

export const first = () => [counter.next(), counter instanceof Counter]
export async function later() {
  const again = await import('runner:counter')
  return [again.counter === counter, again.counter.next()]
}
export const denied = () => import('runner:denied')
