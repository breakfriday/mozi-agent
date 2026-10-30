use ab_glyph::{Font, FontArc, PxScale, ScaleFont};
use bytemuck::{Pod, Zeroable};
use image::RgbaImage;
use std::path::Path;

use crate::styles::LcgRng;

use crate::render_config::*;

// Must stay in sync with the constants at the top of shader.wgsl.
pub const EVENT_ASSEMBLE: f32 = 1.0;
pub const EVENT_STAGGER: f32 = 0.45;
pub const EVENT_HOLD: f32 = 2.0;
pub const EVENT_DISPERSE: f32 = 1.5;
pub const GLYPH_LANDING: f32 = EVENT_ASSEMBLE + EVENT_STAGGER;
pub const GLYPH_RELEASE: f32 = GLYPH_LANDING + EVENT_HOLD;
pub const EVENT_DURATION: f32 = GLYPH_RELEASE + EVENT_DISPERSE + EVENT_STAGGER;

#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct FieldInstance {
    pub position: [f32; 3],
    pub color: [f32; 3],
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct PulseInstance {
    pub uv: [f32; 2],
    pub rand: f32,
    pub color: [f32; 3],
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct GlyphInstance {
    pub home_pos: [f32; 3],
    pub target_pos: [f32; 3],
    pub home_color: [f32; 3],
    pub seed: f32,
}

pub struct FieldSamples {
    pub instances: Vec<FieldInstance>,
    pub width: u32,
    pub height: u32,
    pub aspect: f32,
}

/// Procedural nocturnal mountain-lake wallpaper fallback.
pub fn create_landscape(width: u32, height: u32) -> RgbaImage {
    let mut img = RgbaImage::new(width, height);
    for y in 0..height {
        let ny = y as f32 / (height.max(1) - 1) as f32;
        for x in 0..width {
            let nx = x as f32 / (width.max(1) - 1) as f32;
            // Sky / lake base gradient
            let (mut r, mut g, mut b) = if ny < 0.62 {
                let t = ny / 0.62;
                (
                    0.02 + t * 0.08,
                    0.05 + t * 0.16,
                    0.09 + t * 0.23,
                )
            } else {
                let t = (ny - 0.62) / 0.38;
                (
                    0.05 * (1.0 - t * 0.5),
                    0.15 * (1.0 - t * 0.45),
                    0.22 * (1.0 - t * 0.4),
                )
            };

            // Moon glow around (0.72, 0.24)
            let dx = (nx - 0.72) * 1.6;
            let dy = ny - 0.24;
            let dist = (dx * dx + dy * dy).sqrt();
            let moon = (-dist * 7.5).exp();
            r += moon * 0.92;
            g += moon * 0.88;
            b += moon * 0.72;

            // Layered mountain ridges
            let ridge1 = 0.43 + (nx * 5.2).sin() * 0.06 + (nx * 13.0).cos() * 0.025;
            let ridge2 = 0.53 + (nx * 4.1 + 1.2).sin() * 0.055 + (nx * 9.7).sin() * 0.02;
            if ny > ridge1 && ny < 0.63 {
                r *= 0.42;
                g *= 0.48;
                b *= 0.56;
            }
            if ny > ridge2 && ny < 0.63 {
                r *= 0.35;
                g *= 0.38;
                b *= 0.45;
            }

            // Lake reflection ripples
            if ny >= 0.63 {
                let ref_dx = (nx - 0.72).abs();
                let shimmer = (-ref_dx * 14.0).exp() * ((ny * 95.0 + nx * 18.0).sin() * 0.5 + 0.5);
                r += shimmer * 0.45;
                g += shimmer * 0.48;
                b += shimmer * 0.38;
            }

            img.put_pixel(
                x,
                y,
                image::Rgba([
                    (r.clamp(0.0, 1.0) * 255.0) as u8,
                    (g.clamp(0.0, 1.0) * 255.0) as u8,
                    (b.clamp(0.0, 1.0) * 255.0) as u8,
                    255,
                ]),
            );
        }
    }
    img
}

pub fn load_wallpaper(path: Option<&Path>) -> RgbaImage {
    if let Some(p) = path {
        if let Ok(img) = image::open(p) {
            return img.to_rgba8();
        }
    }
    create_landscape(640, 400)
}

/// 3x3 Gaussian blur + isotropic 3x3 Sobel relief depth.
pub fn compute_relief(luma: &[f32], width: usize, height: usize) -> Vec<f32> {
    let mut blurred = vec![0.0f32; width * height];
    let idx = |x: isize, y: isize| -> usize {
        let cx = x.clamp(0, width as isize - 1) as usize;
        let cy = y.clamp(0, height as isize - 1) as usize;
        cy * width + cx
    };

    for y in 0..height as isize {
        for x in 0..width as isize {
            blurred[y as usize * width + x as usize] = (luma[idx(x, y)] * 4.0
                + (luma[idx(x - 1, y)] + luma[idx(x + 1, y)] + luma[idx(x, y - 1)] + luma[idx(x, y + 1)]) * 2.0
                + luma[idx(x - 1, y - 1)]
                + luma[idx(x + 1, y - 1)]
                + luma[idx(x - 1, y + 1)]
                + luma[idx(x + 1, y + 1)])
                / 16.0;
        }
    }

    let mut relief = vec![0.0f32; width * height];
    for y in 0..height as isize {
        for x in 0..width as isize {
            let gx = -blurred[idx(x - 1, y - 1)]
                - 2.0 * blurred[idx(x - 1, y)]
                - blurred[idx(x - 1, y + 1)]
                + blurred[idx(x + 1, y - 1)]
                + 2.0 * blurred[idx(x + 1, y)]
                + blurred[idx(x + 1, y + 1)];
            let gy = -blurred[idx(x - 1, y - 1)]
                - 2.0 * blurred[idx(x, y - 1)]
                - blurred[idx(x + 1, y - 1)]
                + blurred[idx(x - 1, y + 1)]
                + 2.0 * blurred[idx(x, y + 1)]
                + blurred[idx(x + 1, y + 1)];
            let edge = (gx.hypot(gy) * 0.45).min(0.35);
            relief[y as usize * width + x as usize] =
                (blurred[y as usize * width + x as usize] * 0.82 + edge).min(1.0);
        }
    }
    relief
}

pub fn sample_field(img: &RgbaImage, grid_w: u32, grid_h: u32) -> FieldSamples {
    let resized = image::imageops::resize(img, grid_w, grid_h, image::imageops::FilterType::Triangle);
    let aspect = (img.width() as f32 / img.height().max(1) as f32).clamp(1.2, 2.1);
    let count = (grid_w * grid_h) as usize;
    let mut luma = vec![0.0f32; count];

    for (i, p) in resized.pixels().enumerate() {
        let r = p[0] as f32 / 255.0;
        let g = p[1] as f32 / 255.0;
        let b = p[2] as f32 / 255.0;
        luma[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }

    let relief = compute_relief(&luma, grid_w as usize, grid_h as usize);
    let world_h = 7.6f32;
    let world_w = world_h * aspect;
    let mut rng = LcgRng::new(0x1357_9BDF_2468_ACE0);
    let mut instances = Vec::with_capacity(count);

    for y in 0..grid_h {
        for x in 0..grid_w {
            let i = (y * grid_w + x) as usize;
            let p = resized.get_pixel(x, y);
            let r = p[0] as f32 / 255.0;
            let g = p[1] as f32 / 255.0;
            let b = p[2] as f32 / 255.0;
            let jitter_x = (rng.next_f32() - 0.5) * 0.018;
            let jitter_y = (rng.next_f32() - 0.5) * 0.018;
            let px = (x as f32 / (grid_w - 1) as f32 - 0.5) * world_w + jitter_x;
            let py = (0.5 - y as f32 / (grid_h - 1) as f32) * world_h + jitter_y;
            let pz = (relief[i] - 0.45) * 2.5;
            instances.push(FieldInstance {
                position: [px, py, pz],
                color: [
                    (r * 0.92 + 0.04).min(1.0),
                    (g * 0.92 + 0.05).min(1.0),
                    (b * 0.94 + 0.06).min(1.0),
                ],
            });
        }
    }

    FieldSamples {
        instances,
        width: grid_w,
        height: grid_h,
        aspect,
    }
}

pub fn sample_pulse(field: &FieldSamples, grid_x: u32, grid_y: u32) -> Vec<PulseInstance> {
    let count = (grid_x * grid_y) as usize;
    let mut instances = Vec::with_capacity(count);
    let mut rng = LcgRng::new(0xA5A5_5A5A_F0F0_0F0F);

    for y in 0..grid_y {
        for x in 0..grid_x {
            let u = x as f32 / (grid_x.max(2) - 1) as f32;
            let v = y as f32 / (grid_y.max(2) - 1) as f32;
            let fx = ((u * (field.width - 1) as f32) as u32).min(field.width - 1);
            let fy = ((v * (field.height - 1) as f32) as u32).min(field.height - 1);
            let fi = (fy * field.width + fx) as usize;
            instances.push(PulseInstance {
                uv: [u, v],
                rand: rng.next_f32(),
                color: field.instances[fi].color,
            });
        }
    }
    instances
}

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
    for path in candidates {
        if let Ok(bytes) = std::fs::read(path) {
            if let Ok(font) = FontArc::try_from_vec(bytes) {
                return Some(font);
            }
        }
    }
    None
}

/// Rasterizes notice text into 3D target coordinates.
pub fn sample_text(text: &str, font: Option<&FontArc>) -> Vec<[f32; 3]> {
    let clean: String = text.trim().chars().take(TEXT_MAX_CHARS).collect();
    let label = if clean.is_empty() { "MOZI" } else { &clean };
    let mut points = Vec::new();

    if let Some(font) = font {
        let scale = PxScale::from(TEXT_RASTER_SIZE_PX);
        let scaled = font.as_scaled(scale);
        let mut cursor_x = 0.0f32;
        let mut glyphs = Vec::new();

        for ch in label.chars() {
            let glyph_id = scaled.glyph_id(ch);
            let glyph = glyph_id.with_scale_and_position(scale, ab_glyph::point(cursor_x, scaled.ascent()));
            cursor_x += scaled.h_advance(glyph_id) + TEXT_LETTER_SPACING_PX;
            glyphs.push(glyph);
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
                        let wx = (px - total_w * 0.5) * world_scale;
                        let wy = (total_h * 0.5 - py) * world_scale;
                        let wz = TEXT_PLANE_Z + (rng.next_f32() - 0.5) * TEXT_DEPTH_JITTER;
                        points.push([wx, wy, wz]);
                    }
                });
            }
        }
    }

    if points.is_empty() {
        // Fallback geometric banner if no system font was found
        for i in 0..EVENT_PARTICLE_COUNT {
            let t = i as f32 / EVENT_PARTICLE_COUNT as f32;
            let x = (t - 0.5) * 6.5;
            let y = ((t * 32.0).sin()) * 0.45;
            points.push([x, y, TEXT_PLANE_Z]);
        }
    }
    points
}

pub struct GlyphBounds {
    pub center: [f32; 2],
    pub half_size: [f32; 2],
}

pub fn fill_event_buffers(
    targets: &[[f32; 3]],
    field: &FieldSamples,
    rng: &mut LcgRng,
) -> (Vec<GlyphInstance>, GlyphBounds) {
    let mut min_x = f32::INFINITY;
    let mut max_x = f32::NEG_INFINITY;
    let mut min_y = f32::INFINITY;
    let mut max_y = f32::NEG_INFINITY;

    for t in targets {
        min_x = min_x.min(t[0]);
        max_x = max_x.max(t[0]);
        min_y = min_y.min(t[1]);
        max_y = max_y.max(t[1]);
    }
    if !min_x.is_finite() {
        min_x = -1.0;
        max_x = 1.0;
        min_y = -0.3;
        max_y = 0.3;
    }

    let mut ordered: Vec<[f32; 3]> = targets.to_vec();
    let band_height = ((max_y - min_y) / 14.0).max(0.06);
    ordered.sort_by(|a, b| {
        let band_a = ((max_y - a[1]) / band_height).round() as i32;
        let band_b = ((max_y - b[1]) / band_height).round() as i32;
        band_a.cmp(&band_b).then_with(|| a[0].partial_cmp(&b[0]).unwrap_or(std::cmp::Ordering::Equal))
    });

    let world_h = 7.6f32;
    let world_w = world_h * field.aspect;
    let n = ordered.len().max(1);
    let mut instances = Vec::with_capacity(EVENT_PARTICLE_COUNT);

    for i in 0..EVENT_PARTICLE_COUNT {
        let pick = if n == 1 {
            0
        } else {
            (i * (n - 1)) / (EVENT_PARTICLE_COUNT - 1)
        };
        let target = ordered[pick];
        let jitter = (rng.next_f32() - 0.5) * TEXT_TARGET_JITTER;
        let target_pos = [target[0] + jitter, target[1] + jitter, target[2]];

        let u = ((target[0] + (rng.next_f32() - 0.5) * 2.2) / world_w + 0.5).clamp(0.0, 1.0);
        let v = (0.5 - (target[1] + (rng.next_f32() - 0.5) * 1.6) / world_h).clamp(0.0, 1.0);
        let gx = ((u * (field.width - 1) as f32).round() as u32).min(field.width - 1);
        let gy = ((v * (field.height - 1) as f32).round() as u32).min(field.height - 1);
        let home_idx = (gy * field.width + gx) as usize;
        let home = &field.instances[home_idx];

        let order = i as f32 / (EVENT_PARTICLE_COUNT - 1) as f32;
        let seed = (order * 0.85 + rng.next_f32() * 0.15).clamp(0.0, 1.0);

        instances.push(GlyphInstance {
            home_pos: home.position,
            target_pos,
            home_color: home.color,
            seed,
        });
    }

    let bounds = GlyphBounds {
        center: [(min_x + max_x) * 0.5, (min_y + max_y) * 0.5],
        half_size: [
            ((max_x - min_x) * 0.5).max(0.6),
            ((max_y - min_y) * 0.5).max(0.25),
        ],
    };
    (instances, bounds)
}
