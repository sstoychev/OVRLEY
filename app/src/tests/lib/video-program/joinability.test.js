import { describe, expect, test } from 'vite-plus/test'
import { createProgramJoinabilityRequest, listSourceOverlaps, listTooLongJoinKeys } from '@/lib/video-program/joinability'
import { buildTimelineProgram } from '@/lib/video-program/timeline'
import { DEFAULT_TRANSITION_SETTINGS } from '@/lib/video-program/transition-catalog'
import { createTestVideo, videoStoreState } from '@/tests/helpers/videoFixtures'

const renderSettings = { exportMode: 'transparent', codec: 'prores_ks' }

function timeline(videos, offsets, edit = () => {}) {
  const { importedVideos, videoEdits } = videoStoreState(videos, offsets)
  edit(videoEdits)
  return buildTimelineProgram({ videos: importedVideos, videoEdits, dragPreview: null, transitionDefaults: DEFAULT_TRANSITION_SETTINGS })
}

const a = createTestVideo({ id: 'a', path: '/videos/a.mp4', durationSeconds: 30 })
const b = createTestVideo({ id: 'b', path: '/videos/b.mp4', durationSeconds: 30, rotationDegrees: 90, width: 1080, height: 1920, importOrder: 1 })
const c = createTestVideo({ id: 'c', path: '/videos/c.mp4', durationSeconds: 30, importOrder: 2 })

describe('createProgramJoinabilityRequest', () => {
  test('sends the placements before overlaps are trimmed, without excluded videos, and with the joins as edited', () => {
    const { clips, program } = timeline([a, b, c], { a: 0, b: 20, c: 100 }, (edits) => {
      edits.b.segments.start.transitionIn = { type: 'fade', durationSeconds: 0.5 }
      edits.c.segments.start.excluded = true
    })
    const request = createProgramJoinabilityRequest({ clips, program, renderSettings })

    expect(request.exportMode).toBe('transparent')
    expect(request.exportCodec).toBe('prores_ks')
    expect(request.sources.find((source) => source.id === 'b')).toEqual({
      id: 'b',
      resolution: { width: 1920, height: 1080 },
      fps: { num: 30, den: 1 },
      rotationDegrees: 90,
    })
    const [output] = request.outputs
    // Playback trims b where a still plays; the native check sees where b was placed.
    expect(output.pieces.map(({ sourceId, startFrame, endFrame }) => [sourceId, startFrame, endFrame])).toEqual([
      ['a', 0, 900],
      ['b', 300, 900],
    ])
    expect(output.placedSegments).toEqual([
      { sourceId: 'a', startSecond: 0, endSecond: 30 },
      { sourceId: 'b', startSecond: 20, endSecond: 50 },
    ])
    // The timeline is checked with its transitions even when the export would cut hard.
    expect(output.transitions).toEqual([{ type: 'fade', durationSeconds: 0.5 }])
  })

  test('there is nothing to check without pieces', () => {
    const { clips, program } = timeline([a], { a: 0 }, (edits) => {
      edits.a.segments.start.excluded = true
    })
    expect(createProgramJoinabilityRequest({ clips, program, renderSettings })).toBeNull()
  })
})

describe('joinability issues', () => {
  test('name the joins and overlaps they refer to', () => {
    const { program } = timeline([a, c], { a: 0, c: 40 })
    expect(listTooLongJoinKeys(program, [{ kind: 'transitionTooLong', pieceIndex: 1, joinIndices: [0] }])).toEqual(new Set(['c:start']))
    const issues = [{ kind: 'overlap', earlierSourceId: 'a', laterSourceId: 'c', startSecond: 40, endSecond: 42.5 }]
    expect(listSourceOverlaps(issues, 'c')).toEqual([{ otherSourceId: 'a', seconds: 2.5 }])
    expect(listSourceOverlaps(issues, 'b')).toEqual([])
  })
})
