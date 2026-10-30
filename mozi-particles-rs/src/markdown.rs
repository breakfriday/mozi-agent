//! Wordcraft 0.6.1 stdio MCP adapter. One worker, one replaceable pending render.
//! The panel owns process lifetime, viewport layout and stale-render filtering.
use crate::{
    projection_board::{self, Animation, Entry, Particle, Raster, Sample},
    render_config::*,
    scene::ProjectionRole,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{Arc, Condvar, Mutex},
    thread::{self, JoinHandle},
};

/// Layout uses logical pixels, so changing monitor scale does not change the apparent font size.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Layout {
    width: u32,
    height: u32,
}
impl Default for Layout {
    fn default() -> Self {
        Self {
            width: MARKDOWN_PAGE_WIDTH as u32,
            height: MARKDOWN_PAGE_HEIGHT as u32,
        }
    }
}
impl Layout {
    fn viewport(width: u32, height: u32, scale: f64) -> Self {
        let width =
            width as f64 / scale * MARKDOWN_VIEW_WIDTH as f64 * MARKDOWN_POINTS_PER_PIXEL as f64;
        let height =
            height as f64 / scale * MARKDOWN_VIEW_HEIGHT as f64 * MARKDOWN_POINTS_PER_PIXEL as f64;
        // Wordcraft 0.6.1 layout.size accepts only 72..=1584 pt.
        let fit = (1584.0 / width.max(height)).min(1.0);
        Self {
            width: (width * fit).round().max(72.0) as u32,
            height: (height * fit).round().max(72.0) as u32,
        }
    }

    fn world_scale(self, width: f32, height: f32) -> f32 {
        let world_height = MARKDOWN_WORLD_WIDTH * self.height as f32 / self.width as f32;
        let visible_height = 2.0
            * (CAMERA_INITIAL_DISTANCE - MARKDOWN_PLANE_Z)
            * (CAMERA_FOV_DEGREES.to_radians() * 0.5).tan();
        (visible_height * MARKDOWN_VIEW_HEIGHT / world_height)
            .min(visible_height * width / height * MARKDOWN_VIEW_WIDTH / MARKDOWN_WORLD_WIDTH)
    }
}

type Result<T> = std::result::Result<T, String>;
#[derive(Debug)]
pub struct Frame {
    layout: Layout,
    pub particles: Vec<Sample>,
    considered: Vec<u64>,
    retained: Vec<u64>,
}
#[derive(Debug)]
pub struct Completed {
    generation: u64,
    pub result: Result<Frame>,
}
struct Request {
    layout: Layout,
    generation: u64,
    entries: Vec<Entry>,
}
#[derive(Default)]
struct Pending {
    request: Option<Request>,
    stopped: bool,
}
struct Worker {
    pending: Arc<(Mutex<Pending>, Condvar)>,
    child: Child,
    thread: Option<JoinHandle<()>>,
}
impl Worker {
    fn new(deliver: Arc<dyn Fn(Completed) + Send + Sync>) -> Result<Self> {
        let mut child = Command::new(
            std::env::var_os("MOZI_WORDCRAFT_BIN").unwrap_or_else(|| "wordcraft-cli".into()),
        )
        .arg("mcp")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("start wordcraft-cli: {e}"))?;
        let input = child.stdin.take().unwrap();
        let output = child.stdout.take().unwrap();
        let pending = Arc::new((Mutex::new(Pending::default()), Condvar::new()));
        let queue = pending.clone();
        let thread = thread::spawn(move || {
            let mut client = Client {
                input,
                output: BufReader::new(output),
                id: 0,
            };
            let initialized = client.initialize();
            let mut cache = HashMap::new();
            loop {
                let (lock, wake) = &*queue;
                let mut state = lock.lock().unwrap();
                while state.request.is_none() && !state.stopped {
                    state = wake.wait(state).unwrap();
                }
                if state.stopped {
                    break;
                }
                let request = state.request.take().unwrap();
                drop(state);
                let result = initialized.clone().and_then(|_| {
                    client.render_board(&request.entries, request.layout, &mut cache)
                });
                deliver(Completed {
                    generation: request.generation,
                    result,
                });
            }
        });
        Ok(Self {
            pending,
            child,
            thread: Some(thread),
        })
    }
    fn submit(&self, request: Request) {
        self.pending.0.lock().unwrap().request = Some(request);
        self.pending.1.notify_one();
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.pending.0.lock().unwrap().stopped = true;
        self.pending.1.notify_one();
        // Unblock a worker reading the process pipe before joining it.
        let _ = self.child.kill();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        let _ = self.child.wait();
    }
}

pub struct Panel {
    worker: Option<Worker>,
    deliver: Arc<dyn Fn(Completed) + Send + Sync>,
    generation: u64,
    entries: Vec<Entry>,
    next_id: u64,
    pub visible: bool,
    animation: Animation,
    layout: Layout,
    displayed_layout: Layout,
}
impl Panel {
    pub fn new(deliver: impl Fn(Completed) + Send + Sync + 'static) -> Self {
        Self {
            worker: None,
            deliver: Arc::new(deliver),
            generation: 0,
            entries: Vec::new(),
            next_id: 1,
            visible: false,
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
        // Resize is an actual layout change: reject results for the previous page dimensions.
        self.generation += 1;
        if !self.entries.is_empty() {
            self.submit()?;
        }
        Ok(())
    }
    pub fn world_scale(&self, width: f32, height: f32) -> f32 {
        self.displayed_layout.world_scale(width, height)
    }
    pub fn uniforms(&self) -> [f32; 4] {
        [
            if self.visible { 1.0 } else { 0.0 },
            MARKDOWN_WORLD_WIDTH / (self.displayed_layout.width as f32 * MARKDOWN_SCALE)
                * MARKDOWN_SAMPLE_STRIDE as f32,
            MARKDOWN_ASSEMBLE_SECONDS,
            MARKDOWN_DISPERSE_SECONDS,
        ]
    }
    pub fn project(&mut self, key: &str, text: &str, role: ProjectionRole) -> Result<()> {
        if let Some(entry) = self.entries.iter_mut().find(|e| e.key == key) {
            if entry.text == text && entry.role == role {
                return Ok(());
            }
            entry.text = text.into();
            entry.role = role;
        } else {
            self.entries.push(Entry {
                id: self.next_id,
                key: key.into(),
                text: text.into(),
                role,
            });
            self.next_id += 1;
        }
        self.submit()
    }
    fn submit(&mut self) -> Result<()> {
        if self.worker.is_none() {
            self.worker = Some(Worker::new(self.deliver.clone())?);
        }
        self.worker.as_ref().unwrap().submit(Request {
            layout: self.layout,
            generation: self.generation,
            entries: self.entries.clone(),
        });
        Ok(())
    }
    pub fn animate(&mut self, frame: &Frame, now: f32) -> &[Particle] {
        self.animation.update(&frame.particles, now)
    }
    pub fn clear(&mut self) {
        self.animation.clear();
        self.generation += 1;
        self.entries.clear();
        self.visible = false;
        if let Some(worker) = &self.worker {
            // Empty work also drops cached rasters in the worker; no previous content survives clear.
            worker.submit(Request {
                layout: self.layout,
                generation: self.generation,
                entries: Vec::new(),
            });
        }
    }
    pub fn accept(&mut self, completed: Completed) -> Option<Result<Frame>> {
        if completed.generation != self.generation {
            return None;
        }
        if let Ok(frame) = &completed.result {
            if self.displayed_layout != frame.layout {
                self.animation.clear();
                self.displayed_layout = frame.layout;
            }
            // Prune only entries considered by this result; newer incoming blocks stay queued.
            self.entries
                .retain(|e| !frame.considered.contains(&e.id) || frame.retained.contains(&e.id));
            self.visible = !frame.particles.is_empty();
        }
        Some(completed.result)
    }
}

struct Client {
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    id: u64,
}
impl Client {
    fn rpc(&mut self, method: &str, params: Value) -> Result<Value> {
        self.id += 1;
        writeln!(
            self.input,
            "{}",
            json!({"jsonrpc":"2.0","id":self.id,"method":method,"params":params})
        )
        .map_err(|e| e.to_string())?;
        self.input.flush().map_err(|e| e.to_string())?;
        loop {
            let mut line = String::new();
            if self
                .output
                .read_line(&mut line)
                .map_err(|e| e.to_string())?
                == 0
            {
                return Err("wordcraft-cli closed stdout".into());
            }
            let value: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
            if value["id"].as_u64() != Some(self.id) {
                continue;
            }
            if let Some(error) = value.get("error") {
                return Err(error.to_string());
            }
            return Ok(value["result"].clone());
        }
    }
    fn initialize(&mut self) -> Result<()> {
        let info = self.rpc("initialize", json!({"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"mozi-particles","version":"0.1"}}))?;
        eprintln!(
            "[mozi-particles] Wordcraft {}",
            info["serverInfo"]["version"]
        );
        writeln!(
            self.input,
            "{}",
            json!({"jsonrpc":"2.0","method":"notifications/initialized"})
        )
        .map_err(|e| e.to_string())?;
        self.input.flush().map_err(|e| e.to_string())
    }
    fn tool(&mut self, name: &str, arguments: Value) -> Result<Value> {
        let result = self.rpc("tools/call", json!({"name":name,"arguments":arguments}))?;
        if result["isError"].as_bool() == Some(true) {
            return Err(result.to_string());
        }
        Ok(result)
    }
    fn render_board(
        &mut self,
        entries: &[Entry],
        layout: Layout,
        cache: &mut HashMap<u64, Cached>,
    ) -> Result<Frame> {
        let mut blocks = Vec::new();
        for entry in entries {
            let fraction = if entry.right() {
                PROJECTION_RIGHT_FRACTION
            } else {
                PROJECTION_LEFT_FRACTION
            };
            let column = Layout {
                width: (layout.width as f32 * fraction).round().max(72.0) as u32,
                height: layout.height,
            };
            let hit = cache.get(&entry.id).filter(|c| {
                c.layout == column && c.entry.text == entry.text && c.entry.role == entry.role
            });
            let raster = match hit {
                Some(c) => c.raster.clone(),
                None => {
                    let raster = self.render_block(entry, column)?;
                    cache.insert(
                        entry.id,
                        Cached {
                            entry: entry.clone(),
                            layout: column,
                            raster: raster.clone(),
                        },
                    );
                    raster
                }
            };
            blocks.push((entry.clone(), raster));
        }
        let width = (layout.width as f32 * MARKDOWN_SCALE).round() as u32;
        let height = (layout.height as f32 * MARKDOWN_SCALE).round() as u32;
        let placements = projection_board::placements(
            &blocks,
            height,
            (PROJECTION_BLOCK_GAP_PT * MARKDOWN_SCALE) as u32,
        );
        let mut particles = Vec::new();
        let mut retained = Vec::new();
        for (index, y) in placements {
            let (entry, raster) = &blocks[index];
            let x = if entry.right() {
                width - raster.image.width()
            } else {
                0
            };
            particles.extend(projection_board::samples(
                entry, raster, x, y, width, height,
            ));
            retained.push(entry.id);
        }
        cache.retain(|id, _| retained.contains(id));
        Ok(Frame {
            layout,
            particles,
            considered: entries.iter().map(|e| e.id).collect(),
            retained,
        })
    }
    fn render_block(&mut self, entry: &Entry, layout: Layout) -> Result<Raster> {
        for (command, params) in [
            (
                "file.open",
                json!({"path":"projection.md","data":STANDARD.encode(&entry.text)}),
            ),
            (
                "layout.size",
                json!({"width":layout.width,"height":layout.height}),
            ),
            (
                "layout.orientation",
                json!({"value":if layout.width >= layout.height { "landscape" } else { "portrait" }}),
            ),
            (
                "layout.margins",
                json!({"top":MARKDOWN_MARGIN,"bottom":MARKDOWN_MARGIN,"left":MARKDOWN_MARGIN,"right":MARKDOWN_MARGIN}),
            ),
        ] {
            self.tool("execute", json!({"command":command,"params":params}))?;
        }
        if entry.role != ProjectionRole::Assistant {
            self.tool("execute", json!({"command":"select.all","params":{}}))?;
            let size = match entry.role {
                ProjectionRole::User
                    if entry.text.chars().count() <= PROJECTION_USER_SHORT_CHARS =>
                {
                    PROJECTION_USER_SHORT_FONT_PT
                }
                ProjectionRole::User => PROJECTION_USER_LONG_FONT_PT,
                _ => PROJECTION_ACTIVITY_FONT_PT,
            };
            self.tool(
                "execute",
                json!({"command":"format.size","params":{"size":size}}),
            )?;
            self.tool("execute", json!({"command":"para.align","params":{"value":if entry.right(){"right"}else{"left"}}}))?;
        }
        let (first, pages) = self.page_image(1)?;
        let page_height = first.height();
        let (image, source_y) = if pages > 1 {
            // Oversized single blocks show the newest viewport of ink. No navigation/history state.
            let previous = if pages == 2 {
                first
            } else {
                self.page_image(pages - 1)?.0
            };
            let last = self.page_image(pages)?.0;
            let mut joined =
                image::RgbImage::from_pixel(last.width(), page_height * 2, image::Rgb([255; 3]));
            image::imageops::replace(&mut joined, &previous, 0, 0);
            image::imageops::replace(&mut joined, &last, 0, page_height as i64);
            (joined, (pages as u32 - 2) * page_height)
        } else {
            (first, 0)
        };
        let end = image
            .enumerate_pixels()
            .filter(|(_, _, p)| p.0.iter().any(|c| *c < 225))
            .map(|(_, y, _)| y + 1)
            .max()
            .unwrap_or(1);
        let end = (end + 4).min(image.height());
        let start = end.saturating_sub(page_height);
        Ok(Raster {
            image: image::imageops::crop_imm(&image, 0, start, image.width(), end - start)
                .to_image(),
            source_y: source_y + start,
        })
    }
    fn page_image(&mut self, page: usize) -> Result<(image::RgbImage, usize)> {
        let result = self.tool("render_page", json!({"page":page,"scale":MARKDOWN_SCALE}))?;
        let blocks = result["content"]
            .as_array()
            .ok_or("missing Wordcraft content")?;
        let data = blocks
            .iter()
            .find(|b| b["type"] == "image")
            .and_then(|b| b["data"].as_str())
            .ok_or("missing Wordcraft PNG")?;
        let info: Value = serde_json::from_str(
            blocks
                .iter()
                .find(|b| b["type"] == "text")
                .and_then(|b| b["text"].as_str())
                .ok_or("missing Wordcraft dimensions")?,
        )
        .map_err(|e| e.to_string())?;
        let pages = info["pages"]
            .as_u64()
            .ok_or("invalid Wordcraft dimensions")? as usize;
        let png = STANDARD.decode(data).map_err(|e| e.to_string())?;
        let image = image::load_from_memory_with_format(&png, image::ImageFormat::Png)
            .map_err(|e| e.to_string())?
            .to_rgb8();
        Ok((image, pages))
    }
}
struct Cached {
    entry: Entry,
    layout: Layout,
    raster: Raster,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reading_page_fits_viewport_and_dpi_keeps_layout_density() {
        for (width, height) in [(1280, 860), (1920, 1080), (3440, 1440), (900, 1600)] {
            let layout = Layout::viewport(width, height, 1.0);
            assert!(layout.width <= 1584 && layout.height <= 1584);
            assert_eq!(layout, Layout::viewport(width * 2, height * 2, 2.0));
            let scale = layout.world_scale(width as f32, height as f32);
            let matrix = glam::Mat4::perspective_rh(
                CAMERA_FOV_DEGREES.to_radians(),
                width as f32 / height as f32,
                0.1,
                100.0,
            ) * glam::Mat4::look_at_rh(
                glam::Vec3::Z * CAMERA_INITIAL_DISTANCE,
                glam::Vec3::ZERO,
                glam::Vec3::Y,
            );
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
        let mut scene = crate::scene::Scene::new(None, None);
        scene.cruise = false;
        let scale = Layout::viewport(1920, 1080, 1.0).world_scale(1920.0, 1080.0);
        let text = glam::Vec3::new(3.0 * scale, 1.0 * scale, MARKDOWN_PLANE_Z);
        let background = glam::Vec3::new(3.0, 1.0, 0.0);
        let project = |scene: &crate::scene::Scene, point| {
            let (projection, view) = scene.matrices(1920.0, 1080.0);
            (projection * view).project_point3(point).truncate()
        };
        let before_text = project(&scene, text);
        let before_background = project(&scene, background);
        scene.camera.zoom(2.0, scene.time);
        assert!(project(&scene, text).length() > before_text.length());
        assert!(project(&scene, background).length() > before_background.length());
        let zoomed_text = project(&scene, text);
        let zoomed_background = project(&scene, background);
        scene.camera.rotate(80.0, 40.0, scene.time);
        assert!(project(&scene, text).distance(zoomed_text) > 0.01);
        assert!(project(&scene, background).distance(zoomed_background) > 0.01);
    }
    #[test]
    #[ignore = "requires installed wordcraft-cli 0.6.1"]
    fn installed_cli_two_columns_update_and_evict_independently() {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut panel = Panel::new(move |result| {
            let _ = tx.send(result);
        });
        let receive = |panel: &mut Panel| {
            panel
                .accept(rx.recv_timeout(std::time::Duration::from_secs(15)).unwrap())
                .unwrap()
                .unwrap()
        };
        panel
            .project("u1", "先解释实现原理", ProjectionRole::User)
            .unwrap();
        let first = receive(&mut panel);
        assert!(first.particles.iter().all(|p| p.vertex.position[0] > 2.4));
        panel
            .project(
                "a1",
                "# 实现原理\n\n内容由 Wordcraft 排版，再转换为三维粒子。",
                ProjectionRole::Assistant,
            )
            .unwrap();
        receive(&mut panel);
        panel
            .project(
                "u2",
                "再说明如何保留以前的问题，而不是每次新回复出现就清空右侧。",
                ProjectionRole::User,
            )
            .unwrap();
        let frame = receive(&mut panel);
        assert_eq!(frame.retained.len(), 3);
        let id = panel.entries.iter().find(|e| e.key == "a1").unwrap().id;
        panel.project("a1", "# 实现原理\n\n内容由 Wordcraft 排版，再转换为三维粒子。\n\n新增内容继续生长，已有问题保留。", ProjectionRole::Assistant).unwrap();
        let frame = receive(&mut panel);
        assert_eq!(panel.entries.len(), 3);
        assert_eq!(panel.entries.iter().find(|e| e.key == "a1").unwrap().id, id);
        if let Ok(path) = std::env::var("MOZI_PARTICLE_PREVIEW") {
            let w = (frame.layout.width as f32 * MARKDOWN_SCALE) as u32;
            let h = (frame.layout.height as f32 * MARKDOWN_SCALE) as u32;
            let mut image = image::RgbImage::from_pixel(w, h, image::Rgb([6, 10, 15]));
            for p in &frame.particles {
                let x =
                    ((p.vertex.position[0] / MARKDOWN_WORLD_WIDTH + 0.5) * w as f32).round() as u32;
                let y = (h as f32 * 0.5 - p.vertex.position[1] / MARKDOWN_WORLD_WIDTH * w as f32)
                    .round() as u32;
                if x < w && y < h {
                    image.put_pixel(x, y, image::Rgb(p.vertex.color.map(|v| (v * p.coverage * 255.0) as u8)));
                }
            }
            image.save(path).unwrap();
        }
        panel
            .project(
                "a2",
                &"很长的回答持续追加，需要保留最新可见区域。\n\n".repeat(100),
                ProjectionRole::Assistant,
            )
            .unwrap();
        let frame = receive(&mut panel);
        assert_eq!(frame.retained.len(), 3);
        assert!(panel.entries.iter().any(|e| e.key == "u1"));
        assert!(panel.entries.iter().any(|e| e.key == "u2"));
        assert!(!panel.entries.iter().any(|e| e.key == "a1"));
        assert!(frame.particles.iter().any(|p| p.vertex.position[0] < 0.0));
        panel.clear();
        assert!(panel.entries.is_empty());
    }
    #[test]
    #[ignore = "requires installed wordcraft-cli 0.6.1"]
    fn installed_cli_renders_markdown_and_shuts_down() {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut panel = Panel::new(move |frame| {
            let _ = tx.send(frame);
        });
        panel
            .project(
                "a",
                "# 中文标题\n\n**Bold**\n\n| A | B |\n|---|---|\n| 1 | 2 |\n",
                ProjectionRole::Assistant,
            )
            .unwrap();
        let result = rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap();
        let frame = panel.accept(result).unwrap().unwrap();
        assert!(frame.particles.len() > 1000);
        panel.resize(1280, 860, 1.0).unwrap();
        let old_size_result = rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap();
        panel.resize(1920, 1080, 1.0).unwrap();
        assert!(panel.accept(old_size_result).is_none());
        let result = rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap();
        let frame = panel.accept(result).unwrap().unwrap();
        assert_eq!(frame.layout, Layout::viewport(1920, 1080, 1.0));
        panel.resize(900, 1600, 1.0).unwrap();
        let result = rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap();
        let frame = panel.accept(result).unwrap().unwrap();
        assert_eq!(frame.layout, Layout::viewport(900, 1600, 1.0));
        panel.resize(3840, 2160, 1.0).unwrap();
        let result = rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap();
        assert!(panel.accept(result).unwrap().is_ok());
        panel
            .project("a", "# In flight", ProjectionRole::Assistant)
            .unwrap();
        let result = rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap();
        panel.clear();
        assert!(panel.accept(result).is_none());
        assert!(!panel.visible);
    }
}
