/**
 * Requests for the native joinability check, which alone decides whether the
 * pieces of an output can be joined into one file (see `checkJoinability`), and
 * readers of its issues.
 */

import { HARD_CUT } from './transition-catalog'

/**
 * Builds the native output of a program: the shape the joinability check and the
 * batch planner take.
 * @param {object} options Output inputs.
 * @param {string} options.id Output ID.
 * @param {{pieces: Array<object>, placedPieces: Array<object>, joins: Array<object>}} options.program Program of the output.
 * @param {function(string): string} options.sourceIdOf Native source ID of a video ID.
 * @param {Object<string, boolean>} options.skipOverlay Video IDs that render without activity widgets.
 * @param {boolean} options.hardCutsOnly Whether every join is a hard cut (transparent output).
 * @returns {{id: string, pieces: Array<object>, transitions: Array<object>, placedSegments: Array<object>}} Native output.
 */
export function createNativeOutput({ id, program, sourceIdOf, skipOverlay, hardCutsOnly }) {
  return {
    id,
    pieces: program.pieces.map((piece) => ({
      sourceId: sourceIdOf(piece.videoId),
      startFrame: piece.sourceStartFrame,
      endFrame: piece.sourceEndFrame,
      skipOverlay: skipOverlay[piece.videoId] === true,
    })),
    transitions: program.joins.map((join) => (hardCutsOnly ? { ...HARD_CUT } : { ...join.transition })),
    placedSegments: program.placedPieces.map((piece) => ({
      sourceId: sourceIdOf(piece.videoId),
      startSecond: piece.timelineStartSecond,
      endSecond: piece.timelineEndSecond,
    })),
  }
}

/**
 * Builds a joinability check of outputs whose sources are named by video ID.
 * @param {object} options Request inputs.
 * @param {Array<object>} options.clips Probed clips the outputs use.
 * @param {Array<object>} options.outputs Native outputs (see `createNativeOutput`) naming sources by video ID.
 * @param {'composite'|'transparent'} options.exportMode Export mode the outputs would render with.
 * @param {string} options.exportCodec Export codec the outputs would render with.
 * @returns {object} Request for `checkJoinability`.
 */
export function createJoinabilityRequest({ clips, outputs, exportMode, exportCodec }) {
  return {
    sources: clips.map((clip) => ({
      id: clip.id,
      resolution: { width: clip.resolution.width, height: clip.resolution.height },
      fps: { num: clip.fps.num, den: clip.fps.den },
      rotationDegrees: clip.rotationDegrees,
    })),
    outputs,
    exportMode,
    exportCodec,
  }
}

/**
 * Builds the joinability check of one program with every video's transitions:
 * the timeline and the import dialog flag what a single file could not join
 * whatever the export mode. Null without pieces.
 * @param {object} options Request inputs.
 * @param {Array<object>} options.clips Probed clips of the program.
 * @param {object} options.program Program (see `buildProgram`).
 * @param {{exportMode: 'composite'|'transparent', codec: string}} options.renderSettings Project render settings.
 * @returns {object|null} Request for `checkJoinability`.
 */
export function createProgramJoinabilityRequest({ clips, program, renderSettings }) {
  if (program.pieces.length === 0) return null
  const output = createNativeOutput({ id: 'program', program, sourceIdOf: (videoId) => videoId, skipOverlay: {}, hardCutsOnly: false })
  return createJoinabilityRequest({ clips, outputs: [output], exportMode: renderSettings.exportMode, exportCodec: renderSettings.codec })
}

/**
 * Lists the keys of the joins whose transitions leave a piece no untouched frame.
 * @param {{joins: Array<{key: string}>}} program Program the issues were checked on.
 * @param {Array<object>} issues Joinability issues of its output.
 * @returns {Set<string>} Join keys.
 */
export function listTooLongJoinKeys(program, issues) {
  return new Set(
    issues.filter((issue) => issue.kind === 'transitionTooLong').flatMap((issue) => issue.joinIndices.map((index) => program.joins[index].key)),
  )
}

/**
 * Lists the sources an issue of a kind names.
 * @param {Array<object>} issues Joinability issues.
 * @param {'incompatible'|'rotation'} kind Issue kind.
 * @returns {Set<string>} Source IDs.
 */
export function listIssueSourceIds(issues, kind) {
  return new Set(issues.filter((issue) => issue.kind === kind).flatMap((issue) => issue.sourceIds))
}

/**
 * Lists the overlaps of one source with the others.
 * @param {Array<object>} issues Joinability issues.
 * @param {string} sourceId Source.
 * @returns {Array<{otherSourceId: string, seconds: number}>} Overlapping sources and the overlap lengths.
 */
export function listSourceOverlaps(issues, sourceId) {
  return issues
    .filter((issue) => issue.kind === 'overlap' && (issue.earlierSourceId === sourceId || issue.laterSourceId === sourceId))
    .map((issue) => ({
      otherSourceId: issue.earlierSourceId === sourceId ? issue.laterSourceId : issue.earlierSourceId,
      seconds: issue.endSecond - issue.startSecond,
    }))
}
