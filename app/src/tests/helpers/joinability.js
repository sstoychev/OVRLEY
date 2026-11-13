/**
 * A native joinability check that finds no issue in any output (see `checkJoinability`).
 * @param {{outputs: Array<{id: string}>}} request Joinability request.
 * @returns {Promise<Array<{outputId: string, issues: Array<object>}>>} No issues per output.
 */
export async function joinsEveryOutput({ outputs }) {
  return outputs.map((output) => ({ outputId: output.id, issues: [] }))
}
