//! Short notice text → GLYPH particle targets, homed on nearby wallpaper particles.

use ab_glyph::{Font, FontArc, PxScale, ScaleFont};
use bytemuck::{Pod, Zeroable};

use crate::core::rng::LcgRng;
use crate::layers::field::FieldSamples;
use crate::render_config::*;

#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct GlyphInstance {
    pub home_pos: [f32; 3],
    pub target_pos: [f32; 3],
    pub home_color: [f32; 3],
    pub seed: f32,
}

pub struct GlyphBounds {
    pub center: [f32; 2],
    pub half_size: [f32; 2],
}

/// First readable CJK-capable system font; shared by GLYPH and plain-text projection.
pub fn load_system_font() -> Option<FontArc> {
    let candidates = [
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
        "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
        "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
        "/usr/share/fonts/truetype/ubuntu/Ubuntu-B.ttf",
        "/usr/share/fonts/truetype/ubuntu/Ubuntu-R.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    ];
    candidates
        .iter()
        .filter_map(|path| std::fs::read(path).ok())
        .find_map(|bytes| FontArc::try_from_vec(bytes).ok())
}

/// Rasterizes a single-line notice into 3D target coordinates.
pub fn sample_text(text: &str, font: Option<&FontArc>) -> Vec<[f32; 3]> {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let clean: String = normalized.chars().take(TEXT_MAX_CHARS).collect();
    let label = if clean.is_empty() { "MOZI" } else { &clean };
    let mut points = Vec::new();

    if let Some(font) = font {
        let scale = PxScale::from(TEXT_RASTER_SIZE_PX);
        let scaled = font.as_scaled(scale);
        let mut cursor_x = 0.0f32;
        let mut glyphs = Vec::new();
        for ch in label.chars() {
            let glyph_id = scaled.glyph_id(ch);
            glyphs.push(glyph_id.with_scale_and_position(scale, ab_glyph::point(cursor_x, scaled.ascent())));
            cursor_x += scaled.h_advance(glyph_id) + TEXT_LETTER_SPACING_PX;
        }
        let total_w = cursor_x.max(1.0);
        let total_h = (scaled.ascent() - scaled.descent()).max(1.0);
        let world_scale = (TEXT_MAX_WIDTH / total_w).min(TEXT_MAX_HEIGHT / total_h);
        let mut rng = LcgRng::new(0x9E37_79B9_7F4A_7C15);
        for glyph in glyphs {
            if let Some(outlined) = font.outline_glyph(glyph) {
                let bounds = outlined.px_bounds();
                outlined.draw(|gx, gy, coverage| {
                    if coverage > TEXT_COVERAGE_THRESHOLD && ((gx + gy) % TEXT_SAMPLE_STRIDE == 0) {
                        let px = bounds.min.x + gx as f32;
                        let py = bounds.min.y + gy as f32;
                        points.push([
                            (px - total_w * 0.5) * world_scale,
                            (total_h * 0.5 - py) * world_scale,
                            TEXT_PLANE_Z + (rng.next_f32() - 0.5) * TEXT_DEPTH_JITTER,
                        ]);
                    }
                });
            }
        }
    }

    if points.is_empty() {
        // Fallback geometric banner if no system font was found
        for i in 0..EVENT_PARTICLE_COUNT {
            let t = i as f32 / EVENT_PARTICLE_COUNT as f32;
            points.push([(t - 0.5) * 6.5, (t * 32.0).sin() * 0.45, TEXT_PLANE_Z]);
        }
    }
    points
}

/// Spreads `EVENT_PARTICLE_COUNT` particles over the targets in reading order, each recruited
/// from a wallpaper particle near its stroke (so the text keeps the wallpaper's colors).
pub fn fill_event_buffers(targets: &[[f32; 3]], field: &FieldSamples, rng: &mut LcgRng) -> (Vec<GlyphInstance>, GlyphBounds) {
    let (mut min_x, mut max_x, mut min_y, mut max_y) = (f32::INFINITY, f32::NEG_INFINITY, f32::INFINITY, f32::NEG_INFINITY);
    for t in targets {
        min_x = min_x.min(t[0]);
        max_x = max_x.max(t[0]);
        min_y = min_y.min(t[1]);
        max_y = max_y.max(t[1]);
    }
    if !min_x.is_finite() {
        (min_x, max_x, min_y, max_y) = (-1.0, 1.0, -0.3, 0.3);
    }

    let mut ordered: Vec<[f32; 3]> = targets.to_vec();
    let band_height = ((max_y - min_y) / 14.0).max(0.06);
    ordered.sort_by(|a, b| {
        let band_a = ((max_y - a[1]) / band_height).round() as i32;
        let band_b = ((max_y - b[1]) / band_height).round() as i32;
        band_a.cmp(&band_b).then_with(|| a[0].partial_cmp(&b[0]).unwrap_or(std::cmp::Ordering::Equal))
    });

    let n = ordered.len().max(1);
    let mut instances = Vec::with_capacity(EVENT_PARTICLE_COUNT);
    for i in 0..EVENT_PARTICLE_COUNT {
        let pick = if n == 1 { 0 } else { (i * (n - 1)) / (EVENT_PARTICLE_COUNT - 1) };
        let target = ordered[pick];
        let jitter = (rng.next_f32() - 0.5) * TEXT_TARGET_JITTER;
        let target_pos = [target[0] + jitter, target[1] + jitter, target[2]];
        let home = *field.nearest(target[0] + (rng.next_f32() - 0.5) * 2.2, target[1] + (rng.next_f32() - 0.5) * 1.6);
        let order = i as f32 / (EVENT_PARTICLE_COUNT - 1) as f32;
        let seed = (order * 0.85 + rng.next_f32() * 0.15).clamp(0.0, 1.0);
        instances.push(GlyphInstance { home_pos: home.position, target_pos, home_color: home.color, seed });
    }

    let bounds = GlyphBounds {
        center: [(min_x + max_x) * 0.5, (min_y + max_y) * 0.5],
        half_size: [((max_x - min_x) * 0.5).max(0.6), ((max_y - min_y) * 0.5).max(0.25)],
    };
    (instances, bounds)
}
