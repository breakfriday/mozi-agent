//! Conversation projection layer.
//! - Assistant replies are Markdown → rendered off-thread by Wordcraft (started lazily).
//! - User messages and tool activity are plain strings → rendered synchronously by `PlainTextRenderer`.
//! Both produce `Raster`s; the board composes them on the main thread, so a user message never
//! waits behind an in-flight Wordcraft render.
pub mod board;
pub mod plain_text;
pub mod wordcraft;

use std::{collections::HashMap, sync::Arc};

use ab_glyph::FontArc;

pub use board::Particle;
pub use wordcraft::Completed;

use board::{Animation, Entry, Layout, Raster};
use plain_text::PlainTextRenderer;
use wordcraft::{Job, Worker};

use crate::protocol::ProjectionRole;
use crate::render::uniforms::PanelParams;
use crate::render_config::*;

type Result<T> = std::result::Result<T, String>;

struct Cached {
    text: String,
    role: ProjectionRole,
    column: Layout,
    /// `None` when rendering failed: the block is resolved but has nothing to show.
    raster: Option<Raster>,
}

pub struct Panel {
    worker: Option<Worker>,
    deliver: Arc<dyn Fn(Completed) + Send + Sync>,
    plain: PlainTextRenderer,
    entries: Vec<Entry>,
    cache: HashMap<u64, Cached>,
    next_id: u64,
    visible: bool,
    dirty: bool,
    animation: Animation,
    layout: Layout,
    displayed_layout: Layout,
}

impl Panel {
    pub fn new(font: Option<FontArc>, deliver: impl Fn(Completed) + Send + Sync + 'static) -> Self {
        Self {
            worker: None,
            deliver: Arc::new(deliver),
            plain: PlainTextRenderer::new(font),
            entries: Vec::new(),
            cache: HashMap::new(),
            next_id: 1,
            visible: false,
            dirty: false,
            animation: Animation::default(),
            layout: Layout::default(),
            displayed_layout: Layout::default(),
        }
    }

    pub fn resize(&mut self, width: u32, height: u32, scale: f64) -> Result<()> {
        if width == 0 || height == 0 {
            return Ok(());
        }
        let layout = Layout::viewport(width, height, scale);
        if layout == self.layout {
            return Ok(());
        }
        self.layout = layout;
        self.refresh()
    }

    pub fn project(&mut self, key: &str, text: &str, role: ProjectionRole) -> Result<()> {
        if let Some(entry) = self.entries.iter_mut().find(|e| e.key == key) {
            if entry.text == text && entry.role == role {
                return Ok(());
            }
            entry.text = text.into();
            entry.role = role;
        } else {
            self.entries.push(Entry { id: self.next_id, key: key.into(), text: text.into(), role });
            self.next_id += 1;
        }
        self.refresh()
    }

    pub fn clear(&mut self) {
        self.animation.clear();
        self.entries.clear();
        self.cache.clear();
        self.visible = false;
        self.dirty = true;
        // Ids are never reused, so late Wordcraft results for cleared entries are simply ignored.
        if let Some(worker) = &self.worker {
            worker.submit(Vec::new());
        }
    }

    /// Accepts one Wordcraft block. Stale text is still useful (it shows until the newer render lands);
    /// results for removed entries or a previous page size are dropped.
    pub fn accept(&mut self, completed: Completed) -> Result<()> {
        let Some(entry) = self.entries.iter().find(|e| e.id == completed.id) else { return Ok(()) };
        if self.layout.column(entry.right()) != completed.column {
            return Ok(());
        }
        let error = completed.result.as_ref().err().cloned();
        self.cache.insert(
            completed.id,
            Cached { text: completed.text, role: entry.role.clone(), column: completed.column, raster: completed.result.ok() },
        );
        self.dirty = true;
        error.map_or(Ok(()), Err)
    }

    /// Forces the next `take_frame` to recompose (e.g. after the GPU surface is (re)created).
    pub fn invalidate(&mut self) {
        self.dirty = true;
    }

    fn column_of(&self, entry: &Entry) -> Layout {
        self.layout.column(entry.right())
    }

    /// Renders plain blocks now and hands stale assistant blocks to Wordcraft.
    fn refresh(&mut self) -> Result<()> {
        let mut jobs = Vec::new();
        let mut first_error = None;
        for entry in &self.entries {
            let column = self.column_of(entry);
            let fresh = self
                .cache
                .get(&entry.id)
                .is_some_and(|c| c.column == column && c.text == entry.text && c.role == entry.role);
            if fresh {
                continue;
            }
            if entry.role == ProjectionRole::Assistant {
                jobs.push(Job { id: entry.id, text: entry.text.clone(), column });
                continue;
            }
            let result = self.plain.render(&entry.text, &entry.role, column);
            if let Err(message) = &result {
                first_error.get_or_insert_with(|| message.clone());
            }
            self.cache.insert(
                entry.id,
                Cached { text: entry.text.clone(), role: entry.role.clone(), column, raster: result.ok() },
            );
        }
        self.dirty = true;
        if !jobs.is_empty() {
            if self.worker.is_none() {
                self.worker = Some(Worker::new(self.deliver.clone())?);
            }
            if let Some(worker) = &self.worker {
                worker.submit(jobs);
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    /// Recomposes the board if anything changed and returns the particle buffer to upload.
    pub fn take_frame(&mut self, now: f32) -> Option<&[Particle]> {
        if !self.dirty {
            return None;
        }
        self.dirty = false;
        if self.layout != self.displayed_layout {
            // Keep the previous page on screen until every block exists at the new page size.
            let ready = self
                .entries
                .iter()
                .all(|e| self.cache.get(&e.id).is_some_and(|c| c.column == self.column_of(e)));
            if !ready {
                return None;
            }
            self.animation.clear();
            self.displayed_layout = self.layout;
        }
        let blocks: Vec<(&Entry, &Raster)> = self
            .entries
            .iter()
            .filter_map(|e| {
                let cached = self.cache.get(&e.id).filter(|c| c.column == self.column_of(e))?;
                cached.raster.as_ref().map(|r| (e, r))
            })
            .collect();
        let composition = board::compose(&blocks, self.displayed_layout);
        let evicted: Vec<u64> = composition
            .considered
            .iter()
            .copied()
            .filter(|id| !composition.retained.contains(id))
            .collect();
        if !evicted.is_empty() {
            self.entries.retain(|e| !evicted.contains(&e.id));
            self.cache.retain(|id, _| !evicted.contains(id));
        }
        self.visible = !composition.particles.is_empty();
        Some(self.animation.update(&composition.particles, now))
    }

    pub fn params(&self, width: f32, height: f32) -> PanelParams {
        let layout = self.displayed_layout;
        PanelParams {
            panel: [
                if self.visible { 1.0 } else { 0.0 },
                MARKDOWN_WORLD_WIDTH / (layout.width as f32 * MARKDOWN_SCALE) * MARKDOWN_SAMPLE_STRIDE as f32,
                MARKDOWN_ASSEMBLE_SECONDS,
                MARKDOWN_DISPERSE_SECONDS,
            ],
            motion: [MARKDOWN_REFLOW_SECONDS, layout.world_scale(width, height), MARKDOWN_PLANE_Z, MARKDOWN_MIN_RADIUS_PX],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::camera::OrbitCamera;
    use crate::layers::glyph::load_system_font;

    #[test]
    fn reading_page_fits_viewport_and_dpi_keeps_layout_density() {
        for (width, height) in [(1280, 860), (1920, 1080), (3440, 1440), (900, 1600)] {
            let layout = Layout::viewport(width, height, 1.0);
            assert!(layout.width <= 1584 && layout.height <= 1584);
            assert_eq!(layout, Layout::viewport(width * 2, height * 2, 2.0));
            let scale = layout.world_scale(width as f32, height as f32);
            let matrix = glam::Mat4::perspective_rh(CAMERA_FOV_DEGREES.to_radians(), width as f32 / height as f32, 0.1, 100.0)
                * glam::Mat4::look_at_rh(glam::Vec3::Z * CAMERA_INITIAL_DISTANCE, glam::Vec3::ZERO, glam::Vec3::Y);
            let half_width = MARKDOWN_WORLD_WIDTH * 0.5 * scale;
            let half_height = half_width * layout.height as f32 / layout.width as f32;
            let center = matrix.project_point3(glam::Vec3::new(0.0, 0.0, MARKDOWN_PLANE_Z));
            assert!(center.x.abs() < 1e-5 && center.y.abs() < 1e-5);
            for x in [-half_width, half_width] {
                for y in [-half_height, half_height] {
                    let point = matrix.project_point3(glam::Vec3::new(x, y, MARKDOWN_PLANE_Z));
                    assert!(point.x.abs() <= MARKDOWN_VIEW_WIDTH + 1e-5);
                    assert!(point.y.abs() <= MARKDOWN_VIEW_HEIGHT + 1e-5);
                }
            }
        }
        let window = Layout::viewport(1280, 860, 1.0);
        let fullscreen = Layout::viewport(1920, 1080, 1.0);
        assert!(fullscreen.width > window.width && fullscreen.height > window.height);
    }

    #[test]
    fn text_and_background_follow_the_same_orbit_and_zoom() {
        let mut camera = OrbitCamera { cruise: false, ..OrbitCamera::default() };
        let scale = Layout::viewport(1920, 1080, 1.0).world_scale(1920.0, 1080.0);
        let text = glam::Vec3::new(3.0 * scale, 1.0 * scale, MARKDOWN_PLANE_Z);
        let background = glam::Vec3::new(3.0, 1.0, 0.0);
        let project = |camera: &OrbitCamera, point| {
            let (projection, view) = camera.matrices(0.0, 1920.0, 1080.0);
            (projection * view).project_point3(point).truncate()
        };
        let before_text = project(&camera, text);
        let before_background = project(&camera, background);
        camera.zoom(2.0, 0.0);
        assert!(project(&camera, text).length() > before_text.length());
        assert!(project(&camera, background).length() > before_background.length());
        let zoomed_text = project(&camera, text);
        let zoomed_background = project(&camera, background);
        camera.rotate(80.0, 40.0, 0.0);
        assert!(project(&camera, text).distance(zoomed_text) > 0.01);
        assert!(project(&camera, background).distance(zoomed_background) > 0.01);
    }

    #[test]
    fn user_and_activity_render_immediately_without_wordcraft() {
        let Some(font) = load_system_font() else { return };
        let mut panel = Panel::new(Some(font), |_| panic!("plain text must not reach Wordcraft"));
        panel.resize(1280, 860, 1.0).unwrap();
        panel.project("u1", "先解释实现原理", ProjectionRole::User).unwrap();
        panel.project("t1", "执行 bash", ProjectionRole::Activity).unwrap();
        assert!(panel.worker.is_none(), "wordcraft-cli is never started for plain strings");
        let count = panel.take_frame(1.0).expect("composed synchronously").len();
        assert!(count > 100);
        assert!(panel.params(1280.0, 860.0).panel[0] > 0.0);
        assert!(panel.take_frame(1.1).is_none(), "nothing changed");
        panel.clear();
        assert!(panel.take_frame(1.2).unwrap().is_empty());
        assert_eq!(panel.params(1280.0, 860.0).panel[0], 0.0);
    }

    #[test]
    fn resize_keeps_old_page_until_assistant_block_arrives() {
        let Some(font) = load_system_font() else { return };
        let mut panel = Panel::new(Some(font), |_| {});
        panel.resize(1280, 860, 1.0).unwrap();
        panel.project("u1", "问题", ProjectionRole::User).unwrap();
        // Simulate an assistant entry whose Wordcraft raster already landed (no process needed).
        panel.entries.push(Entry { id: 99, key: "a1".into(), text: "# 回答".into(), role: ProjectionRole::Assistant });
        let raster = |column: Layout| Raster {
            image: image::RgbImage::from_pixel((column.width as f32 * MARKDOWN_SCALE) as u32, 20, image::Rgb([0; 3])),
            source_y: 0,
        };
        let column = panel.layout.column(false);
        panel.accept(Completed { id: 99, text: "# 回答".into(), column, result: Ok(raster(column)) }).unwrap();
        assert!(panel.take_frame(1.0).is_some());
        let before = panel.displayed_layout;

        // New page size: the plain block is resolved instantly, the assistant block is still pending.
        // (Set directly instead of `resize`, which would try to spawn wordcraft-cli for the assistant job.)
        panel.layout = Layout::viewport(1920, 1080, 1.0);
        panel.cache.insert(1, Cached { text: "问题".into(), role: ProjectionRole::User, column: panel.layout.column(true), raster: None });
        panel.invalidate();
        assert!(panel.take_frame(2.0).is_none(), "assistant block not ready at the new size");
        assert_eq!(panel.displayed_layout, before);

        let stale = panel.layout.column(false);
        panel.accept(Completed { id: 99, text: "# 回答".into(), column: stale, result: Ok(raster(stale)) }).unwrap();
        assert!(panel.take_frame(3.0).is_some());
        assert_eq!(panel.displayed_layout, panel.layout);
    }
}
