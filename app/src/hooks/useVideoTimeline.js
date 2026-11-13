/**
 * Store-backed derivations of the imported-video timeline.
 */

import { useCallback, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import useStore from '@/store/useStore'
import { hasActivityCoverage, resolveActivityClipId, resolveActivityContext, resolveAvailableMetrics } from '@/lib/activity/activity-context'
import { createProgramJoinabilityRequest, listTooLongJoinKeys } from '@/lib/video-program/joinability'
import { selectVideoTimeline } from '@/lib/video-program/timeline'
import { listTransitionProxyJobs } from '@/lib/video-program/transition-proxies'
import { deriveVideoWarnings } from '@/lib/video-program/video-warnings'
import useJoinability from './useJoinability'

const NO_ISSUES = Object.freeze([])

/**
 * Returns the timeline (see `selectVideoTimeline`).
 * @returns {object} Timeline, built once per change for every subscriber.
 */
export function useVideoTimeline() {
  return useStore(selectVideoTimeline)
}

/**
 * Checks the committed timeline natively, as one file with the project's export
 * mode and codec (see `useJoinability`). Until the first answer there are no issues.
 * @returns {{issues: Array<object>, tooLongJoinKeys: Set<string>}} Joinability issues and the keys of joins too long for their pieces.
 */
export function useTimelineJoinIssues() {
  const { clips, program } = useVideoTimeline()
  const renderSettings = useStore((state) => state.renderSettings)
  const request = useMemo(() => createProgramJoinabilityRequest({ clips, program, renderSettings }), [clips, program, renderSettings])
  const { outputs } = useJoinability(request)
  return useMemo(() => {
    const issues = request === null || outputs === null ? NO_ISSUES : outputs[0].issues
    return { issues, tooLongJoinKeys: listTooLongJoinKeys(program, issues) }
  }, [outputs, program, request])
}

/**
 * Returns the warnings of every committed clip (see `deriveVideoWarnings`).
 * @returns {Map<string, Array<{kind: string, params: object}>>} Warnings keyed by video ID.
 */
export function useVideoWarnings() {
  const { clips } = useVideoTimeline()
  const { issues } = useTimelineJoinIssues()
  const activityDurationSeconds = useStore((state) => (state.parsedActivity === null ? null : state.activitySummary.durationSeconds))
  return useMemo(() => deriveVideoWarnings(clips, issues, activityDurationSeconds), [activityDurationSeconds, clips, issues])
}

/**
 * Returns the activity that drives widgets at the playhead. Consumers re-render
 * only when that activity changes, not on every playhead frame.
 * @returns {{activity: object|null, summary: object|null, originSecond: number, videoId: string|null}|null} Activity context.
 */
export function useActivityContext() {
  const parsedActivity = useStore((state) => state.parsedActivity)
  const activitySummary = useStore((state) => state.activitySummary)
  const { clips, program } = useVideoTimeline().displayed
  const clipId = useStore(
    useCallback((state) => (parsedActivity === null ? resolveActivityClipId(program, state.selectedSecond) : null), [parsedActivity, program]),
  )
  return useMemo(
    () =>
      resolveActivityContext({
        parsedActivity,
        activitySummary,
        clip: clipId === null ? null : clips.find((clip) => clip.id === clipId),
      }),
    [activitySummary, clipId, clips, parsedActivity],
  )
}

/**
 * Returns whether activity data covers the playhead (see `hasActivityCoverage`).
 * Consumers re-render only when coverage changes, not on every playhead frame.
 * @returns {boolean} Whether non-raster widgets are shown at the playhead.
 */
export function usePlayheadActivityCoverage() {
  const parsedActivity = useStore((state) => state.parsedActivity)
  const activitySummary = useStore((state) => state.activitySummary)
  const { clips, program } = useVideoTimeline().displayed
  return useStore(
    useCallback(
      (state) => hasActivityCoverage({ parsedActivity, activitySummary, program, clips, second: state.selectedSecond }),
      [activitySummary, clips, parsedActivity, program],
    ),
  )
}

/**
 * Returns metrics available for new widgets across the external activity or all embedded telemetry.
 * @returns {Array<{attribute: string, source: string}>} Available metrics.
 */
export function useAvailableMetrics() {
  const { activitySummary, importedVideos } = useStore(
    useShallow((state) => ({ activitySummary: state.activitySummary, importedVideos: state.importedVideos })),
  )
  return useMemo(() => resolveAvailableMetrics(activitySummary, importedVideos), [activitySummary, importedVideos])
}

/**
 * Returns the transition proxy jobs of the committed program.
 * @returns {Array<object>} Jobs (see `listTransitionProxyJobs`).
 */
export function useTransitionProxyJobs() {
  const { clips, program } = useVideoTimeline()
  return useMemo(() => listTransitionProxyJobs(program, clips), [clips, program])
}
