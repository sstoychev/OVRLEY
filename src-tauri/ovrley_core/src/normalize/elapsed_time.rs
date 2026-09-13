//! Elapsed/remaining activity-time value validation.
//!
//! `validate_elapsed_time_value` verifies that every output-affecting elapsed
//! time widget field is explicit. Missing fields are rejected — the backend
//! owns zero render-affecting defaults. The frontend must materialise all
//! defaults before sending the config.
//!
//! Unlike the clock-of-day `time` widget, this widget's elapsed/remaining/
//! total text is derived from the full source activity's duration and the
//! render scene's absolute offset within that activity — never from the
//! duration of the video file currently being rendered.

use super::helpers::{require_bool, require_f32, require_str, require_string, rgba_from_hex};
use super::raw::ValueConfig;
use super::value::validate_content_alignment;
use crate::error::{CoreError, CoreResult};
use crate::normalize::{ValidatedValueFormatting, ValidatedValueWidget};
use crate::types::DisplayType;
use crate::MetricKind;

/// Explicit text layout for a validated elapsed-time value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ElapsedTimeFormat {
    /// Elapsed time since the start of the full activity.
    Elapsed,
    /// Time remaining until the end of the full activity, shown with a
    /// leading minus sign.
    Remaining,
    /// `elapsed/total` — total is the full activity duration.
    ElapsedOverTotal,
    /// `elapsed/-remaining`.
    ElapsedOverRemaining,
}

impl ElapsedTimeFormat {
    fn from_key(key: &str, field: &str) -> CoreResult<Self> {
        match key {
            "elapsed" => Ok(Self::Elapsed),
            "remaining" => Ok(Self::Remaining),
            "elapsed_total" => Ok(Self::ElapsedOverTotal),
            "elapsed_remaining" => Ok(Self::ElapsedOverRemaining),
            other => Err(CoreError::Config(format!(
                "{field}: unknown elapsed time format '{other}'"
            ))),
        }
    }
}

/// Every output-affecting field for an elapsed-time text widget is explicit.
#[derive(Clone, Debug)]
pub struct ValidatedElapsedTimeValue {
    pub base: ValidatedValueWidget,
    pub format: ElapsedTimeFormat,
}

pub fn validate_elapsed_time_value(
    value: ValueConfig,
    index: usize,
) -> CoreResult<ValidatedElapsedTimeValue> {
    let p = |field: &str| format!("values[{index}].{field}");

    if value.value != MetricKind::ElapsedTime {
        return Err(CoreError::Config(format!(
            "{}: expected ElapsedTime, got {:?}",
            p("value"),
            value.value
        )));
    }

    if value.display_type != DisplayType::Text {
        return Err(CoreError::Config(format!(
            "{}: display_type '{}' is outside the elapsed time text validation slice",
            p("display_type"),
            value.display_type.as_str()
        )));
    }

    let font_name = require_string(value.font, &p("font"))?;
    let content_alignment =
        validate_content_alignment(value.content_alignment, &p("content_alignment"))?;
    let opacity = require_f32(value.opacity, &p("opacity"))?;
    if !(0.0..=1.0).contains(&opacity) {
        return Err(CoreError::Config(format!(
            "{}: must be 0.0..1.0, got {opacity}",
            p("opacity")
        )));
    }

    let font_size = require_f32(value.font_size, &p("font_size"))?;
    if font_size <= 0.0 {
        return Err(CoreError::Config(format!(
            "{}: must be > 0, got {font_size}",
            p("font_size")
        )));
    }

    let color = rgba_from_hex(
        require_str(value.color.as_deref(), &p("color"))?,
        &p("color"),
        opacity,
    )?;

    let show_icon = require_bool(value.show_icon, &p("show_icon"))?;
    let icon_color = rgba_from_hex(
        require_str(value.icon_color.as_deref(), &p("icon_color"))?,
        &p("icon_color"),
        opacity,
    )?;
    let icon_size = require_f32(value.icon_size, &p("icon_size"))?;
    if icon_size < 0.0 {
        return Err(CoreError::Config(format!(
            "{}: must be >= 0, got {icon_size}",
            p("icon_size")
        )));
    }
    let icon_offset_x = require_f32(value.icon_offset_x, &p("icon_offset_x"))?;
    let icon_offset_y = require_f32(value.icon_offset_y, &p("icon_offset_y"))?;

    let prefix = require_string(value.prefix, &p("prefix"))?;
    let suffix = require_string(value.suffix, &p("suffix"))?;

    let format_key = require_string(value.format, &p("format"))?;
    let format = ElapsedTimeFormat::from_key(&format_key, &p("format"))?;

    Ok(ValidatedElapsedTimeValue {
        base: ValidatedValueWidget {
            metric: MetricKind::ElapsedTime,
            x: value.x,
            y: value.y,
            display_type: value.display_type,
            content_alignment,
            font_name,
            font_size,
            color,
            opacity,
            show_icon,
            icon_color,
            icon_size,
            icon_offset_x,
            icon_offset_y,
            show_units: false,
            show_full_distance: None,
            show_full_ascent: None,
            coordinate_format: None,
            unit_color: color,
            display_unit: String::new(),
            starting_altitude_m: None,
            prefix,
            suffix,
            formatting: ValidatedValueFormatting::DecimalPlaces { decimals: 0 },
            hours_offset: None,
            format: Some(format_key),
        },
        format,
    })
}
