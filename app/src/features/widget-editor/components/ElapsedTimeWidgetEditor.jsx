/**
 * Supports widget editing flows related to the elapsed time widget editor.
 */

import { useTranslation } from 'react-i18next'
import { translateOptions } from '@/i18n'
import { FontSection, IconSection } from './widgetEditorSections'
import { ELAPSED_TIME_FORMATS, SelectField } from './widgetFormControls'

/**
 * Renders the elapsed time widget editor component.
 *
 * @param {object} props - Component props.
 * @param {*} props.widget - Widget definition being rendered or edited.
 * @param {*} props.updateWidgetData - Value for update widget data.
 * @param {*} props.updateWidgetSize - Live size updater.
 * @param {*} props.commitWidgetSize - Commits a live size update.
 * @param {*} props.setNumericField - Value for set numeric field.
 * @returns {JSX.Element} Rendered component output.
 */
export default function ElapsedTimeWidgetEditor({ widget, updateWidgetData, updateWidgetSize, commitWidgetSize, setNumericField }) {
  const { t } = useTranslation()

  return (
    <>
      <FontSection
        widget={widget}
        updateWidgetData={updateWidgetData}
        updateWidgetSize={updateWidgetSize}
        commitWidgetSize={commitWidgetSize}
        showContentAlignment
      />
      <SelectField
        label={t('widget-editor.elapsedTimeFormat', 'Time Display')}
        value={widget.data.format}
        onValueChange={(value) => updateWidgetData(widget.id, { format: value })}
        options={translateOptions(ELAPSED_TIME_FORMATS, t)}
      />
      <IconSection
        widget={widget}
        updateWidgetData={updateWidgetData}
        updateWidgetSize={updateWidgetSize}
        commitWidgetSize={commitWidgetSize}
        setNumericField={setNumericField}
      />
    </>
  )
}
