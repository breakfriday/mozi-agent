//! Background layer: wallpaper SILK relief field + PULSE aurora/star dust, plus pointer wake.
//! Reacts to text only through the `FocusSignal` it is handed each frame.
pub mod sampling;
pub mod wallpaper;

use std::path::Path;

use glam::Vec2;

pub use sampling::{FieldInstance, FieldSamples, PulseInstance};

use crate::render::uniforms::FieldParams;
use crate::render_config::{FIELD_GRID_H, FIELD_GRID_W, PULSE_GRID_H, PULSE_GRID_W};

pub struct FieldLayer {
    pub samples: FieldSamples,
    pub pulse: Vec<PulseInstance>,
    pub depth: f32,
    pointer_world: Vec2,
    pointer_strength: f32,
    pointer_target: f32,
}

impl FieldLayer {
    pub fn load(path: Option<&Path>) -> Self {
        let samples = sampling::sample_field(&wallpaper::load(path), FIELD_GRID_W, FIELD_GRID_H);
        let pulse = sampling::sample_pulse(&samples, PULSE_GRID_W, PULSE_GRID_H);
        Self { samples, pulse, depth: 1.0, pointer_world: Vec2::ZERO, pointer_strength: 0.0, pointer_target: 0.0 }
    }

    /// Resamples a new wallpaper; depth and pointer state are preserved.
    pub fn reload(&mut self, path: Option<&Path>) {
        let next = Self::load(path);
        self.samples = next.samples;
        self.pulse = next.pulse;
    }

    pub fn set_pointer(&mut self, world: Option<Vec2>) {
        match world {
            Some(p) => {
                self.pointer_world = p;
                self.pointer_target = 1.0;
            }
            None => self.pointer_target = 0.0,
        }
    }

    pub fn update(&mut self, dt: f32) {
        let k = 1.0 - (-dt * 6.0).exp();
        self.pointer_strength += (self.pointer_target - self.pointer_strength) * k;
    }

    pub fn params(&self, pulse_alpha: f32) -> FieldParams {
        FieldParams {
            depth: self.depth,
            pulse_alpha,
            pointer: [self.pointer_world.x, self.pointer_world.y, self.pointer_strength],
        }
    }
}
