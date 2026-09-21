/**
 * Batch render dialog — pick a folder of videos and an output folder, toggle
 * whether each video should include the activity-data overlay, then render
 * every queued video sequentially using the current template and render
 * settings.
 */

import { CheckCircle2, FolderOpen, Loader2, Play, Square, Trash2, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import useBatchRenderWorkflow from '../hooks/useBatchRenderWorkflow'
import { useTranslation } from 'react-i18next'

function StatusIcon({ status }) {
  if (status === 'done') return <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
  if (status === 'error') return <XCircle className="h-4 w-4 shrink-0 text-red-500" />
  if (status === 'cancelled') return <Square className="h-4 w-4 shrink-0 text-muted-foreground" />
  if (status === 'importing' || status === 'rendering') return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
  return <span className="h-4 w-4 shrink-0" />
}

/**
 * Renders the batch render dialog.
 * @returns {JSX.Element} Rendered component output.
 */
export default function BatchRenderDialog() {
  const { t } = useTranslation()
  const {
    batchDialogOpen,
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
    mp4OutputFormats,
    selectedOutputFormatValue,
    selectedAccelerationValue,
    selectedAccelerationOptions,
    updateRateOptions,
    handleFormatChange,
    handleAccelerationChange,
    handleBitrateChange,
    handleUpdateRateChange,
  } = useBatchRenderWorkflow()

  const canRun = batchQueue.length > 0 && Boolean(batchOutputFolder) && !batchRunning

  return (
    <Dialog open={batchDialogOpen} onOpenChange={(open) => !open && !batchRunning && closeBatchDialog()}>
      <DialogContent
        overlayClassName="absolute inset-0 z-120 flex items-center justify-center bg-surface-overlay/82 px-4 backdrop-blur-md"
        className="w-full max-w-xl rounded-sm border border-accent-border/80 bg-card/95 p-6 shadow-2xl shadow-background/50"
        aria-describedby={undefined}
        onEscapeKeyDown={(event) => batchRunning && event.preventDefault()}
        onPointerDownOutside={(event) => batchRunning && event.preventDefault()}
      >
        <DialogTitle className="text-sm font-semibold text-foreground">{t('render-video.batchRender', 'Batch Render')}</DialogTitle>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                {t('render-video.videoFolder', 'Video folder')}
              </Label>
              <Button
                type="button"
                variant="outline"
                className="h-9 w-full justify-start gap-2 border-border/80 bg-surface-elevated text-xs text-foreground shadow-xs hover:bg-surface-strong"
                onClick={pickVideoFolder}
                disabled={batchRunning}
              >
                <FolderOpen className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{batchVideoFolder || t('render-video.chooseFolder', 'Choose folder...')}</span>
              </Button>
            </div>
            <div className="space-y-2">
              <Label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                {t('render-video.outputFolder', 'Output folder')}
              </Label>
              <Button
                type="button"
                variant="outline"
                className="h-9 w-full justify-start gap-2 border-border/80 bg-surface-elevated text-xs text-foreground shadow-xs hover:bg-surface-strong"
                onClick={pickOutputFolder}
                disabled={batchRunning}
              >
                <FolderOpen className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{batchOutputFolder || t('render-video.chooseFolder', 'Choose folder...')}</span>
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                {t('render-video.codecOutputFormat', 'Codec / Output Format')}
              </Label>
              <Select value={selectedOutputFormatValue} onValueChange={handleFormatChange} disabled={batchRunning}>
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {mp4OutputFormats.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                {t('render-video.hardwareAcceleration', 'Hardware Acceleration')}
              </Label>
              <Select value={selectedAccelerationValue} onValueChange={handleAccelerationChange} disabled={batchRunning}>
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {selectedAccelerationOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value} disabled={!option.available}>
                      <span className="flex w-full items-center justify-between gap-3">
                        <span className="min-w-0 truncate">{option.label}</span>
                        {!option.available && (
                          <span className="shrink-0 text-right text-[10px] text-muted-foreground">
                            {t('render-video.unavailable', 'Unavailable')}
                          </span>
                        )}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">{t('render-video.bitrate', 'Bitrate')}</Label>
              <span className="rounded bg-surface-strong px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                {renderSettings.bitrateMbps ?? 20} Mbps
              </span>
            </div>
            <Slider
              min={5}
              max={100}
              step={5}
              value={[renderSettings.bitrateMbps ?? 20]}
              onValueChange={([value]) => handleBitrateChange(value)}
              disabled={batchRunning}
            />
          </div>

          <div className="space-y-2">
            <Label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              {t('render-video.widgetUpdateRate', 'Widget Update Rate')}
            </Label>
            <Tabs value={renderSettings.widgetUpdateRate.toString()} onValueChange={(value) => handleUpdateRateChange(parseInt(value, 10))}>
              <TabsList
                className="grid h-8 w-full bg-surface p-0.5"
                style={{ gridTemplateColumns: `repeat(${updateRateOptions.length}, minmax(0, 1fr))` }}
              >
                {updateRateOptions.map((rate) => (
                  <TabsTrigger key={rate} value={rate.toString()} className="text-[10px]" disabled={batchRunning}>
                    1/{rate}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>

          <div className="max-h-80 space-y-1 overflow-y-auto rounded-sm border border-border/70 bg-surface p-2">
            {batchQueue.length === 0 ? (
              <p className="p-4 text-center text-xs text-muted-foreground">
                {t('render-video.noVideosQueued', 'Choose a video folder to queue videos for batch rendering.')}
              </p>
            ) : (
              batchQueue.map((item) => {
                const isActive = item.id === batchActiveItemId
                return (
                  <div key={item.id} className="flex items-center gap-3 rounded-sm px-2 py-2 hover:bg-surface-elevated">
                    <StatusIcon status={item.status} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium text-foreground">{item.filename}</p>
                      {item.status === 'error' && item.error ? <p className="truncate text-[10px] text-red-500">{item.error}</p> : null}
                      {isActive && currentItemProgress ? (
                        <Progress
                          value={
                            currentItemProgress.current && currentItemProgress.total
                              ? (currentItemProgress.current / currentItemProgress.total) * 100
                              : 0
                          }
                          className="mt-1 h-1"
                        />
                      ) : null}
                    </div>
                    <Label className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                      {t('render-video.activityOverlay', 'Activity overlay')}
                      <Switch
                        checked={!item.skipOverlay}
                        onCheckedChange={(checked) => setBatchItemSkipOverlay(item.id, !checked)}
                        disabled={batchRunning}
                      />
                    </Label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-red-500"
                      onClick={() => removeBatchQueueItem(item.id)}
                      disabled={batchRunning}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )
              })
            )}
          </div>

          <div className="flex items-center justify-between gap-3 pt-2">
            <Button
              type="button"
              variant="outline"
              className="border-border/80 bg-surface-elevated text-foreground shadow-xs hover:bg-surface-strong hover:text-foreground"
              onClick={clearBatchQueue}
              disabled={batchRunning || batchQueue.length === 0}
            >
              {t('render-video.clearQueue', 'Clear queue')}
            </Button>
            <div className="flex items-center gap-3">
              <Button
                type="button"
                variant="outline"
                className="border-border/80 bg-surface-elevated text-foreground shadow-xs hover:bg-surface-strong hover:text-foreground"
                onClick={() => (batchRunning ? cancelBatch() : closeBatchDialog())}
              >
                {batchRunning ? t('render-video.cancel', 'Cancel') : t('render-video.close', 'Close')}
              </Button>
              <Button type="button" className="bg-primary text-primary-foreground hover:bg-primary/90" onClick={runBatch} disabled={!canRun}>
                {batchRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                {batchRunning ? t('render-video.rendering', 'Rendering...') : t('render-video.startBatchRender', 'Start Batch Render')}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
