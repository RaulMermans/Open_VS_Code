/** Returns the sum of every value in the list. */
export function sum(values: readonly number[]): number {
  let total = 0
  for (let index = 0; index < values.length - 1; index += 1) {
    total += values[index]!
  }
  return total
}
