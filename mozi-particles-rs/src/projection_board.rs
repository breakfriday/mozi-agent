//! Visible blocks only: column packing, pixel identities and particle transitions.
use crate::{render_config::*, sampling::FieldInstance, scene::ProjectionRole};
use std::collections::HashMap;

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
#[derive(Clone)]
pub struct Raster {
    pub image: image::RgbImage,
    pub source_y: u32,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct PixelId(u64, u32, u32);
impl PixelId {
    fn seed(self) -> f32 {
        // Integer mixing is independent of world position and GPU sine precision.
        let mut h =
            self.0.wrapping_mul(0x9e3779b97f4a7c15) ^ ((self.1 as u64) << 32) ^ self.2 as u64;
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

// Entries arrive in creation order; each lane independently keeps the newest blocks that fit.
pub fn placements(blocks: &[(Entry, Raster)], height: u32, gap: u32) -> Vec<(usize, u32)> {
    let mut placed = Vec::new();
    for right in [false, true] {
        let mut selected = Vec::new();
        let mut used = 0;
        for (index, (_, raster)) in blocks
            .iter()
            .enumerate()
            .rev()
            .filter(|(_, (e, _))| e.right() == right)
        {
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

pub fn samples(
    entry: &Entry,
    raster: &Raster,
    x_offset: u32,
    y_offset: u32,
    width: u32,
    height: u32,
) -> Vec<Sample> {
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
        self.outgoing
            .retain(|p| now - p.life[1] < MARKDOWN_DISPERSE_SECONDS);
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
                role: if right {
                    ProjectionRole::User
                } else {
                    ProjectionRole::Assistant
                },
            },
            Raster {
                image: image::RgbImage::from_pixel(10, height, image::Rgb([0; 3])),
                source_y: 0,
            },
        )
    }
    #[test]
    fn antialiased_ink_changes_coverage_not_text_color() {
        let (entry, mut raster) = block(7, false, 1);
        raster.image = image::RgbImage::from_fn(3, 1, |x, _| {
            image::Rgb(
                [match x {
                    0 => 0,
                    1 => 204,
                    _ => 250,
                }; 3],
            )
        });
        let output = samples(&entry, &raster, 0, 0, 100, 100);
        assert_eq!(output.len(), 2); // Near-white paper is not a particle.
        assert!(output[0]
            .vertex
            .color
            .iter()
            .zip(output[1].vertex.color)
            .all(|(a, b)| (*a - b).abs() < 1e-6));
        assert_eq!(output[0].coverage, 1.0);
        assert!((output[1].coverage - 0.2).abs() < 1e-5);
        assert_ne!(output[0].id.seed(), output[1].id.seed());
    }
    #[test]
    fn lanes_keep_history_and_evict_independently() {
        let blocks = vec![
            block(1, true, 20),
            block(2, false, 40),
            block(3, true, 20),
            block(4, false, 40),
        ];
        assert_eq!(
            placements(&blocks, 100, 10),
            vec![(1, 0), (3, 50), (0, 0), (2, 30)]
        );
        assert_eq!(placements(&blocks, 70, 10), vec![(3, 0), (0, 0), (2, 30)]);
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
