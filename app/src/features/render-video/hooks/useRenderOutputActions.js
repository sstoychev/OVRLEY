import { useMemo } from 'react'
import * as backend from '@/api/backend'
import useStore from '@/store/useStore'
import { directoryFromSelectedPath } from '@/lib/file-dialog'

function openWithSystem(open) {
  void open().catch((error) => useStore.getState().setErrorMessage(error.message))
}

/**
 * Opens what a finished render wrote, with the system's default application.
 * @param {string[]} outputPaths Files the finished render wrote (see `listRenderedOutputPaths`).
 * @returns {{openOutput: function(string): void, openOutputFile: function|null, openOutputFolder: function|null}}
 *   Opens one written file; opens the only written file (null unless exactly one); opens the folder they were written to (null without files).
 */
export default function useRenderOutputActions(outputPaths) {
  return useMemo(() => {
    const openOutput = (path) => openWithSystem(() => backend.openVideo(path))
    return {
      openOutput,
      openOutputFile: outputPaths.length === 1 ? () => openOutput(outputPaths[0]) : null,
      openOutputFolder:
        outputPaths.length > 0 ? () => openWithSystem(() => backend.openOutputDirectory(directoryFromSelectedPath(outputPaths[0]))) : null,
    }
  }, [outputPaths])
}
