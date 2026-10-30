//! The one and only scene camera. Every layer (field, glyph, Markdown) reads its matrices through
//! the shared frame uniform, so drag-rotate, wheel-zoom and idle cruise always move them together.

use glam::{Mat4, Vec2, Vec3};

use crate::render_config::{CAMERA_FOV_DEGREES, CAMERA_INITIAL_DISTANCE};

/// Orbit camera with damping-free direct control plus an idle cruise.
pub struct OrbitCamera {
    pub yaw: f32,
    pub pitch: f32,
    pub distance: f32,
    pub last_interaction: f32,
    pub cruise: bool,
}

impl Default for OrbitCamera {
    fn default() -> Self {
        Self { yaw: 0.0, pitch: 0.0, distance: CAMERA_INITIAL_DISTANCE, last_interaction: -100.0, cruise: true }
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
        *self = Self { last_interaction: now, cruise: self.cruise, ..Self::default() };
    }

    fn eye(&self, now: f32) -> Vec3 {
        let idle = ((now - self.last_interaction - 4.0) / 3.0).clamp(0.0, 1.0);
        let k = if self.cruise { idle } else { 0.0 };
        let yaw = self.yaw + (now * 0.07).sin() * 0.28 * k;
        let pitch = (self.pitch + (now * 0.05).sin() * 0.12 * k).clamp(-Self::MAX_PITCH, Self::MAX_PITCH);
        Vec3::new(pitch.cos() * yaw.sin(), pitch.sin(), pitch.cos() * yaw.cos()) * self.distance
    }

    /// (projection, view) for a viewport in physical pixels.
    pub fn matrices(&self, now: f32, width: f32, height: f32) -> (Mat4, Mat4) {
        let aspect = (width / height.max(1.0)).max(0.1);
        let proj = Mat4::perspective_rh(CAMERA_FOV_DEGREES.to_radians(), aspect, 0.1, 100.0);
        let view = Mat4::look_at_rh(self.eye(now), Vec3::ZERO, Vec3::Y);
        (proj, view)
    }

    /// Intersects the cursor ray with the z = 0 wallpaper plane.
    pub fn unproject(&self, now: f32, x: f32, y: f32, width: f32, height: f32) -> Option<Vec2> {
        let (proj, view) = self.matrices(now, width, height);
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unproject_center_hits_origin() {
        let camera = OrbitCamera::default();
        let p = camera.unproject(0.0, 640.0, 430.0, 1280.0, 860.0).unwrap();
        assert!(p.length() < 1e-3);
    }

    #[test]
    fn reset_keeps_cruise_preference() {
        let mut camera = OrbitCamera { cruise: false, ..OrbitCamera::default() };
        camera.rotate(100.0, 50.0, 1.0);
        camera.reset(2.0);
        assert!(!camera.cruise);
        assert_eq!(camera.yaw, 0.0);
    }
}
