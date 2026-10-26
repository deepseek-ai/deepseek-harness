import { Counter, counter } from 'runner:counter'
import { env } from 'node:process'
import { answer, then } from 'data:text/javascript,export const answer = 42; export function then(resolve) { resolve(17) }'

if (Object.keys(env).length !== 0) throw new Error('Expected an empty program environment')
if (answer !== 42 || typeof then !== 'function') throw new Error('Expected every static native export')

export const first = () => [counter.next(), counter instanceof Counter]
export async function later() {
  const again = await import('runner:counter')
  return [again.counter === counter, again.counter.next()]
}
export const denied = () => import('runner:denied')
