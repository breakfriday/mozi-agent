//! Simulation state: notice queue, glyph choreography, camera and uniform assembly.
//! Pure CPU logic — no wgpu types here, so it can be unit-tested without a GPU.

use std::collections::VecDeque;

use ab_glyph::FontArc;
use bytemuck::{Pod, Zeroable};
use glam::{Mat4, Vec2, Vec3};

use crate::sampling::{
    fill_event_buffers, sample_text, FieldSamples, GlyphInstance, EVENT_DURATION, GLYPH_LANDING,
};
use crate::render_config::{PROJECTION_MIN_READ_SECONDS, PROJECTION_READ_CHARS_PER_SECOND, PROJECTION_TRANSITION_SECONDS};
use crate::styles::{BagPicker, LcgRng, ParticleStyle, PARTICLE_STYLES};

#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct Globals {
    pub view_proj: [[f32; 4]; 4],
    pub view: [[f32; 4]; 4],
    pub viewport: [f32; 4],
    pub glyph_bounds: [f32; 4],
    pub p0: [f32; 4],
    pub p1: [f32; 4],
    pub p2: [f32; 4],
    pub glow: [f32; 4],
    pub ripple: [f32; 4],
    pub pointer: [f32; 4],
    pub panel: [f32; 4],
    pub panel_motion: [f32; 4],
}

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

/// Same semantics as mozi-app `NoticeQueue`: coalesce by key, outcomes win over chatter, bounded backlog.
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

/// Orbit camera with damping-free direct control plus an idle cruise.
pub struct OrbitCamera {
    pub yaw: f32,
    pub pitch: f32,
    pub distance: f32,
    pub last_interaction: f32,
}

impl Default for OrbitCamera {
    fn default() -> Self {
        Self { yaw: 0.0, pitch: 0.0, distance: crate::render_config::CAMERA_INITIAL_DISTANCE, last_interaction: -100.0 }
    }
}

impl OrbitCamera {
    const MAX_PITCH: f32 = std::f32::consts::PI * 0.3;

    pub fn rotate(&mut self, dx: f32, dy: f32, now: f32) {
        self.yaw -= dx * 0.005;
        self.pitch = (self.pitch + dy * 0.005).clamp(-Self::MAX_PITCH, Self::MAX_PITCH);
        self.last_interaction = now;
    }

    pub fn zoom(&mut self, steps: f32, now: f32) {
        self.distance = (self.distance * 0.9f32.powf(steps)).clamp(5.0, 35.0);
        self.last_interaction = now;
    }

    pub fn reset(&mut self, now: f32) {
        *self = Self { last_interaction: now, ..Self::default() };
    }

    pub fn eye(&self, now: f32, cruise: bool) -> Vec3 {
        let idle = ((now - self.last_interaction - 4.0) / 3.0).clamp(0.0, 1.0);
        let k = if cruise { idle } else { 0.0 };
        let yaw = self.yaw + (now * 0.07).sin() * 0.28 * k;
        let pitch = (self.pitch + (now * 0.05).sin() * 0.12 * k).clamp(-Self::MAX_PITCH, Self::MAX_PITCH);
        Vec3::new(pitch.cos() * yaw.sin(), pitch.sin(), pitch.cos() * yaw.cos()) * self.distance
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectionRole { User, Assistant, Activity }

#[derive(Debug, Clone, serde::Deserialize)]
pub struct Projection {
    pub key: String,
    pub text: String,
    pub role: ProjectionRole,
    pub streaming: bool,
}

pub struct GlyphUpload {
    pub instances: Vec<GlyphInstance>,
}

pub struct Scene {
    pub time: f32,
    pub paused: bool,
    pub cruise: bool,
    pub camera: OrbitCamera,
    pub style: &'static ParticleStyle,
    pub depth: f32,
    queue: NoticeQueue,
    pending_projection: Option<Projection>,
    streaming: bool,
    read_until: Option<f32>,
    glyph_instances: Vec<GlyphInstance>,
    transition_from: Vec<GlyphInstance>,
    transition_to: Vec<GlyphInstance>,
    transition_age: f32,
    bags: BagPicker,
    rng: LcgRng,
    font: Option<FontArc>,
    glyph_start: f32,
    glyph_bounds: [f32; 4],
    in_mode: f32,
    out_mode: f32,
    dance_mode: f32,
    dance_dir: [f32; 2],
    drift: [f32; 2],
    glow: [f32; 3],
    ripple: [f32; 3],
    pointer_world: Vec2,
    pointer_strength: f32,
    pointer_target: f32,
    pub current: Option<Notice>,
}

impl Scene {
    pub fn new(font: Option<FontArc>, style_id: Option<&str>) -> Self {
        Self {
            time: 0.0,
            paused: false,
            cruise: true,
            camera: OrbitCamera::default(),
            style: find_style(style_id.unwrap_or("auto")),
            depth: 1.0,
            queue: NoticeQueue::default(),
            pending_projection: None,
            streaming: false,
            read_until: None,
            glyph_instances: Vec::new(),
            transition_from: Vec::new(),
            transition_to: Vec::new(),
            transition_age: 1.0,
            bags: BagPicker::new(),
            rng: LcgRng::new(0x0DDB_A11C_0FFE_E000),
            font,
            glyph_start: -100.0,
            glyph_bounds: [0.0, 0.0, 1.0, 0.3],
            in_mode: 0.0,
            out_mode: 0.0,
            dance_mode: 0.0,
            dance_dir: [1.0, 0.0],
            drift: [1.0, 0.0],
            glow: Tone::Activity.glow(),
            ripple: [0.0, 0.0, -100.0],
            pointer_world: Vec2::ZERO,
            pointer_strength: 0.0,
            pointer_target: 0.0,
            current: None,
        }
    }

    pub fn set_style(&mut self, id: &str) {
        self.style = find_style(id);
    }

    pub fn cycle_style(&mut self) -> &'static str {
        let idx = PARTICLE_STYLES.iter().position(|s| s.id == self.style.id).unwrap_or(0);
        self.style = &PARTICLE_STYLES[(idx + 1) % PARTICLE_STYLES.len()];
        self.style.name
    }

    pub fn enqueue(&mut self, notice: Notice) {
        self.queue.push(notice);
    }

    pub fn glyph_age(&self) -> f32 {
        let age = self.time - self.glyph_start;
        if let Some(deadline) = self.read_until {
            let release = if self.streaming || self.pending_projection.is_some() { 0.0 } else { (self.time - deadline).max(0.0) };
            age.min(GLYPH_LANDING + 0.2) + release
        } else { age }
    }

    pub fn project(&mut self, content: Option<Projection>) {
        self.queue = NoticeQueue::default();
        // A finish marker for unchanged text updates lifetime, without restarting its reading timer.
        if let Some(ref next) = content {
            if self.current.as_ref().is_some_and(|n| n.key == next.key && n.text == Self::projection_text(next)) {
                self.streaming = next.streaming;
                self.pending_projection = None;
                return;
            }
        }
        self.pending_projection = content;
        if self.pending_projection.is_none() {
            self.streaming = false;
            self.read_until = None;
            self.current = None;
            self.glyph_start = -100.0;
            self.transition_age = 1.0;
        }
    }

    fn projection_text(content: &Projection) -> String {
        let prefix = match content.role { ProjectionRole::User => "你：", ProjectionRole::Assistant => "AI：", ProjectionRole::Activity => "" };
        format!("{}{}", prefix, content.text)
    }

    fn apply_projection(&mut self, content: Projection, field: &FieldSamples) -> Option<GlyphUpload> {
        let text = Self::projection_text(&content);
        let reading = PROJECTION_MIN_READ_SECONDS.max(text.chars().count() as f32 / PROJECTION_READ_CHARS_PER_SECOND);
        let continuing = self.glyph_visible() && !self.glyph_instances.is_empty();
        let age = self.glyph_age();
        self.streaming = content.streaming;
        if continuing { self.glyph_start = self.time - age.min(GLYPH_LANDING + 0.2); }
        if self.current.as_ref().is_some_and(|n| n.key == content.key && n.text == text) {
            return None;
        }
        let notice = Notice { key: content.key, text, tone: Tone::Activity };
        if !continuing {
            let upload = self.start(notice, field);
            self.read_until = Some(self.time + GLYPH_LANDING + reading);
            if matches!(content.role, ProjectionRole::User) { self.glow = [0.4, 0.75, 1.0]; }
            return Some(upload);
        }
        let targets = sample_text(&notice.text, self.font.as_ref());
        let (next, bounds) = fill_event_buffers(&targets, field, &mut self.rng);
        // Rebase on the currently displayed targets, including mid-transition updates.
        self.transition_from = self.glyph_instances.clone();
        self.transition_to = next;
        self.transition_age = 0.0;
        self.read_until = Some(self.time + PROJECTION_TRANSITION_SECONDS + reading);
        self.glyph_bounds = [bounds.center[0], bounds.center[1], bounds.half_size[0], bounds.half_size[1]];
        self.glow = if matches!(content.role, ProjectionRole::User) { [0.4, 0.75, 1.0] } else { Tone::Activity.glow() };
        self.current = Some(notice);
        None
    }

    pub fn glyph_visible(&self) -> bool {
        let age = self.glyph_age();
        (0.0..=EVENT_DURATION).contains(&age)
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

    pub fn ripple_at(&mut self, p: Vec2) {
        self.ripple = [p.x, p.y, self.time];
    }

    /// Advances time; returns a new glyph buffer to upload when a notice starts.
    pub fn update(&mut self, dt: f32, field: &FieldSamples) -> Option<GlyphUpload> {
        if self.paused {
            return None;
        }
        self.time += dt;
        let k = 1.0 - (-dt * 6.0).exp();
        self.pointer_strength += (self.pointer_target - self.pointer_strength) * k;

        if self.read_until.is_none_or(|deadline| self.time >= deadline) {
            if let Some(content) = self.pending_projection.take() {
                if let Some(upload) = self.apply_projection(content, field) { return Some(upload); }
            }
        }
        if self.transition_age < PROJECTION_TRANSITION_SECONDS {
            self.transition_age = (self.transition_age + dt).min(PROJECTION_TRANSITION_SECONDS);
            let t = self.transition_age / PROJECTION_TRANSITION_SECONDS;
            let blend = t * t * (3.0 - 2.0 * t);
            for ((current, from), to) in self.glyph_instances.iter_mut().zip(&self.transition_from).zip(&self.transition_to) {
                for axis in 0..3 { current.target_pos[axis] = from.target_pos[axis] + (to.target_pos[axis] - from.target_pos[axis]) * blend; }
            }
            return Some(GlyphUpload { instances: self.glyph_instances.clone() });
        }
        if self.glyph_visible() {
            return None;
        }
        self.current = None;
        let notice = self.queue.take()?;
        Some(self.start(notice, field))
    }

    fn start(&mut self, notice: Notice, field: &FieldSamples) -> GlyphUpload {
        self.read_until = None;
        let targets = sample_text(&notice.text, self.font.as_ref());
        let (instances, bounds) = fill_event_buffers(&targets, field, &mut self.rng);
        let style = self.style;
        let to_u32 = |modes: &[crate::styles::GlyphMove]| modes.iter().map(|m| *m as u32).collect::<Vec<_>>();
        self.in_mode = self.bags.pick("in", &to_u32(style.in_modes)) as f32;
        self.out_mode = self.bags.pick("out", &to_u32(style.out_modes)) as f32;
        let dances: Vec<u32> = style.dances.iter().map(|d| *d as u32).collect();
        self.dance_mode = self.bags.pick("dance", &dances) as f32;
        self.dance_dir = self.bags.next_unit_dir();
        self.drift = self.bags.next_unit_dir();
        self.glyph_bounds = [bounds.center[0], bounds.center[1], bounds.half_size[0], bounds.half_size[1]];
        self.glow = notice.tone.glow();
        self.glyph_start = self.time;
        // The ripple fires as the strokes land, like Terse's arrival pulse.
        self.ripple = [bounds.center[0], bounds.center[1], self.time + GLYPH_LANDING * 0.85];
        self.current = Some(notice);
        self.glyph_instances = instances.clone();
        self.transition_age = 1.0;
        GlyphUpload { instances }
    }

    pub fn matrices(&self, width: f32, height: f32) -> (Mat4, Mat4) {
        let aspect = (width / height.max(1.0)).max(0.1);
        let proj = Mat4::perspective_rh(crate::render_config::CAMERA_FOV_DEGREES.to_radians(), aspect, 0.1, 100.0);
        let view = Mat4::look_at_rh(self.camera.eye(self.time, self.cruise), Vec3::ZERO, Vec3::Y);
        (proj, view)
    }

    /// Intersects the cursor ray with the z = 0 wallpaper plane.
    pub fn unproject(&self, x: f32, y: f32, width: f32, height: f32) -> Option<Vec2> {
        let (proj, view) = self.matrices(width, height);
        let inv = (proj * view).inverse();
        let ndc = Vec2::new(x / width * 2.0 - 1.0, 1.0 - y / height * 2.0);
        let near = inv.project_point3(Vec3::new(ndc.x, ndc.y, 0.0));
        let far = inv.project_point3(Vec3::new(ndc.x, ndc.y, 1.0));
        let dz = far.z - near.z;
        if dz.abs() < 1e-6 {
            return None;
        }
        let t = -near.z / dz;
        (t >= 0.0).then(|| (near + (far - near) * t).truncate())
    }

    pub fn globals(&self, width: f32, height: f32, dpr: f32) -> Globals {
        let (proj, view) = self.matrices(width, height);
        Globals {
            view_proj: (proj * view).to_cols_array_2d(),
            view: view.to_cols_array_2d(),
            viewport: [width, height, dpr, self.time],
            glyph_bounds: self.glyph_bounds,
            p0: [self.depth, self.glyph_age(), self.style.pulse_alpha, self.dance_mode],
            p1: [self.dance_dir[0], self.dance_dir[1], self.in_mode, self.out_mode],
            p2: [self.style.swirl, self.style.disp_fade, self.drift[0], self.drift[1]],
            glow: [self.glow[0], self.glow[1], self.glow[2], 0.5],
            ripple: [self.ripple[0], self.ripple[1], self.ripple[2], 0.0],
            pointer: [self.pointer_world.x, self.pointer_world.y, self.pointer_strength, 0.0],
            panel: [0.0; 4],
            panel_motion: [0.0; 4],
        }
    }
}

pub fn find_style(id: &str) -> &'static ParticleStyle {
    PARTICLE_STYLES.iter().find(|s| s.id == id).unwrap_or(&PARTICLE_STYLES[0])
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn bag_picker_never_repeats_back_to_back() {
        let mut bags = BagPicker::new();
        let pool: Vec<u32> = (0..9).collect();
        let mut prev = u32::MAX;
        let mut seen = std::collections::HashSet::new();
        for _ in 0..90 {
            let v = bags.pick("in", &pool);
            assert_ne!(v, prev);
            seen.insert(v);
            prev = v;
        }
        assert_eq!(seen.len(), 9);
    }

    #[test]
    fn unproject_center_hits_origin() {
        let scene = Scene::new(None, None);
        let p = scene.unproject(640.0, 430.0, 1280.0, 860.0).unwrap();
        assert!(p.length() < 1e-3);
    }
    #[test]
    fn streaming_projection_retargets_without_reassembling_and_finishes() {
        let field = crate::sampling::sample_field(&crate::sampling::create_landscape(16, 12), 16, 12);
        let mut scene = Scene::new(None, None);
        let content = |text: &str, streaming| Projection { key: "a".into(), text: text.into(), role: ProjectionRole::Assistant, streaming };
        scene.project(Some(content("Hello", true)));
        assert!(scene.update(0.016, &field).is_some());
        for _ in 0..100 { scene.update(0.1, &field); }
        assert!(scene.glyph_visible());
        let previous = scene.glyph_instances.clone();
        scene.project(Some(content("A much longer answer", true)));
        scene.update(0.016, &field);
        assert!(scene.glyph_age() >= GLYPH_LANDING);
        assert_eq!(scene.glyph_instances[0].home_pos, previous[0].home_pos);
        let from = previous[0].target_pos[0];
        let to = scene.transition_to[0].target_pos[0];
        let current = scene.glyph_instances[0].target_pos[0];
        assert!(current >= from.min(to) && current <= from.max(to));
        assert!((current - from).abs() < (to - from).abs() + 0.0001);
        scene.project(Some(content("A much longer answer", false)));
        for _ in 0..100 { scene.update(0.1, &field); }
        assert!(!scene.glyph_visible());
        scene.project(Some(content("new", true)));
        scene.update(0.1, &field);
        scene.project(None);
        assert!(!scene.glyph_visible());
        assert!(scene.current.is_none());
    }

    #[test]
    fn fast_stream_keeps_reading_time_and_only_displays_latest_pending_text() {
        let field = crate::sampling::sample_field(&crate::sampling::create_landscape(16, 12), 16, 12);
        let mut scene = Scene::new(None, None);
        let content = |key: &str, text: &str, streaming| Projection { key: key.into(), text: text.into(), role: ProjectionRole::Assistant, streaming };
        scene.project(Some(content("user", "Question", false)));
        scene.update(0.01, &field);
        let first_deadline = scene.read_until.unwrap();
        for i in 0..20 {
            scene.project(Some(content("answer", &format!("delta {i}"), true)));
            scene.update(0.03, &field);
            assert_eq!(scene.current.as_ref().unwrap().key, "user");
        }
        scene.project(Some(content("answer", "Final answer", false)));
        scene.update(first_deadline - scene.time - 0.01, &field);
        assert_eq!(scene.current.as_ref().unwrap().key, "user");
        assert!(scene.glyph_visible());
        scene.update(0.02, &field);
        assert_eq!(scene.current.as_ref().unwrap().text, "AI：Final answer");
        assert!(scene.pending_projection.is_none());
        let final_deadline = scene.read_until.unwrap();
        assert!(final_deadline - scene.time >= PROJECTION_MIN_READ_SECONDS);
        scene.project(Some(content("answer", "Final answer", false)));
        assert_eq!(scene.read_until.unwrap(), final_deadline);
        scene.update(PROJECTION_TRANSITION_SECONDS + PROJECTION_MIN_READ_SECONDS - 0.1, &field);
        assert!(scene.glyph_age() < crate::sampling::GLYPH_RELEASE);
        scene.project(None);
        assert!(!scene.glyph_visible());
        assert!(scene.read_until.is_none());
        scene.project(Some(content("new", "New session", true)));
        scene.update(0.01, &field);
        assert_eq!(scene.current.as_ref().unwrap().key, "new");
    }

}
