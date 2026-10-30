//! Conversation board: page geometry, two-lane packing, pixel identities and particle transitions.
//! Renderer-agnostic — it only consumes `Raster`s, whoever produced them (Wordcraft or plain text).
use std::collections::HashMap;

use crate::layers::field::FieldInstance;
use crate::protocol::ProjectionRole;
use crate::render_config::*;

/// Page size in Wordcraft points. Derived from logical pixels, so monitor DPI does not change font size.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Layout {
    pub width: u32,
    pub height: u32,
}

impl Default for Layout {
    fn default() -> Self {
        Self { width: MARKDOWN_PAGE_WIDTH as u32, height: MARKDOWN_PAGE_HEIGHT as u32 }
    }
}

impl Layout {
    pub fn viewport(width: u32, height: u32, scale: f64) -> Self {
        let width = width as f64 / scale * MARKDOWN_VIEW_WIDTH as f64 * MARKDOWN_POINTS_PER_PIXEL as f64;
        let height = height as f64 / scale * MARKDOWN_VIEW_HEIGHT as f64 * MARKDOWN_POINTS_PER_PIXEL as f64;
        // Wordcraft 0.6.1 layout.size accepts only 72..=1584 pt.
        let fit = (1584.0 / width.max(height)).min(1.0);
        Self {
            width: (width * fit).round().max(72.0) as u32,
            height: (height * fit).round().max(72.0) as u32,
        }
    }

    /// Lane width for a block: user messages on the right, everything else on the left.
    pub fn column(self, right: bool) -> Self {
        let fraction = if right { PROJECTION_RIGHT_FRACTION } else { PROJECTION_LEFT_FRACTION };
        Self { width: (self.width as f32 * fraction).round().max(72.0) as u32, height: self.height }
    }

    /// Board width and height in raster pixels.
    pub fn pixels(self) -> (u32, u32) {
        ((self.width as f32 * MARKDOWN_SCALE).round() as u32, (self.height as f32 * MARKDOWN_SCALE).round() as u32)
    }

    /// Scale that fits the board into the reading rectangle at the camera's *initial* pose,
    /// so zooming moves text and background together instead of re-laying out the page.
    pub fn world_scale(self, width: f32, height: f32) -> f32 {
        let world_height = MARKDOWN_WORLD_WIDTH * self.height as f32 / self.width as f32;
        let visible_height = 2.0 * (CAMERA_INITIAL_DISTANCE - MARKDOWN_PLANE_Z) * (CAMERA_FOV_DEGREES.to_radians() * 0.5).tan();
        (visible_height * MARKDOWN_VIEW_HEIGHT / world_height)
            .min(visible_height * width / height * MARKDOWN_VIEW_WIDTH / MARKDOWN_WORLD_WIDTH)
    }
}

#[derive(Clone, Debug)]
pub struct Entry {
    pub id: u64,
    pub key: String,
    pub text: String,
    pub role: ProjectionRole,
}

impl Entry {
    pub fn right(&self) -> bool {
        self.role == ProjectionRole::User
    }
}

/// Dark ink on white paper; `source_y` is the crop offset inside the block's full rendering,
/// so pixel identities stay stable while a long block scrolls to its newest viewport.
#[derive(Clone, Debug)]
pub struct Raster {
    pub image: image::RgbImage,
    pub source_y: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct PixelId(u64, u32, u32);

impl PixelId {
    fn seed(self) -> f32 {
        // Integer mixing is independent of world position and GPU sine precision.
        let mut h = self.0.wrapping_mul(0x9e3779b97f4a7c15) ^ ((self.1 as u64) << 32) ^ self.2 as u64;
        h = (h ^ (h >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
        h = (h ^ (h >> 27)).wrapping_mul(0x94d049bb133111eb);
        h ^= h >> 31;
        (h >> 40) as f32 / 16777216.0
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Sample {
    pub id: PixelId,
    pub vertex: FieldInstance,
    pub coverage: f32,
}

/// Entries arrive in creation order; each lane independently keeps the newest blocks that fit.
pub fn placements(blocks: &[(&Entry, &Raster)], height: u32, gap: u32) -> Vec<(usize, u32)> {
    let mut placed = Vec::new();
    for right in [false, true] {
        let mut selected = Vec::new();
        let mut used = 0;
        for (index, (_, raster)) in blocks.iter().enumerate().rev().filter(|(_, (e, _))| e.right() == right) {
            let extra = raster.image.height() + if selected.is_empty() { 0 } else { gap };
            if used + extra > height {
                break;
            }
            used += extra;
            selected.push(index);
        }
        let mut y = 0;
        for index in selected.into_iter().rev() {
            placed.push((index, y));
            y += blocks[index].1.image.height() + gap;
        }
    }
    placed
}

pub fn samples(entry: &Entry, raster: &Raster, x_offset: u32, y_offset: u32, width: u32, height: u32) -> Vec<Sample> {
    let step = MARKDOWN_WORLD_WIDTH / width as f32;
    let tint = match entry.role {
        ProjectionRole::User => [0.4, 0.78, 1.0],
        ProjectionRole::Assistant => [0.94, 0.97, 1.0],
        ProjectionRole::Activity => [1.0, 0.76, 0.4],
    };
    let mut output = Vec::new();
    for y in (0..raster.image.height()).step_by(MARKDOWN_SAMPLE_STRIDE) {
        for x in (0..raster.image.width()).step_by(MARKDOWN_SAMPLE_STRIDE) {
            let rgb = raster.image.get_pixel(x, y).0.map(|v| v as f32 / 255.0);
            let ink = 1.0 - rgb.into_iter().fold(1.0_f32, f32::min);
            if ink < MARKDOWN_COVERAGE_THRESHOLD {
                continue;
            }
            let max = rgb.into_iter().fold(0.0_f32, f32::max);
            let color = std::array::from_fn(|i| (rgb[i] + 1.0 - max) * tint[i]);
            output.push(Sample {
                id: PixelId(entry.id, x, raster.source_y + y),
                coverage: ink,
                vertex: FieldInstance {
                    position: [
                        (x_offset as f32 + x as f32 - width as f32 * 0.5) * step,
                        (height as f32 * 0.5 - y_offset as f32 - y as f32) * step,
                        MARKDOWN_PLANE_Z,
                    ],
                    color,
                },
            });
        }
    }
    output
}

pub struct Composition {
    pub particles: Vec<Sample>,
    /// Blocks offered to the board (all had a raster).
    pub considered: Vec<u64>,
    /// Blocks that fit; considered-but-not-retained blocks were evicted by newer ones.
    pub retained: Vec<u64>,
}

pub fn compose(blocks: &[(&Entry, &Raster)], layout: Layout) -> Composition {
    let (width, height) = layout.pixels();
    let gap = (PROJECTION_BLOCK_GAP_PT * MARKDOWN_SCALE) as u32;
    let mut particles = Vec::new();
    let mut retained = Vec::new();
    for (index, y) in placements(blocks, height, gap) {
        let (entry, raster) = blocks[index];
        let x = if entry.right() { width.saturating_sub(raster.image.width()) } else { 0 };
        particles.extend(samples(entry, raster, x, y, width, height));
        retained.push(entry.id);
    }
    Composition { particles, considered: blocks.iter().map(|(e, _)| e.id).collect(), retained }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, bytemuck::Pod, bytemuck::Zeroable)]
pub struct Particle {
    position: [f32; 3],
    color: [f32; 3],
    life: [f32; 2],
    origin: [f32; 3],
    moved_at: f32,
    appearance: [f32; 2], // stable seed, raster coverage
}

impl Particle {
    fn at(&self, now: f32) -> [f32; 3] {
        let t = ((now - self.moved_at) / MARKDOWN_REFLOW_SECONDS).clamp(0.0, 1.0);
        let t = t * t * (3.0 - 2.0 * t);
        std::array::from_fn(|i| self.origin[i] + (self.position[i] - self.origin[i]) * t)
    }
}

/// Matches samples to live particles by pixel identity: kept ink glides to its new place,
/// new ink is born (assembles), vanished ink disperses.
#[derive(Default)]
pub struct Animation {
    live: HashMap<PixelId, Particle>,
    outgoing: Vec<Particle>,
    buffer: Vec<Particle>,
}

impl Animation {
    pub fn clear(&mut self) {
        self.live.clear();
        self.outgoing.clear();
        self.buffer.clear();
    }

    pub fn update(&mut self, samples: &[Sample], now: f32) -> &[Particle] {
        self.outgoing.retain(|p| now - p.life[1] < MARKDOWN_DISPERSE_SECONDS);
        let mut next = HashMap::with_capacity(samples.len());
        for sample in samples {
            let v = sample.vertex;
            let mut p = self.live.remove(&sample.id).unwrap_or(Particle {
                position: v.position,
                color: v.color,
                life: [now, -1.0],
                origin: v.position,
                moved_at: now,
                appearance: [sample.id.seed(), sample.coverage],
            });
            if p.position != v.position {
                p.origin = p.at(now);
                p.moved_at = now;
                p.position = v.position;
            }
            p.color = v.color;
            p.appearance[1] = sample.coverage;
            next.insert(sample.id, p);
        }
        for mut p in self.live.drain().map(|(_, p)| p) {
            p.position = p.at(now);
            p.origin = p.position;
            p.life[1] = now;
            self.outgoing.push(p);
        }
        self.live = next;
        self.buffer.clear();
        self.buffer.extend_from_slice(&self.outgoing);
        self.buffer.extend(self.live.values().copied());
        &self.buffer
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block(id: u64, right: bool, height: u32) -> (Entry, Raster) {
        (
            Entry {
                id,
                key: id.to_string(),
                text: String::new(),
                role: if right { ProjectionRole::User } else { ProjectionRole::Assistant },
            },
            Raster { image: image::RgbImage::from_pixel(10, height, image::Rgb([0; 3])), source_y: 0 },
        )
    }

    fn refs(blocks: &[(Entry, Raster)]) -> Vec<(&Entry, &Raster)> {
        blocks.iter().map(|(e, r)| (e, r)).collect()
    }

    #[test]
    fn antialiased_ink_changes_coverage_not_text_color() {
        let (entry, mut raster) = block(7, false, 1);
        raster.image = image::RgbImage::from_fn(3, 1, |x, _| image::Rgb([match x { 0 => 0, 1 => 204, _ => 250 }; 3]));
        let output = samples(&entry, &raster, 0, 0, 100, 100);
        assert_eq!(output.len(), 2); // Near-white paper is not a particle.
        assert!(output[0].vertex.color.iter().zip(output[1].vertex.color).all(|(a, b)| (*a - b).abs() < 1e-6));
        assert_eq!(output[0].coverage, 1.0);
        assert!((output[1].coverage - 0.2).abs() < 1e-5);
        assert_ne!(output[0].id.seed(), output[1].id.seed());
    }

    #[test]
    fn lanes_keep_history_and_evict_independently() {
        let blocks = vec![block(1, true, 20), block(2, false, 40), block(3, true, 20), block(4, false, 40)];
        assert_eq!(placements(&refs(&blocks), 100, 10), vec![(1, 0), (3, 50), (0, 0), (2, 30)]);
        assert_eq!(placements(&refs(&blocks), 70, 10), vec![(3, 0), (0, 0), (2, 30)]);
    }

    #[test]
    fn compose_right_aligns_user_lane_and_reports_evictions() {
        let blocks = vec![block(1, true, 20), block(2, false, 40)];
        let layout = Layout { width: 100, height: 100 };
        let composition = compose(&refs(&blocks), layout);
        assert_eq!(composition.considered, vec![1, 2]);
        assert_eq!(composition.retained.len(), 2);
        let (width, _) = layout.pixels();
        let step = MARKDOWN_WORLD_WIDTH / width as f32;
        let user_x = composition.particles.iter().filter(|p| p.id.0 == 1).map(|p| p.vertex.position[0]).fold(f32::MIN, f32::max);
        assert!((user_x - (width as f32 * 0.5 - 1.0) * step).abs() < 1e-4, "user ink hugs the right edge");
    }

    #[test]
    fn existing_ink_moves_without_restarting_birth_and_removed_ink_fades() {
        let (entry, raster) = block(1, false, 1);
        let first = samples(&entry, &raster, 0, 20, 100, 100);
        let mut animation = Animation::default();
        animation.update(&first, 1.0);
        let seed = animation.live[&first[0].id].appearance[0];
        let shifted = samples(&entry, &raster, 0, 0, 100, 100);
        animation.update(&shifted, 2.0);
        let p = animation.live[&shifted[0].id];
        assert_eq!(p.life, [1.0, -1.0]);
        assert_eq!(p.appearance[0], seed);
        assert_eq!(p.at(2.0), first[0].vertex.position);
        assert_eq!(p.at(3.0), shifted[0].vertex.position);
        animation.update(&[], 3.0);
        assert!(!animation.outgoing.is_empty());
        assert!(animation.update(&[], 5.0).is_empty());
    }
}
