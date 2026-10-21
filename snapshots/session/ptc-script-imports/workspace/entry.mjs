import { Counter, counter } from 'runner:counter'

export const first = () => [counter.next(), counter instanceof Counter]
export async function later() {
  const again = await import('runner:counter')
  return [again.counter === counter, again.counter.next()]
}
export const denied = () => import('runner:denied')
