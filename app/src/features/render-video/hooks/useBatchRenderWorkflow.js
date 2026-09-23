/**
 * Batch render workflow — imports videos from a folder one at a time into the
 * existing single-video import/sync pipeline, then renders each sequentially
 * into a shared output folder using the current template and render settings.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as backend from '@/api/backend'
import { DEFAULT_EXPORT_RANGE } from '@/lib/template/template-constants'
import { openDirectoryPath } from '@/lib/file-dialog'
import { normalizeUpdateRateForFps, getUpdateRateOptions } from '@/lib/update-rate'
import { pathInDirectory } from '@/lib/utils'
import { useFpsMode } from '@/hooks/useFpsMode'
import useStore from '@/store/useStore'
import { resolveVideoSyncState } from '@/store/slices/createVideoImportSlice'
import useVideoImport, { prepareVideoPath } from '@/features/video-preview/hooks/useVideoImport'
import { OUTPUT_FORMATS, OUTPUT_FORMATS_BY_VALUE } from '../data/renderConstants'
import { getDefaultBitrate } from '../data/bitrateDefaults'
import { getRenderOutputExtension } from '../utils/render-output'
import {
  getAccelerationValueForSettings,
  getExportCodecForSelection,
  getFirstAvailableAcceleration,
  getFirstAvailableMp4ExportCodec,
  getOutputFormatForExportCodec,
  getVisibleAccelerationOptions,
  isMp4Codec,
} from '../utils/codecUtils'

function outputFilenameFor(filename, exportMode) {
  const stem = filename.replace(/\.[^.]*$/, '')
  return `${stem}.${getRenderOutputExtension(exportMode)}`
}

function waitForRenderCompletion(renderId) {
  return new Promise((resolve, reject) => {
    let unlisten = null
    let settled = false

    const finish = (fn) => {
      if (settled) return
      settled = true
      if (unlisten) unlisten()
      fn()
    }

    const handle = (data) => {
      if (data.render_id !== renderId) return
      if (data.status === 'complete') finish(() => resolve(data))
      else if (data.status === 'cancelled') finish(() => reject(Object.assign(new Error('Render cancelled'), { code: 'cancelled' })))
      else if (data.status === 'error') finish(() => reject(new Error(data.message || 'Render failed')))
    }

    backend
      .subscribeRenderProgress(handle)
      .then((un) => {
        unlisten = un
      })
      .catch((error) => finish(() => reject(error)))

    backend
      .getRenderProgress()
      .then(handle)
      .catch(() => {})
  })
}

/**
 * Provides batch-render queue actions and sequential render orchestration.
 * @returns {object} Batch render workflow API.
 */
export default function useBatchRenderWorkflow() {
  const batchDialogOpen = useStore((state) => state.batchDialogOpen)
  const openBatchDialog = useStore((state) => state.openBatchDialog)
  const closeBatchDialog = useStore((state) => state.closeBatchDialog)
  const batchVideoFolder = useStore((state) => state.batchVideoFolder)
  const batchOutputFolder = useStore((state) => state.batchOutputFolder)
  const batchQueue = useStore((state) => state.batchQueue)
  const batchRunning = useStore((state) => state.batchRunning)
  const batchActiveItemId = useStore((state) => state.batchActiveItemId)
  const setBatchVideoFolder = useStore((state) => state.setBatchVideoFolder)
  const setBatchOutputFolder = useStore((state) => state.setBatchOutputFolder)
  const setBatchQueueFromPaths = useStore((state) => state.setBatchQueueFromPaths)
  const removeBatchQueueItem = useStore((state) => state.removeBatchQueueItem)
  const clearBatchQueue = useStore((state) => state.clearBatchQueue)
  const setBatchItemSkipOverlay = useStore((state) => state.setBatchItemSkipOverlay)
  const setBatchItemStatus = useStore((state) => state.setBatchItemStatus)
  const setBatchRunning = useStore((state) => state.setBatchRunning)
  const setBatchActiveItemId = useStore((state) => state.setBatchActiveItemId)
  const setErrorMessage = useStore((state) => state.setErrorMessage)
  const renderSettings = useStore((state) => state.renderSettings)
  const setRenderSettings = useStore((state) => state.setRenderSettings)
  const availableCodecs = useStore((state) => state.availableCodecs)
  const platformOs = useStore((state) => state.platformOs)
  const config = useStore((state) => state.config)
  const importedVideoResolution = useStore((state) => state.importedVideoResolution)

  const { loadVideoPath, clearImportedVideo } = useVideoImport({})
  const [currentItemProgress, setCurrentItemProgress] = useState(null)
  const cancelRequestedRef = useRef(false)
  const resolutionWidth = importedVideoResolution?.width || config?.scene?.width
  const resolutionHeight = importedVideoResolution?.height || config?.scene?.height
  const exportMode = renderSettings.exportMode || 'composite'
  const isCompositeExport = exportMode === 'composite'

  // Codec selection follows the active export pipeline, same as the single
  // render dialog: composite exports must land on an MP4 codec, transparent
  // exports must not.
  useEffect(() => {
    if (!batchDialogOpen) return
    const codecIsMp4 = isMp4Codec(renderSettings.codec)

    if (isCompositeExport && !codecIsMp4) {
      const fallbackCodec = getFirstAvailableMp4ExportCodec(platformOs, availableCodecs)
      if (!fallbackCodec) return
      setRenderSettings({
        ...renderSettings,
        codec: fallbackCodec,
        bitrateMbps: getDefaultBitrate(resolutionWidth, resolutionHeight, renderSettings.fps, fallbackCodec),
      })
      return
    }

    if (!isCompositeExport && codecIsMp4) {
      setRenderSettings({ ...renderSettings, codec: 'prores_ks', bitrateMbps: null })
    }
  }, [availableCodecs, batchDialogOpen, isCompositeExport, platformOs, renderSettings, resolutionHeight, resolutionWidth, setRenderSettings])

  const outputFormatOptions = useMemo(
    () => OUTPUT_FORMATS.filter((format) => format.group === (isCompositeExport ? 'mp4' : 'transparent')),
    [isCompositeExport],
  )
  const selectedOutputFormatValue = getOutputFormatForExportCodec(renderSettings.codec)?.value || (isCompositeExport ? 'h264' : 'prores')
  const selectedAccelerationValue = getAccelerationValueForSettings({ exportCodec: renderSettings.codec })
  const selectedAccelerationOptions = useMemo(
    () => getVisibleAccelerationOptions(OUTPUT_FORMATS_BY_VALUE[selectedOutputFormatValue], platformOs, availableCodecs),
    [availableCodecs, platformOs, selectedOutputFormatValue],
  )
  const updateRateOptions = useMemo(() => getUpdateRateOptions(renderSettings.fps), [renderSettings.fps])

  const handleFormatChange = useCallback(
    (formatValue) => {
      const format = OUTPUT_FORMATS_BY_VALUE[formatValue]
      const acceleration = getFirstAvailableAcceleration(format, platformOs, availableCodecs)
      const codec = acceleration ? getExportCodecForSelection(formatValue, acceleration.value) : format.codecs.cpu
      const nextIsMp4Codec = format.group === 'mp4'
      setRenderSettings({
        ...renderSettings,
        codec,
        bitrateMbps: nextIsMp4Codec ? getDefaultBitrate(resolutionWidth, resolutionHeight, renderSettings.fps, codec) : null,
      })
    },
    [availableCodecs, platformOs, renderSettings, resolutionHeight, resolutionWidth, setRenderSettings],
  )

  const handleAccelerationChange = useCallback(
    (accelerationValue) => {
      const codec = getExportCodecForSelection(selectedOutputFormatValue, accelerationValue)
      if (!codec) return
      setRenderSettings({ ...renderSettings, codec })
    },
    [renderSettings, selectedOutputFormatValue, setRenderSettings],
  )

  const handleBitrateChange = useCallback(
    (value) => setRenderSettings({ ...renderSettings, bitrateMbps: value }),
    [renderSettings, setRenderSettings],
  )

  const handleUpdateRateChange = useCallback(
    (value) => setRenderSettings({ ...renderSettings, widgetUpdateRate: value }),
    [renderSettings, setRenderSettings],
  )

  const handleExportModeChange = useCallback(
    (nextExportMode) => setRenderSettings({ ...renderSettings, exportMode: nextExportMode }),
    [renderSettings, setRenderSettings],
  )

  const { fpsMode, handleFpsModeChange, handleCustomFpsChange } = useFpsMode({
    fps: renderSettings.fps,
    onFpsChange: (fps) =>
      setRenderSettings({ ...renderSettings, fps, widgetUpdateRate: normalizeUpdateRateForFps(fps, renderSettings.widgetUpdateRate) }),
  })

  // Probes each queued video's creation time against the loaded activity so
  // the per-item overlay toggle defaults correctly without a manual render.
  const detectQueueOverlaps = useCallback(
    async (paths) => {
      const activitySummary = useStore.getState().activitySummary
      if (!activitySummary) return

      for (const path of paths) {
        const item = useStore.getState().batchQueue.find((candidate) => candidate.path === path)
        if (!item) continue

        setBatchItemStatus(item.id, 'checking')
        try {
          const { importedVideoState } = await prepareVideoPath(path)
          const { videoSyncWarning } = resolveVideoSyncState(importedVideoState, activitySummary)
          setBatchItemSkipOverlay(item.id, videoSyncWarning !== null)
        } catch (error) {
          console.warn(`Could not determine activity overlap for ${path}:`, error)
        } finally {
          setBatchItemStatus(item.id, 'pending')
        }
      }
    },
    [setBatchItemSkipOverlay, setBatchItemStatus],
  )

  const pickVideoFolder = useCallback(async () => {
    const directory = await openDirectoryPath({ lastDirectoryKey: 'last-batch-video-dir' })
    if (!directory) return
    const paths = await backend.listDirectoryVideoFiles(directory)
    setBatchVideoFolder(directory)
    setBatchQueueFromPaths(paths)
    void detectQueueOverlaps(paths)
  }, [detectQueueOverlaps, setBatchQueueFromPaths, setBatchVideoFolder])

  const pickOutputFolder = useCallback(async () => {
    const directory = await openDirectoryPath({ lastDirectoryKey: 'last-batch-output-dir' })
    if (!directory) return
    setBatchOutputFolder(directory)
  }, [setBatchOutputFolder])

  const renderQueueItem = useCallback(
    async (item) => {
      setBatchActiveItemId(item.id)
      setBatchItemStatus(item.id, 'importing')
      setCurrentItemProgress(null)
      await loadVideoPath(item.path)

      const state = useStore.getState()
      if (!state.parsedActivity) {
        throw new Error('No activity is loaded')
      }
      if (!state.config?.scene) {
        throw new Error('No template is loaded')
      }

      const itemExportMode = state.renderSettings.exportMode || 'composite'
      const shouldComposite = itemExportMode === 'composite'
      const effectiveConfig = item.skipOverlay ? { ...state.config, values: [], plots: [] } : state.config
      const outputPath = pathInDirectory(batchOutputFolder, outputFilenameFor(item.filename, itemExportMode))
      const updateRate = normalizeUpdateRateForFps(state.importedVideoFps, state.renderSettings.widgetUpdateRate)

      setBatchItemStatus(item.id, 'rendering')
      const { default: submitRenderVideo } = await import('@/features/render-video/utils/render-video')
      const result = await submitRenderVideo({
        config: effectiveConfig,
        exportMode: itemExportMode,
        exportCodec: state.renderSettings.codec,
        exportBitrate: state.renderSettings.bitrateMbps ?? undefined,
        exportRange: DEFAULT_EXPORT_RANGE,
        updateRate,
        availableCodecs: state.availableCodecs,
        globalDefaults: state.globalDefaults,
        importedVideoDuration: state.importedVideoDuration,
        importedVideoFps: state.importedVideoFps,
        importedVideoFpsNum: state.importedVideoFpsNum,
        importedVideoFpsDen: state.importedVideoFpsDen,
        importedVideoPath: shouldComposite ? state.importedVideoPath : null,
        importedVideoResolution: state.importedVideoResolution,
        parsedActivity: state.parsedActivity,
        startSecond: state.startSecond,
        endSecond: state.endSecond,
        videoSyncOffsetSeconds: state.videoSyncOffsetSeconds,
        outputPath,
        overwrite: true,
      })

      let unlisten = null
      backend
        .subscribeRenderProgress((data) => {
          if (data.render_id === result.render_id) setCurrentItemProgress(data)
        })
        .then((un) => {
          unlisten = un
        })
        .catch(() => {})

      try {
        await waitForRenderCompletion(result.render_id)
        setBatchItemStatus(item.id, 'done')
      } finally {
        if (unlisten) unlisten()
        setCurrentItemProgress(null)
      }
    },
    [batchOutputFolder, loadVideoPath, setBatchActiveItemId, setBatchItemStatus],
  )

  const runBatch = useCallback(async () => {
    if (!batchOutputFolder) {
      setErrorMessage('Select a batch output folder first')
      return
    }
    if (batchQueue.length === 0) return

    cancelRequestedRef.current = false
    setBatchRunning(true)
    try {
      for (const item of batchQueue) {
        if (cancelRequestedRef.current) {
          setBatchItemStatus(item.id, 'pending')
          continue
        }
        try {
          await renderQueueItem(item)
        } catch (error) {
          setBatchItemStatus(item.id, error?.code === 'cancelled' ? 'cancelled' : 'error', error?.message || 'Render failed')
          if (error?.code === 'cancelled') cancelRequestedRef.current = true
        }
      }
    } finally {
      setBatchActiveItemId(null)
      setBatchRunning(false)
      try {
        await clearImportedVideo()
      } catch {
        // best-effort cleanup
      }
    }
  }, [batchOutputFolder, batchQueue, clearImportedVideo, renderQueueItem, setBatchActiveItemId, setBatchItemStatus, setBatchRunning, setErrorMessage])

  const cancelBatch = useCallback(async () => {
    cancelRequestedRef.current = true
    try {
      await backend.cancelRender()
    } catch (error) {
      console.error('Failed to cancel batch render:', error)
    }
  }, [])

  return {
    batchDialogOpen,
    openBatchDialog,
    closeBatchDialog,
    batchVideoFolder,
    batchOutputFolder,
    batchQueue,
    batchRunning,
    batchActiveItemId,
    currentItemProgress,
    pickVideoFolder,
    pickOutputFolder,
    removeBatchQueueItem,
    clearBatchQueue,
    setBatchItemSkipOverlay,
    runBatch,
    cancelBatch,
    renderSettings,
    exportMode,
    isCompositeExport,
    outputFormatOptions,
    selectedOutputFormatValue,
    selectedAccelerationValue,
    selectedAccelerationOptions,
    updateRateOptions,
    handleFormatChange,
    handleAccelerationChange,
    handleBitrateChange,
    handleUpdateRateChange,
    handleExportModeChange,
    fpsMode,
    handleFpsModeChange,
    handleCustomFpsChange,
  }
}
