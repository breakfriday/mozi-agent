//! The frame uniform (bind group 0, binding 0) shared by every layer, assembled from explicit parts.
//! Layers never write it directly: the app composes it once per frame, so all layers see the same camera.
use bytemuck::{Pod, Zeroable};
use glam::Mat4;

/// GPU layout — must match `struct Globals` in render/common.wgsl.
#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct Globals {
    pub view_proj: [[f32; 4]; 4],
    pub view: [[f32; 4]; 4],
    pub viewport: [f32; 4],     // width_px, height_px, dpr, time
    pub glyph_bounds: [f32; 4], // focus center.xy, half_size.xy
    pub p0: [f32; 4],           // depth, focus age, pulse_alpha, dance_mode
    pub p1: [f32; 4],           // dance_dir.xy, in_mode, out_mode
    pub p2: [f32; 4],           // swirl, disp_fade, drift.xy
    pub glow: [f32; 4],         // glyph glow rgb, ripple_intensity
    pub ripple: [f32; 4],       // center.xy, ripple_time, unused
    pub pointer: [f32; 4],      // world.xy, hover strength, unused
    pub panel: [f32; 4],        // Markdown visibility, sample spacing, assemble, disperse
    pub panel_motion: [f32; 4], // reflow duration, viewport model scale, text plane Z, minimum raster radius
}

/// The single shared camera, already resolved to matrices for this frame.
pub struct CameraFrame {
    pub view_proj: Mat4,
    pub view: Mat4,
    pub viewport: [f32; 2],
    pub dpr: f32,
    pub time: f32,
}

/// Published by a text layer; the field reacts around it (well, dance, landing ripple)
/// without knowing which layer published it.
#[derive(Clone, Copy, Debug)]
pub struct FocusSignal {
    pub bounds: [f32; 4],
    pub age: f32,
    pub dance_mode: f32,
    pub dance_dir: [f32; 2],
    pub ripple: [f32; 3],
}

impl Default for FocusSignal {
    fn default() -> Self {
        Self { bounds: [0.0, 0.0, 1.0, 0.3], age: -100.0, dance_mode: 0.0, dance_dir: [1.0, 0.0], ripple: [0.0, 0.0, -100.0] }
    }
}

impl FocusSignal {
    /// Several text layers may publish; the background follows whichever started most recently.
    pub fn newest(signals: impl IntoIterator<Item = FocusSignal>) -> FocusSignal {
        signals
            .into_iter()
            .filter(|s| s.age >= 0.0)
            .min_by(|a, b| a.age.total_cmp(&b.age))
            .unwrap_or_default()
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct FieldParams {
    pub depth: f32,
    pub pulse_alpha: f32,
    pub pointer: [f32; 3],
}

#[derive(Clone, Copy, Debug, Default)]
pub struct GlyphMotion {
    pub in_mode: f32,
    pub out_mode: f32,
    pub swirl: f32,
    pub disp_fade: f32,
    pub drift: [f32; 2],
    pub glow: [f32; 3],
}

#[derive(Clone, Copy, Debug, Default)]
pub struct PanelParams {
    pub panel: [f32; 4],
    pub motion: [f32; 4],
}

const RIPPLE_INTENSITY: f32 = 0.5;

impl Globals {
    pub fn compose(camera: &CameraFrame, focus: &FocusSignal, field: &FieldParams, glyph: &GlyphMotion, panel: &PanelParams) -> Self {
        Self {
            view_proj: camera.view_proj.to_cols_array_2d(),
            view: camera.view.to_cols_array_2d(),
            viewport: [camera.viewport[0], camera.viewport[1], camera.dpr, camera.time],
            glyph_bounds: focus.bounds,
            p0: [field.depth, focus.age, field.pulse_alpha, focus.dance_mode],
            p1: [focus.dance_dir[0], focus.dance_dir[1], glyph.in_mode, glyph.out_mode],
            p2: [glyph.swirl, glyph.disp_fade, glyph.drift[0], glyph.drift[1]],
            glow: [glyph.glow[0], glyph.glow[1], glyph.glow[2], RIPPLE_INTENSITY],
            ripple: [focus.ripple[0], focus.ripple[1], focus.ripple[2], 0.0],
            pointer: [field.pointer[0], field.pointer[1], field.pointer[2], 0.0],
            panel: panel.panel,
            panel_motion: panel.motion,
        }
    }

    pub fn markdown_visible(&self) -> bool {
        self.panel[0] > 0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(age: f32, x: f32) -> FocusSignal {
        FocusSignal { age, bounds: [x, 0.0, 1.0, 1.0], ..FocusSignal::default() }
    }

    #[test]
    fn newest_started_focus_wins() {
        assert_eq!(FocusSignal::newest([at(3.0, 1.0), at(0.5, 2.0)]).bounds[0], 2.0);
        assert_eq!(FocusSignal::newest([at(0.2, 1.0), at(4.0, 2.0)]).bounds[0], 1.0);
        // Negative age (not started yet) never wins; nothing published → inert default.
        assert_eq!(FocusSignal::newest([at(-1.0, 9.0), at(2.0, 3.0)]).bounds[0], 3.0);
        assert_eq!(FocusSignal::newest([]).age, FocusSignal::default().age);
    }
}
