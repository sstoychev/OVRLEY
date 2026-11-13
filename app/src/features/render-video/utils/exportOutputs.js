/**
 * Reviews an export of the imported videos and builds its native batch outputs.
 *
 * Separate mode renders one output per video: the program of that video alone,
 * so overlaps with other videos do not trim it. Combined mode renders one output
 * holding the program of every video (overlaps resolved). Transparent outputs
 * join their pieces with hard cuts. Whether an output can be joined into one file
 * is decided natively (see `checkJoinability`); this review only words its issues.
 */

import i18next from 'i18next'
import { filenameFromSelectedPath } from '@/lib/file-dialog'
import { createJoinabilityRequest, createNativeOutput } from '@/lib/video-program/joinability'
import { buildProgram } from '@/lib/video-program/program'
import { reviewBatchQueue } from './renderPresentation'

const COMBINED_OUTPUT_ID = 'combined'

/**
 * Words joinability issues (see `checkJoinability`) for one output, one message
 * per kind.
 * @param {Array<object>} issues Joinability issues naming sources by video ID.
 * @param {Array<object>} clips Clips the issues refer to.
 * @param {import('i18next').TFunction} t Translation function.
 * @returns {string[]} Messages naming the videos.
 */
export function describeJoinIssues(issues, clips, t) {
  const namesOf = (ids) => clips.filter((clip) => ids.has(clip.id)).map((clip) => filenameFromSelectedPath(clip.path))
  const idsOf = (kind) =>
    new Set(
      issues
        .filter((issue) => issue.kind === kind)
        .flatMap((issue) => (kind === 'overlap' ? [issue.earlierSourceId, issue.laterSourceId] : issue.sourceIds)),
    )
  const messages = []
  const overlapping = idsOf('overlap')
  if (overlapping.size > 0) {
    messages.push(
      t('render-video.combinedOverlap', {
        defaultValue: 'Videos overlap ({{names}}). Move a video or exclude the overlapping part from export.',
        names: namesOf(overlapping).join(', '),
      }),
    )
  }
  const incompatible = idsOf('incompatible')
  if (incompatible.size > 0) {
    messages.push(
      t('render-video.combinedIncompatible', {
        defaultValue: 'Videos differ in resolution or frame rate ({{names}}). Remove them or export separate files.',
        names: namesOf(incompatible).join(', '),
      }),
    )
  }
  const rotated = idsOf('rotation')
  if (rotated.size > 0) {
    messages.push(
      t('render-video.combinedRotation', {
        defaultValue: 'Videos are rotated differently ({{names}}), which this encoder cannot join into one file. Export separate files.',
        names: namesOf(rotated).join(', '),
      }),
    )
  }
  if (issues.some((issue) => issue.kind === 'transitionTooLong')) {
    messages.push(t('render-video.combinedInvalidTransitions', 'Some transitions are longer than the video pieces they join.'))
  }
  return messages
}

/**
 * Builds the programs of an export: one per video in separate mode, one of every
 * video in combined mode.
 * @param {object} options Program inputs.
 * @param {'combined'|'separate'} options.outputMode Output mode.
 * @param {Array<object>} options.clips Timeline clips in timeline order.
 * @param {{type: 'all'|'custom', from: number, to: number}} options.exportRange Export range in timeline seconds.
 * @param {object} options.transitionDefaults Project transition defaults.
 * @returns {Array<{id: string, program: object}>} Programs keyed by output ID: the video ID, or `combined`.
 */
export function buildExportPrograms({ outputMode, clips, exportRange, transitionDefaults }) {
  const programOf = (videos) => buildProgram({ videos, exportRange, transitionDefaults })
  return outputMode === 'separate'
    ? clips.map((clip) => ({ id: clip.id, program: programOf([clip]) }))
    : [{ id: COMBINED_OUTPUT_ID, program: programOf(clips) }]
}

/**
 * Builds the native joinability check of an export's programs.
 * @param {object} options Request inputs.
 * @param {Array<{id: string, program: object}>} options.programs Export programs (see `buildExportPrograms`).
 * @param {Array<object>} options.clips Timeline clips.
 * @param {'composite'|'transparent'} options.exportMode Export mode.
 * @param {string} options.codec Export codec.
 * @returns {object|null} Request for `checkJoinability`, or null when no program has pieces.
 */
export function createExportJoinabilityRequest({ programs, clips, exportMode, codec }) {
  const outputs = programs
    .filter(({ program }) => program.pieces.length > 0)
    .map(({ id, program }) =>
      createNativeOutput({ id, program, sourceIdOf: (videoId) => videoId, skipOverlay: {}, hardCutsOnly: exportMode === 'transparent' }),
    )
  return outputs.length === 0 ? null : createJoinabilityRequest({ clips, outputs, exportMode, exportCodec: codec })
}

function combinedBlockers({ program, issues, clips, rows, t }) {
  const names = (ids) => clips.filter((clip) => ids.has(clip.id)).map((clip) => filenameFromSelectedPath(clip.path))
  const blockers = []
  if (program.pieces.length === 0) blockers.push(t('render-video.nothingInExportRange', 'No video lies inside the export range.'))
  blockers.push(...describeJoinIssues(issues, clips, t))
  const unavailable = new Set(rows.filter((row) => row.pieces.length > 0 && row.status === 'blocked').map((row) => row.id))
  if (unavailable.size > 0) {
    blockers.push(
      t('render-video.combinedUnavailable', { defaultValue: 'Some videos cannot be exported ({{names}}).', names: names(unavailable).join(', ') }),
    )
  }
  return blockers
}

/**
 * @param {object} options Review inputs.
 * @param {'combined'|'separate'} options.outputMode Output mode.
 * @param {'composite'|'transparent'} options.exportMode Export mode.
 * @param {Array<{id: string, program: object}>} options.programs Export programs (see `buildExportPrograms`).
 * @param {Array<{outputId: string, issues: Array<object>}>|null} options.joinability Native answer to
 *   `createExportJoinabilityRequest` for these programs, or null until it arrives.
 * @param {Array<object>} options.clips Timeline clips in timeline order.
 * @param {Object<string, boolean>} options.skipOverlay Video IDs that render without activity widgets.
 * @param {object|null} options.inspection Current native descriptors keyed by path.
 * @param {object} options.sync Activity summary and display timezone mode.
 * @param {string} options.locale Display language.
 * @param {string} options.outputPath Combined output file (its output ID).
 * @returns {{rows: Array<object>, blockers: Array<string>, outputs: Array<object>|null, offsets: Object<string, number>}}
 *   Reviewed video rows, reasons combined export is unavailable, native outputs once every video is
 *   reviewed, joinability is known and nothing blocks them, and the committed offsets of their sources.
 */
export function reviewExport({ outputMode, exportMode, programs, joinability, clips, skipOverlay, inspection, sync, locale, outputPath }) {
  const t = i18next.getFixedT(locale)
  const programsById = new Map(programs.map(({ id, program }) => [id, program]))
  // Outputs without pieces are not checked, and nothing is known before the answer.
  const issuesById = new Map((joinability ?? []).map((output) => [output.outputId, output.issues]))
  const issuesOf = (id) => issuesById.get(id) ?? []
  const program = outputMode === 'combined' ? programsById.get(COMBINED_OUTPUT_ID) : null
  const piecesByVideo = new Map(
    clips.map((clip) => [clip.id, (program ?? programsById.get(clip.id)).pieces.filter((piece) => piece.videoId === clip.id)]),
  )
  const rows = reviewBatchQueue(clips, piecesByVideo, skipOverlay, inspection, sync, locale).map((row) => {
    if (outputMode !== 'separate' || row.status !== 'pending') return row
    const [reason] = describeJoinIssues(issuesOf(row.id), clips, t)
    return reason === undefined ? row : { ...row, status: 'blocked', error: reason }
  })
  const blockers = program === null ? [] : combinedBlockers({ program, issues: issuesOf(COMBINED_OUTPUT_ID), clips, rows, t })
  const pending = rows.filter((row) => row.status === 'pending')
  const sourceIds = new Map(pending.map((row) => [row.id, row.source.sourceId]))
  const settled = rows.every((row) => row.status !== 'checking') && joinability !== null
  const nativeOutput = (id, outputProgram) =>
    createNativeOutput({
      id,
      program: outputProgram,
      sourceIdOf: (videoId) => sourceIds.get(videoId),
      skipOverlay,
      hardCutsOnly: exportMode === 'transparent',
    })
  let outputs = null
  if (settled && blockers.length === 0) {
    outputs = outputMode === 'separate' ? pending.map((row) => nativeOutput(row.path, programsById.get(row.id))) : [nativeOutput(outputPath, program)]
  }
  const usedVideoIds = new Set((outputs ?? []).flatMap((output) => output.pieces.map((piece) => piece.sourceId)))
  const offsets = Object.fromEntries(
    pending.filter((row) => usedVideoIds.has(row.source.sourceId)).map((row) => [row.source.sourceId, row.offsetSeconds]),
  )
  return { rows, blockers, outputs, offsets }
}
