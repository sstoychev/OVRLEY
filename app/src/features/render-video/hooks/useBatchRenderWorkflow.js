/**
 * Batch render workflow — imports videos from a folder one at a time into the
 * existing single-video import/sync pipeline, then renders each sequentially
 * into a shared output folder using the current template and render settings.
 */

import { useCallback, useRef, useState } from 'react'
import * as backend from '@/api/backend'
import { DEFAULT_EXPORT_RANGE } from '@/lib/template/template-constants'
import { openDirectoryPath } from '@/lib/file-dialog'
import { pathInDirectory } from '@/lib/utils'
import useStore from '@/store/useStore'
import useVideoImport from '@/features/video-preview/hooks/useVideoImport'

function outputFilenameFor(filename) {
  const stem = filename.replace(/\.[^.]*$/, '')
  return `${stem}.mp4`
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

  const { loadVideoPath, clearImportedVideo } = useVideoImport({})
  const [currentItemProgress, setCurrentItemProgress] = useState(null)
  const cancelRequestedRef = useRef(false)

  const pickVideoFolder = useCallback(async () => {
    const directory = await openDirectoryPath({ lastDirectoryKey: 'last-batch-video-dir' })
    if (!directory) return
    const paths = await backend.listDirectoryVideoFiles(directory)
    setBatchVideoFolder(directory)
    setBatchQueueFromPaths(paths)
  }, [setBatchQueueFromPaths, setBatchVideoFolder])

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

      const effectiveConfig = item.skipOverlay ? { ...state.config, values: [], plots: [] } : state.config
      const outputPath = pathInDirectory(batchOutputFolder, outputFilenameFor(item.filename))

      setBatchItemStatus(item.id, 'rendering')
      const { default: submitRenderVideo } = await import('@/features/render-video/utils/render-video')
      const result = await submitRenderVideo({
        config: effectiveConfig,
        exportMode: 'composite',
        exportCodec: state.renderSettings.codec,
        exportBitrate: state.renderSettings.bitrateMbps ?? undefined,
        exportRange: DEFAULT_EXPORT_RANGE,
        updateRate: state.renderSettings.widgetUpdateRate,
        availableCodecs: state.availableCodecs,
        globalDefaults: state.globalDefaults,
        importedVideoDuration: state.importedVideoDuration,
        importedVideoFps: state.importedVideoFps,
        importedVideoFpsNum: state.importedVideoFpsNum,
        importedVideoFpsDen: state.importedVideoFpsDen,
        importedVideoPath: state.importedVideoPath,
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
  }
}
