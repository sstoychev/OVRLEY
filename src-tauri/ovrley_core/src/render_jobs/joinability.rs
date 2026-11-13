//! Whether the pieces of one output can be joined into one file. One rule set
//! serves the editor (timeline warnings, transition marks, the import and render
//! dialogs, through [`check_joinability`]) and the planner, which refuses an
//! output that breaks it.
//!
//! The rules: placed segments must not overlap by half a frame or more; every
//! source shares one display resolution and frame rate; an encoder that keeps the
//! display rotation joins sources of one rotation only; and the transitions around
//! a piece leave at least one of its frames untouched.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use super::contracts::{BatchExportMode, BatchPlacedSegment, BatchRenderOutput, BatchTransition};
use crate::encode::ffmpeg::catalog::{CodecSelection, CompositeFilterStackKind};
use crate::encode::ffmpeg::transitions::{is_xfade_transition, NO_TRANSITION};
use crate::encode::fps::Fps;
use crate::error::{CoreError, CoreResult};
use crate::media::source_video_metadata::Resolution;

/// What the rules compare of a source: display geometry, exact frame rate and
/// display rotation (0, 90, 180 or 270 degrees).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct JoinSource {
    pub width: u64,
    pub height: u64,
    pub fps: Fps,
    pub rotation_degrees: i32,
}

/// Encoder rules of an output.
#[derive(Clone, Copy, Debug)]
pub(crate) struct JoinRules {
    /// The encoder keeps the source's display rotation, one per file.
    pub keeps_display_rotation: bool,
}

impl JoinRules {
    pub(crate) fn for_codec(codec: CodecSelection) -> Self {
        Self {
            keeps_display_rotation: matches!(codec, CodecSelection::Composite(id)
                if id.metadata().filter_stack_kind == CompositeFilterStackKind::QsvFullOverlay),
        }
    }
}

/// One reason an output cannot be joined into one file.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum JoinIssue {
    /// A placed segment starts half a frame (of its own rate) or more before the
    /// latest end of the segments placed before it.
    Overlap {
        earlier_source_id: String,
        later_source_id: String,
        start_second: f64,
        end_second: f64,
    },
    /// Sources outside the largest group of one display resolution and frame
    /// rate; a tie goes to the group met first in timeline order.
    Incompatible { source_ids: Vec<String> },
    /// The first placed source, then the sources rotated differently from it.
    Rotation { source_ids: Vec<String> },
    /// A piece whose incoming and outgoing transitions leave none of its frames
    /// untouched; `join_indices` are the transitions that touch it.
    TransitionTooLong {
        piece_index: usize,
        join_indices: Vec<usize>,
    },
}

/// The joinability of one output, with the frames of each transition on the
/// first piece's frame grid (None for a hard cut).
#[derive(Debug)]
pub(crate) struct OutputJoinCheck {
    pub issues: Vec<JoinIssue>,
    pub transition_frames: Vec<Option<u32>>,
}

/// Validates the shape of an output at ingress: at least one piece, each with
/// frames; one transition per join; placed segments with finite windows.
pub(crate) fn validate_output(output: &BatchRenderOutput) -> CoreResult<()> {
    let invalid =
        |reason: String| CoreError::Config(format!("Batch output {}: {reason}", output.id));
    if output.pieces.is_empty() {
        return Err(invalid("it must contain at least one piece".into()));
    }
    if let Some(index) = output
        .pieces
        .iter()
        .position(|piece| piece.end_frame <= piece.start_frame)
    {
        return Err(invalid(format!("piece {} has no frames", index + 1)));
    }
    if output.transitions.len() + 1 != output.pieces.len() {
        return Err(invalid(format!(
            "it must hold one transition per join of its {} pieces",
            output.pieces.len()
        )));
    }
    if output.placed_segments.is_empty() {
        return Err(invalid("it must list its placed segments".into()));
    }
    if let Some(segment) = output.placed_segments.iter().find(|segment| {
        !segment.start_second.is_finite()
            || !segment.end_second.is_finite()
            || segment.start_second >= segment.end_second
    }) {
        return Err(invalid(format!(
            "the placed segment of {} must have a finite window with start < end",
            segment.source_id
        )));
    }
    Ok(())
}

/// Checks one output validated by [`validate_output`]. An unknown or malformed
/// transition is an error, not an issue.
pub(crate) fn check_output(
    output: &BatchRenderOutput,
    source_of: &dyn Fn(&str) -> CoreResult<JoinSource>,
    rules: JoinRules,
) -> CoreResult<OutputJoinCheck> {
    let invalid =
        |reason: String| CoreError::Config(format!("Batch output {}: {reason}", output.id));
    let mut placed: Vec<(&BatchPlacedSegment, JoinSource)> = output
        .placed_segments
        .iter()
        .map(|segment| Ok((segment, source_of(&segment.source_id)?)))
        .collect::<CoreResult<_>>()?;
    // Stable: segments starting together keep the editor's order.
    placed.sort_by(|left, right| left.0.start_second.total_cmp(&right.0.start_second));

    let mut issues = find_overlaps(&placed);
    let mut sources: Vec<(&str, JoinSource)> = Vec::new();
    for (segment, source) in &placed {
        if !sources.iter().any(|(id, _)| *id == segment.source_id) {
            sources.push((&segment.source_id, *source));
        }
    }
    if let Some(issue) = find_incompatible(&sources) {
        issues.push(issue);
    }
    if rules.keeps_display_rotation {
        if let Some(issue) = find_rotated(&sources) {
            issues.push(issue);
        }
    }

    let fps = source_of(&output.pieces[0].source_id)?.fps;
    let transition_frames = output
        .transitions
        .iter()
        .map(|transition| transition_frames(transition, fps).map_err(invalid))
        .collect::<CoreResult<Vec<_>>>()?;
    let frames_at = |index: Option<usize>| {
        index
            .and_then(|index| transition_frames[index])
            .unwrap_or(0)
    };
    for (index, piece) in output.pieces.iter().enumerate() {
        let incoming = index.checked_sub(1);
        let outgoing = (index < transition_frames.len()).then_some(index);
        let touched = u64::from(frames_at(incoming)) + u64::from(frames_at(outgoing));
        if piece.end_frame - piece.start_frame < touched + 1 {
            issues.push(JoinIssue::TransitionTooLong {
                piece_index: index,
                join_indices: [incoming, outgoing]
                    .into_iter()
                    .flatten()
                    .filter(|index| transition_frames[*index].is_some())
                    .collect(),
            });
        }
    }
    Ok(OutputJoinCheck {
        issues,
        transition_frames,
    })
}

fn find_overlaps(placed: &[(&BatchPlacedSegment, JoinSource)]) -> Vec<JoinIssue> {
    let mut issues = Vec::new();
    let mut running: Option<(f64, &str)> = None;
    for (segment, source) in placed {
        let (num, den) = source.fps.components();
        let half_frame = f64::from(den) / f64::from(num) / 2.0;
        match running {
            Some((end, earlier)) if end - segment.start_second >= half_frame => {
                issues.push(JoinIssue::Overlap {
                    earlier_source_id: earlier.to_string(),
                    later_source_id: segment.source_id.clone(),
                    start_second: segment.start_second,
                    end_second: end.min(segment.end_second),
                });
                if segment.end_second > end {
                    running = Some((segment.end_second, &segment.source_id));
                }
            }
            _ => running = Some((segment.end_second, &segment.source_id)),
        }
    }
    issues
}

fn find_incompatible(sources: &[(&str, JoinSource)]) -> Option<JoinIssue> {
    let format = |source: &JoinSource| (source.width, source.height, source.fps);
    let mut groups: Vec<Vec<&(&str, JoinSource)>> = Vec::new();
    for entry in sources {
        match groups
            .iter_mut()
            .find(|group| format(&group[0].1) == format(&entry.1))
        {
            Some(group) => group.push(entry),
            None => groups.push(vec![entry]),
        }
    }
    let mut reference = groups.first()?;
    for group in &groups {
        if group.len() > reference.len() {
            reference = group;
        }
    }
    let reference: HashSet<&str> = reference.iter().map(|(id, _)| *id).collect();
    let source_ids: Vec<String> = sources
        .iter()
        .filter(|(id, _)| !reference.contains(id))
        .map(|(id, _)| id.to_string())
        .collect();
    (!source_ids.is_empty()).then_some(JoinIssue::Incompatible { source_ids })
}

fn find_rotated(sources: &[(&str, JoinSource)]) -> Option<JoinIssue> {
    let (first_id, first) = sources.first()?;
    let rotated: Vec<String> = sources
        .iter()
        .filter(|(_, source)| source.rotation_degrees != first.rotation_degrees)
        .map(|(id, _)| id.to_string())
        .collect();
    (!rotated.is_empty()).then(|| JoinIssue::Rotation {
        source_ids: std::iter::once(first_id.to_string())
            .chain(rotated)
            .collect(),
    })
}

/// Frames a transition spans at `fps`, or None for a hard cut (`none`, 0 s).
fn transition_frames(transition: &BatchTransition, fps: Fps) -> Result<Option<u32>, String> {
    let BatchTransition {
        transition_type,
        duration_seconds,
    } = transition;
    if transition_type == NO_TRANSITION {
        return if *duration_seconds == 0.0 {
            Ok(None)
        } else {
            Err("a hard cut has a duration of 0 seconds".into())
        };
    }
    if !is_xfade_transition(transition_type) {
        return Err(format!("unknown transition {transition_type}"));
    }
    if !duration_seconds.is_finite() || *duration_seconds <= 0.0 {
        return Err("transition durations must be positive".into());
    }
    let (num, den) = fps.components();
    let frames = (duration_seconds * f64::from(num) / f64::from(den)).round();
    if frames < 1.0 {
        return Err(format!(
            "the {transition_type} transition is shorter than one frame"
        ));
    }
    Ok(Some(frames as u32))
}

/// A source as the editor knows it from its probe.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JoinabilitySource {
    pub id: String,
    /// Display geometry.
    pub resolution: Resolution,
    pub fps: JoinabilityFps,
    /// Display rotation: 0, 90, 180 or 270.
    pub rotation_degrees: i32,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JoinabilityFps {
    pub num: u32,
    pub den: u32,
}

/// Outputs to check against the export mode and codec they would render with.
/// Pieces and placed segments name sources by `JoinabilitySource::id`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JoinabilityRequest {
    pub sources: Vec<JoinabilitySource>,
    pub outputs: Vec<BatchRenderOutput>,
    pub export_mode: BatchExportMode,
    pub export_codec: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputJoinIssues {
    pub output_id: String,
    pub issues: Vec<JoinIssue>,
}

/// Checks outputs before they are inspected or planned: the editor's single
/// source of joinability issues.
pub fn check_joinability(request: &JoinabilityRequest) -> CoreResult<Vec<OutputJoinIssues>> {
    let codec = super::planning::codec_for_export_mode(request.export_mode, &request.export_codec)?;
    let mut sources = Vec::with_capacity(request.sources.len());
    for source in &request.sources {
        if sources
            .iter()
            .any(|(id, _): &(&str, JoinSource)| *id == source.id)
        {
            return Err(CoreError::Config(format!(
                "Joinability source {} is listed twice",
                source.id
            )));
        }
        if ![0, 90, 180, 270].contains(&source.rotation_degrees) {
            return Err(CoreError::Config(format!(
                "Joinability source {} must have a rotation of 0, 90, 180 or 270 degrees",
                source.id
            )));
        }
        sources.push((
            source.id.as_str(),
            JoinSource {
                width: source.resolution.width,
                height: source.resolution.height,
                fps: Fps::new(source.fps.num, source.fps.den)?,
                rotation_degrees: source.rotation_degrees,
            },
        ));
    }
    let source_of = |id: &str| {
        sources
            .iter()
            .find(|(source_id, _)| *source_id == id)
            .map(|(_, source)| *source)
            .ok_or_else(|| CoreError::Config(format!("Joinability source {id} is not listed")))
    };
    let rules = JoinRules::for_codec(codec);
    request
        .outputs
        .iter()
        .map(|output| {
            validate_output(output)?;
            Ok(OutputJoinIssues {
                output_id: output.id.clone(),
                issues: check_output(output, &source_of, rules)?.issues,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::render_jobs::contracts::BatchRenderPiece;

    fn source(id: &str, width: u64, fps: u32, rotation_degrees: i32) -> JoinabilitySource {
        JoinabilitySource {
            id: id.into(),
            resolution: Resolution {
                width,
                height: 1080,
            },
            fps: JoinabilityFps { num: fps, den: 1 },
            rotation_degrees,
        }
    }

    fn piece(source_id: &str, frames: u64) -> BatchRenderPiece {
        BatchRenderPiece {
            source_id: source_id.into(),
            start_frame: 0,
            end_frame: frames,
            skip_overlay: false,
        }
    }

    fn placed(source_id: &str, start_second: f64, end_second: f64) -> BatchPlacedSegment {
        BatchPlacedSegment {
            source_id: source_id.into(),
            start_second,
            end_second,
        }
    }

    fn cut() -> BatchTransition {
        BatchTransition {
            transition_type: NO_TRANSITION.into(),
            duration_seconds: 0.0,
        }
    }

    fn fade(duration_seconds: f64) -> BatchTransition {
        BatchTransition {
            transition_type: "fade".into(),
            duration_seconds,
        }
    }

    /// Two 30-frame pieces of `a` then `b`, placed at the given windows.
    fn issues(
        sources: Vec<JoinabilitySource>,
        placed_segments: Vec<BatchPlacedSegment>,
        transitions: Vec<BatchTransition>,
        export_mode: BatchExportMode,
        export_codec: &str,
    ) -> CoreResult<Vec<JoinIssue>> {
        let pieces = vec![piece("a", 30), piece("b", 30)];
        let request = JoinabilityRequest {
            sources,
            outputs: vec![BatchRenderOutput {
                id: "joined".into(),
                pieces,
                transitions,
                placed_segments,
            }],
            export_mode,
            export_codec: export_codec.into(),
        };
        Ok(check_joinability(&request)?.remove(0).issues)
    }

    fn apart() -> Vec<BatchPlacedSegment> {
        vec![placed("a", 0.0, 1.0), placed("b", 1.0, 2.0)]
    }

    #[test]
    fn overlaps_of_half_a_frame_or_more_block_the_output() {
        let sources = || vec![source("a", 1920, 30, 0), source("b", 1920, 30, 0)];
        let check = |b_start: f64| {
            issues(
                sources(),
                vec![placed("a", 0.0, 1.0), placed("b", b_start, b_start + 1.0)],
                vec![cut()],
                BatchExportMode::Transparent,
                "prores_ks",
            )
            .unwrap()
        };
        // Less than half a frame (1/60 s) shows no frame twice.
        assert_eq!(check(1.0 - 0.01), Vec::new());
        assert_eq!(
            check(0.5),
            vec![JoinIssue::Overlap {
                earlier_source_id: "a".into(),
                later_source_id: "b".into(),
                start_second: 0.5,
                end_second: 1.0,
            }]
        );
    }

    #[test]
    fn a_different_frame_rate_blocks_transparent_outputs_too() {
        let mixed = vec![source("a", 1920, 30, 0), source("b", 1920, 25, 0)];
        for (mode, codec) in [
            (BatchExportMode::Transparent, "prores_ks"),
            (BatchExportMode::Composite, "libx264"),
        ] {
            assert_eq!(
                issues(mixed.clone(), apart(), vec![cut()], mode, codec).unwrap(),
                // A tie goes to the group met first on the timeline.
                vec![JoinIssue::Incompatible {
                    source_ids: vec!["b".into()]
                }]
            );
        }
        let wide = vec![source("a", 1920, 30, 0), source("b", 3840, 30, 0)];
        assert_eq!(
            issues(
                wide,
                apart(),
                vec![cut()],
                BatchExportMode::Transparent,
                "prores_ks"
            )
            .unwrap(),
            vec![JoinIssue::Incompatible {
                source_ids: vec!["b".into()]
            }]
        );
    }

    #[test]
    fn only_encoders_that_keep_the_display_rotation_need_one_rotation() {
        let rotated = || vec![source("a", 1920, 30, 0), source("b", 1920, 30, 90)];
        assert_eq!(
            issues(
                rotated(),
                apart(),
                vec![cut()],
                BatchExportMode::Composite,
                "libx264"
            )
            .unwrap(),
            Vec::new()
        );
        assert_eq!(
            issues(
                rotated(),
                apart(),
                vec![cut()],
                BatchExportMode::Composite,
                "qsv_full_h264"
            )
            .unwrap(),
            vec![JoinIssue::Rotation {
                source_ids: vec!["a".into(), "b".into()]
            }]
        );
    }

    #[test]
    fn transitions_must_leave_every_piece_an_untouched_frame() {
        let sources = || vec![source("a", 1920, 30, 0), source("b", 1920, 30, 0)];
        // 29 frames leave one frame of each 30-frame piece; 30 frames leave none.
        assert_eq!(
            issues(
                sources(),
                apart(),
                vec![fade(29.0 / 30.0)],
                BatchExportMode::Composite,
                "libx264"
            )
            .unwrap(),
            Vec::new()
        );
        assert_eq!(
            issues(
                sources(),
                apart(),
                vec![fade(1.0)],
                BatchExportMode::Composite,
                "libx264"
            )
            .unwrap(),
            vec![
                JoinIssue::TransitionTooLong {
                    piece_index: 0,
                    join_indices: vec![0]
                },
                JoinIssue::TransitionTooLong {
                    piece_index: 1,
                    join_indices: vec![0]
                },
            ]
        );
    }

    #[test]
    fn malformed_requests_fail_instead_of_reporting_issues() {
        let sources = || vec![source("a", 1920, 30, 0), source("b", 1920, 30, 0)];
        let message = |result: CoreResult<Vec<JoinIssue>>| result.unwrap_err().to_string();
        assert!(message(issues(
            sources(),
            apart(),
            Vec::new(),
            BatchExportMode::Composite,
            "libx264"
        ))
        .contains("one transition per join"));
        assert!(message(issues(
            sources(),
            Vec::new(),
            vec![cut()],
            BatchExportMode::Composite,
            "libx264"
        ))
        .contains("placed segments"));
        assert!(message(issues(
            vec![source("a", 1920, 30, 0)],
            apart(),
            vec![cut()],
            BatchExportMode::Composite,
            "libx264"
        ))
        .contains("b is not listed"));
        assert!(message(issues(
            sources(),
            apart(),
            vec![cut()],
            BatchExportMode::Composite,
            "prores_ks"
        ))
        .contains("must match the selected export container"));
    }
}
