//! Wallpaper image → SILK relief field and PULSE aurora instances. Knows nothing about text.

use bytemuck::{Pod, Zeroable};
use image::RgbaImage;

use crate::core::rng::LcgRng;

/// World height of the wallpaper plane; width follows the (clamped) image aspect.
pub const FIELD_WORLD_HEIGHT: f32 = 7.6;

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

pub struct FieldSamples {
    pub instances: Vec<FieldInstance>,
    pub width: u32,
    pub height: u32,
    pub aspect: f32,
}

impl FieldSamples {
    /// Wallpaper particle closest to a world-space XY point (clamped to the plane).
    pub fn nearest(&self, x: f32, y: f32) -> &FieldInstance {
        let world_w = FIELD_WORLD_HEIGHT * self.aspect;
        let u = (x / world_w + 0.5).clamp(0.0, 1.0);
        let v = (0.5 - y / FIELD_WORLD_HEIGHT).clamp(0.0, 1.0);
        let gx = ((u * (self.width - 1) as f32).round() as u32).min(self.width - 1);
        let gy = ((v * (self.height - 1) as f32).round() as u32).min(self.height - 1);
        &self.instances[(gy * self.width + gx) as usize]
    }
}

/// 3x3 Gaussian blur + isotropic 3x3 Sobel relief depth.
pub fn compute_relief(luma: &[f32], width: usize, height: usize) -> Vec<f32> {
    let idx = |x: isize, y: isize| -> usize {
        let cx = x.clamp(0, width as isize - 1) as usize;
        let cy = y.clamp(0, height as isize - 1) as usize;
        cy * width + cx
    };
    let mut blurred = vec![0.0f32; width * height];
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
            let gx = -blurred[idx(x - 1, y - 1)] - 2.0 * blurred[idx(x - 1, y)] - blurred[idx(x - 1, y + 1)]
                + blurred[idx(x + 1, y - 1)] + 2.0 * blurred[idx(x + 1, y)] + blurred[idx(x + 1, y + 1)];
            let gy = -blurred[idx(x - 1, y - 1)] - 2.0 * blurred[idx(x, y - 1)] - blurred[idx(x + 1, y - 1)]
                + blurred[idx(x - 1, y + 1)] + 2.0 * blurred[idx(x, y + 1)] + blurred[idx(x + 1, y + 1)];
            let edge = (gx.hypot(gy) * 0.45).min(0.35);
            let i = y as usize * width + x as usize;
            relief[i] = (blurred[i] * 0.82 + edge).min(1.0);
        }
    }
    relief
}

pub fn sample_field(img: &RgbaImage, grid_w: u32, grid_h: u32) -> FieldSamples {
    let resized = image::imageops::resize(img, grid_w, grid_h, image::imageops::FilterType::Triangle);
    let aspect = (img.width() as f32 / img.height().max(1) as f32).clamp(1.2, 2.1);
    let count = (grid_w * grid_h) as usize;
    let rgb = |p: &image::Rgba<u8>| [p[0] as f32 / 255.0, p[1] as f32 / 255.0, p[2] as f32 / 255.0];
    let luma: Vec<f32> = resized.pixels().map(|p| {
        let [r, g, b] = rgb(p);
        0.2126 * r + 0.7152 * g + 0.0722 * b
    }).collect();

    let relief = compute_relief(&luma, grid_w as usize, grid_h as usize);
    let world_w = FIELD_WORLD_HEIGHT * aspect;
    let mut rng = LcgRng::new(0x1357_9BDF_2468_ACE0);
    let mut instances = Vec::with_capacity(count);
    for y in 0..grid_h {
        for x in 0..grid_w {
            let i = (y * grid_w + x) as usize;
            let [r, g, b] = rgb(resized.get_pixel(x, y));
            let jitter_x = (rng.next_f32() - 0.5) * 0.018;
            let jitter_y = (rng.next_f32() - 0.5) * 0.018;
            instances.push(FieldInstance {
                position: [
                    (x as f32 / (grid_w - 1) as f32 - 0.5) * world_w + jitter_x,
                    (0.5 - y as f32 / (grid_h - 1) as f32) * FIELD_WORLD_HEIGHT + jitter_y,
                    (relief[i] - 0.45) * 2.5,
                ],
                color: [(r * 0.92 + 0.04).min(1.0), (g * 0.92 + 0.05).min(1.0), (b * 0.94 + 0.06).min(1.0)],
            });
        }
    }
    FieldSamples { instances, width: grid_w, height: grid_h, aspect }
}

pub fn sample_pulse(field: &FieldSamples, grid_x: u32, grid_y: u32) -> Vec<PulseInstance> {
    let mut instances = Vec::with_capacity((grid_x * grid_y) as usize);
    let mut rng = LcgRng::new(0xA5A5_5A5A_F0F0_0F0F);
    for y in 0..grid_y {
        for x in 0..grid_x {
            let u = x as f32 / (grid_x.max(2) - 1) as f32;
            let v = y as f32 / (grid_y.max(2) - 1) as f32;
            let fx = ((u * (field.width - 1) as f32) as u32).min(field.width - 1);
            let fy = ((v * (field.height - 1) as f32) as u32).min(field.height - 1);
            instances.push(PulseInstance {
                uv: [u, v],
                rand: rng.next_f32(),
                color: field.instances[(fy * field.width + fx) as usize].color,
            });
        }
    }
    instances
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nearest_maps_world_corners_to_grid_corners() {
        let field = sample_field(&super::super::wallpaper::create_landscape(32, 20), 16, 10);
        let world_w = FIELD_WORLD_HEIGHT * field.aspect;
        let top_left = field.nearest(-world_w, FIELD_WORLD_HEIGHT);
        assert_eq!(top_left.position, field.instances[0].position);
        let bottom_right = field.nearest(world_w, -FIELD_WORLD_HEIGHT);
        assert_eq!(bottom_right.position, field.instances.last().unwrap().position);
    }
}
