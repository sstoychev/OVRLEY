import { useEffect, useMemo, useState } from 'react'
import * as backend from '@/api/backend'
import useStore from '@/store/useStore'

// Recent checks keyed by request: the timeline's consumers share one native call.
const RECENT_LIMIT = 8
const recent = new Map()

function checkOnce(key) {
  if (!recent.has(key)) {
    const check = backend.checkJoinability(JSON.parse(key))
    // A failed check is not remembered, so the same request asks again.
    check.catch(() => recent.delete(key))
    recent.set(key, check)
    if (recent.size > RECENT_LIMIT) recent.delete(recent.keys().next().value)
  }
  return recent.get(key)
}

/**
 * Checks outputs natively for whether each can be joined into one file (see
 * `checkJoinability`). The latest request wins; until its answer arrives the
 * previous answer stays, flagged unsettled. A failed check is an error message.
 * @param {object|null} request Joinability request, or null when there is nothing to check.
 * @returns {{outputs: Array<{outputId: string, issues: Array<object>}>|null, settled: boolean}}
 *   Issues per output of the latest answer (null before the first one or without a request), and whether it answers `request`.
 */
export default function useJoinability(request) {
  const key = useMemo(() => (request === null ? null : JSON.stringify(request)), [request])
  const [answer, setAnswer] = useState(null)
  useEffect(() => {
    if (key === null) return
    let current = true
    checkOnce(key)
      .then((outputs) => {
        if (current) setAnswer({ key, outputs })
      })
      .catch((error) => {
        if (current) useStore.getState().setErrorMessage(error.message)
      })
    return () => {
      current = false
    }
  }, [key])
  if (key === null) return { outputs: null, settled: true }
  return { outputs: answer?.outputs ?? null, settled: answer?.key === key }
}
