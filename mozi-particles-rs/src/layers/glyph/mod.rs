//! Short-message text layer (Terse GLYPH): notice queue, 9-move assembly/dispersal choreography
//! and style presets. Publishes a `FocusSignal` so the field can react around the text.
pub mod raster;
pub mod styles;

use std::collections::VecDeque;

use ab_glyph::FontArc;

pub use raster::{load_system_font, GlyphInstance};
use styles::{find_style, ParticleStyle, PARTICLE_STYLES};

use crate::core::rng::{BagPicker, LcgRng};
use crate::layers::field::FieldSamples;
use crate::render::uniforms::{FocusSignal, GlyphMotion};
use crate::render_config::{GLYPH_DURATION, GLYPH_LANDING};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    Activity,
    Success,
    Attention,
}

impl Tone {
    pub fn parse(value: Option<&str>) -> Self {
        match value {
            Some("success") => Tone::Success,
            Some("attention") => Tone::Attention,
            _ => Tone::Activity,
        }
    }

    fn glow(self) -> [f32; 3] {
        match self {
            Tone::Activity => [0.863, 0.925, 0.910], // #dcece8
            Tone::Success => [0.643, 0.929, 0.800],  // #a4edcc
            Tone::Attention => [1.0, 0.827, 0.592],  // #ffd397
        }
    }
}

#[derive(Debug, Clone)]
pub struct Notice {
    pub key: String,
    pub text: String,
    pub tone: Tone,
}

/// Coalesce by key, outcomes win over chatter, bounded backlog.
#[derive(Default)]
pub struct NoticeQueue {
    items: VecDeque<Notice>,
}

impl NoticeQueue {
    pub const MAX_BACKLOG: usize = 6;

    pub fn push(&mut self, notice: Notice) {
        if let Some(existing) = self.items.iter_mut().find(|n| n.key == notice.key) {
            if existing.tone != Tone::Activity && notice.tone == Tone::Activity {
                return;
            }
            *existing = notice;
            return;
        }
        self.items.push_back(notice);
        while self.items.len() > Self::MAX_BACKLOG {
            self.items.pop_front();
        }
    }

    pub fn take(&mut self) -> Option<Notice> {
        self.items.pop_front()
    }
}

pub struct GlyphLayer {
    pub style: &'static ParticleStyle,
    queue: NoticeQueue,
    bags: BagPicker,
    rng: LcgRng,
    font: Option<FontArc>,
    start: f32,
    bounds: [f32; 4],
    ripple: [f32; 3],
    dance_mode: f32,
    dance_dir: [f32; 2],
    in_mode: f32,
    out_mode: f32,
    drift: [f32; 2],
    glow: [f32; 3],
}

impl GlyphLayer {
    pub fn new(font: Option<FontArc>, style_id: Option<&str>) -> Self {
        Self {
            style: find_style(style_id.unwrap_or("auto")),
            queue: NoticeQueue::default(),
            bags: BagPicker::new(),
            rng: LcgRng::new(0x0DDB_A11C_0FFE_E000),
            font,
            start: -100.0,
            bounds: [0.0, 0.0, 1.0, 0.3],
            ripple: [0.0, 0.0, -100.0],
            dance_mode: 0.0,
            dance_dir: [1.0, 0.0],
            in_mode: 0.0,
            out_mode: 0.0,
            drift: [1.0, 0.0],
            glow: Tone::Activity.glow(),
        }
    }

    pub fn set_style(&mut self, id: &str) {
        self.style = find_style(id);
    }

    pub fn cycle_style(&mut self) {
        let idx = PARTICLE_STYLES.iter().position(|s| s.id == self.style.id).unwrap_or(0);
        self.style = &PARTICLE_STYLES[(idx + 1) % PARTICLE_STYLES.len()];
    }

    pub fn enqueue(&mut self, notice: Notice) {
        self.queue.push(notice);
    }

    fn age(&self, now: f32) -> f32 {
        now - self.start
    }

    pub fn visible(&self, now: f32) -> bool {
        (0.0..=GLYPH_DURATION).contains(&self.age(now))
    }

    /// Starts the next queued notice once the current one has fully dispersed.
    /// Returns the instance buffer to upload when a new notice begins.
    pub fn update(&mut self, now: f32, field: &FieldSamples) -> Option<Vec<GlyphInstance>> {
        if self.visible(now) {
            return None;
        }
        let notice = self.queue.take()?;
        Some(self.start(notice, now, field))
    }

    fn start(&mut self, notice: Notice, now: f32, field: &FieldSamples) -> Vec<GlyphInstance> {
        let targets = raster::sample_text(&notice.text, self.font.as_ref());
        let (instances, bounds) = raster::fill_event_buffers(&targets, field, &mut self.rng);
        let style = self.style;
        let ids = |modes: &[styles::GlyphMove]| modes.iter().map(|m| *m as u32).collect::<Vec<_>>();
        self.in_mode = self.bags.pick("in", &ids(style.in_modes)) as f32;
        self.out_mode = self.bags.pick("out", &ids(style.out_modes)) as f32;
        let dances: Vec<u32> = style.dances.iter().map(|d| *d as u32).collect();
        self.dance_mode = self.bags.pick("dance", &dances) as f32;
        self.dance_dir = self.bags.next_unit_dir();
        self.drift = self.bags.next_unit_dir();
        self.bounds = [bounds.center[0], bounds.center[1], bounds.half_size[0], bounds.half_size[1]];
        self.glow = notice.tone.glow();
        self.start = now;
        // The ripple fires as the strokes land, like Terse's arrival pulse.
        self.ripple = [bounds.center[0], bounds.center[1], now + GLYPH_LANDING * 0.85];
        instances
    }

    pub fn focus(&self, now: f32) -> FocusSignal {
        FocusSignal {
            bounds: self.bounds,
            age: self.age(now),
            dance_mode: self.dance_mode,
            dance_dir: self.dance_dir,
            ripple: self.ripple,
        }
    }

    pub fn motion(&self) -> GlyphMotion {
        GlyphMotion {
            in_mode: self.in_mode,
            out_mode: self.out_mode,
            swirl: self.style.swirl,
            disp_fade: self.style.disp_fade,
            drift: self.drift,
            glow: self.glow,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layers::field::{sampling::sample_field, wallpaper::create_landscape};

    fn n(key: &str, text: &str, tone: Tone) -> Notice {
        Notice { key: key.into(), text: text.into(), tone }
    }

    #[test]
    fn queue_coalesces_and_prioritizes_outcomes() {
        let mut q = NoticeQueue::default();
        for i in 0..100 {
            q.push(n("run", &format!("tool {i}"), Tone::Activity));
        }
        assert_eq!(q.take().unwrap().text, "tool 99");
        assert!(q.take().is_none());
        q.push(n("run", "working", Tone::Activity));
        q.push(n("run", "done", Tone::Success));
        q.push(n("run", "late", Tone::Activity));
        assert_eq!(q.take().unwrap().text, "done");
        for i in 0..100 {
            q.push(n(&format!("r{i}"), "w", Tone::Activity));
        }
        let mut len = 0;
        while q.take().is_some() {
            len += 1;
        }
        assert_eq!(len, NoticeQueue::MAX_BACKLOG);
    }

    #[test]
    fn notices_play_one_at_a_time_and_publish_focus() {
        let field = sample_field(&create_landscape(16, 12), 16, 12);
        let mut glyph = GlyphLayer::new(None, None);
        glyph.enqueue(n("a", "first", Tone::Success));
        glyph.enqueue(n("b", "second", Tone::Activity));
        assert!(glyph.update(1.0, &field).is_some());
        assert!(glyph.visible(1.0));
        assert_eq!(glyph.focus(1.0).age, 0.0);
        assert!(glyph.update(2.0, &field).is_none(), "second waits for the first to disperse");
        let after = 1.0 + GLYPH_DURATION + 0.01;
        assert!(glyph.update(after, &field).is_some());
        assert!(glyph.update(after + GLYPH_DURATION + 0.01, &field).is_none(), "queue drained");
        assert!(!glyph.visible(after + GLYPH_DURATION + 0.01));
    }
}
