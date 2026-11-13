import { describe, expect, test } from 'vite-plus/test'
import { buildExportPrograms, createExportJoinabilityRequest, reviewExport } from '@/features/render-video/utils/exportOutputs'
import { joinVideoEdits } from '@/lib/video-program/video-collection'
import { createTestVideo, cutEdits, videoStoreState } from '@/tests/helpers/videoFixtures'

const defaults = { type: 'wipeleft', durationSeconds: 1, splitGapThresholdSeconds: 2 }
const all = { type: 'all', from: 0, to: 0 }
const sync = { activitySummary: null, timezoneMode: 'utc', error: null }

function clipsOf(videos, offsets, edit = () => {}) {
  const { importedVideos, videoEdits } = videoStoreState(videos, offsets)
  edit(videoEdits)
  return joinVideoEdits(importedVideos, videoEdits)
}

function inspected(clips, failing = []) {
  return {
    complete: true,
    error: null,
    sources: new Map(
      clips.map((clip) => [
        clip.path,
        failing.includes(clip.id) ? { source: null, error: new Error('Unreadable') } : { source: { sourceId: `source-${clip.id}` }, error: null },
      ]),
    ),
  }
}

/** Reviews an export whose native joinability answer found `issues` for the given output IDs (none by default). */
function review({ clips, outputMode = 'combined', exportRange = all, issues = {}, joinability, ...overrides }) {
  const programs = buildExportPrograms({ outputMode, clips, exportRange, transitionDefaults: defaults })
  const answer =
    joinability === undefined
      ? programs.filter(({ program }) => program.pieces.length > 0).map(({ id }) => ({ outputId: id, issues: issues[id] ?? [] }))
      : joinability
  return reviewExport({
    outputMode,
    exportMode: 'composite',
    programs,
    joinability: answer,
    clips,
    skipOverlay: {},
    inspection: inspected(clips),
    sync,
    locale: 'en',
    outputPath: 'C:/renders/joined.mp4',
    ...overrides,
  })
}

const ride = createTestVideo({ id: 'ride', path: '/videos/ride.mp4', durationSeconds: 60 })
const climb = createTestVideo({ id: 'climb', path: '/videos/climb.mp4', durationSeconds: 30, importOrder: 1 })

describe('reviewExport', () => {
  test('combines the program into one output joined by its transitions', () => {
    const clips = clipsOf([ride, climb], { ride: 0, climb: 70 })
    const { outputs, offsets, blockers } = review({ clips, skipOverlay: { climb: true } })
    expect(blockers).toEqual([])
    expect(outputs).toEqual([
      {
        id: 'C:/renders/joined.mp4',
        pieces: [
          { sourceId: 'source-ride', startFrame: 0, endFrame: 1800, skipOverlay: false },
          { sourceId: 'source-climb', startFrame: 0, endFrame: 900, skipOverlay: true },
        ],
        // A 10 s gap is above the continuity threshold.
        transitions: [{ type: 'wipeleft', durationSeconds: 1 }],
        placedSegments: [
          { sourceId: 'source-ride', startSecond: 0, endSecond: 60 },
          { sourceId: 'source-climb', startSecond: 70, endSecond: 100 },
        ],
      },
    ])
    expect(offsets).toEqual({ 'source-ride': 0, 'source-climb': 70 })
    // Transparent output joins with hard cuts.
    expect(review({ clips, exportMode: 'transparent' }).outputs[0].transitions).toEqual([{ type: 'none', durationSeconds: 0 }])
  })

  test('renders separate files joined across their excluded segments', () => {
    const clips = clipsOf([ride, climb], { ride: 0, climb: 30 }, (edits) => {
      Object.assign(
        edits.ride,
        cutEdits([
          { id: 'c1', frame: 300, excluded: true },
          { id: 'c2', frame: 600, transitionIn: { type: 'fade', durationSeconds: 0.5 } },
        ]),
      )
    })
    // Overlapping videos render as separate files without trimming each other.
    const { outputs, blockers } = review({ clips, outputMode: 'separate' })
    expect(blockers).toEqual([])
    expect(outputs.map(({ id, pieces, transitions }) => ({ id, pieces, transitions }))).toEqual([
      {
        id: '/videos/ride.mp4',
        pieces: [
          { sourceId: 'source-ride', startFrame: 0, endFrame: 300, skipOverlay: false },
          { sourceId: 'source-ride', startFrame: 600, endFrame: 1800, skipOverlay: false },
        ],
        transitions: [{ type: 'fade', durationSeconds: 0.5 }],
      },
      { id: '/videos/climb.mp4', pieces: [{ sourceId: 'source-climb', startFrame: 0, endFrame: 900, skipOverlay: false }], transitions: [] },
    ])
    const ranged = review({ clips, outputMode: 'separate', exportRange: { type: 'custom', from: 15, to: 50 } }).outputs
    expect(ranged.map(({ pieces }) => pieces.map(({ startFrame, endFrame }) => [startFrame, endFrame]))).toEqual([[[600, 1500]], [[0, 600]]])
  })

  test('asks the native check about every program with pieces, with hard cuts for transparent output', () => {
    const clips = clipsOf([ride, climb], { ride: 0, climb: 70 }, (edits) => {
      edits.climb.segments.start.excluded = true
    })
    const separate = buildExportPrograms({ outputMode: 'separate', clips, exportRange: all, transitionDefaults: defaults })
    const request = createExportJoinabilityRequest({ programs: separate, clips, exportMode: 'transparent', codec: 'prores_ks' })
    expect(request.outputs.map((output) => output.id)).toEqual(['ride'])
    expect(request).toMatchObject({ exportMode: 'transparent', exportCodec: 'prores_ks' })
    const combined = buildExportPrograms({
      outputMode: 'combined',
      clips: clipsOf([ride, climb], { ride: 0, climb: 70 }),
      exportRange: all,
      transitionDefaults: defaults,
    })
    expect(
      createExportJoinabilityRequest({ programs: combined, clips, exportMode: 'transparent', codec: 'prores_ks' }).outputs[0].transitions,
    ).toEqual([{ type: 'none', durationSeconds: 0 }])
  })

  test('words every native issue and every unavailable video as a reason one combined file cannot be rendered', () => {
    const wide = createTestVideo({ id: 'wide', path: '/videos/wide.mp4', durationSeconds: 30, width: 3840, height: 2160, importOrder: 2 })
    const clips = clipsOf([ride, climb, wide], { ride: 0, climb: 40, wide: 200 })
    const { blockers, outputs } = review({
      clips,
      inspection: inspected(clips, ['climb']),
      issues: {
        combined: [
          { kind: 'overlap', earlierSourceId: 'ride', laterSourceId: 'climb', startSecond: 40, endSecond: 60 },
          { kind: 'incompatible', sourceIds: ['wide'] },
          { kind: 'rotation', sourceIds: ['ride', 'wide'] },
          { kind: 'transitionTooLong', pieceIndex: 1, joinIndices: [0] },
        ],
      },
    })
    expect(outputs).toBeNull()
    expect(blockers).toEqual([
      'Videos overlap (ride.mp4, climb.mp4). Move a video or exclude the overlapping part from export.',
      'Videos differ in resolution or frame rate (wide.mp4). Remove them or export separate files.',
      'Videos are rotated differently (ride.mp4, wide.mp4), which this encoder cannot join into one file. Export separate files.',
      'Some transitions are longer than the video pieces they join.',
      'Some videos cannot be exported (climb.mp4).',
    ])
    expect(review({ clips: clipsOf([ride], { ride: 0 }), exportRange: { type: 'custom', from: 100, to: 120 } }).blockers).toEqual([
      'No video lies inside the export range.',
    ])
  })

  test('a separate file the native check refuses is blocked on its row', () => {
    const clips = clipsOf([ride, climb], { ride: 0, climb: 70 })
    const separate = review({ clips, outputMode: 'separate', issues: { ride: [{ kind: 'transitionTooLong', pieceIndex: 0, joinIndices: [0] }] } })
    expect(separate.rows.find((row) => row.id === 'ride')).toMatchObject({
      status: 'blocked',
      error: 'Some transitions are longer than the video pieces they join.',
    })
    expect(separate.outputs.map((output) => output.id)).toEqual(['/videos/climb.mp4'])
  })

  test('a video excluded as a whole renders nothing and says so', () => {
    const clips = clipsOf([ride, climb], { ride: 0, climb: 70 }, (edits) => {
      edits.climb.segments.start.excluded = true
    })
    const { rows, outputs } = review({ clips, outputMode: 'separate' })
    expect(rows.find((row) => row.id === 'climb')).toMatchObject({ status: 'blocked', error: 'Excluded from export' })
    expect(outputs.map((output) => output.id)).toEqual(['/videos/ride.mp4'])
    expect(review({ clips }).outputs[0].pieces.map((piece) => piece.sourceId)).toEqual(['source-ride'])
  })

  test('builds no outputs while videos are inspected or before the native check answers', () => {
    const clips = clipsOf([ride], { ride: 0 })
    expect(review({ clips, inspection: null }).outputs).toBeNull()
    expect(review({ clips, joinability: null }).outputs).toBeNull()
  })
})
