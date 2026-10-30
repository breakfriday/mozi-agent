mod core;
mod layers;
mod protocol;
mod render;
mod render_config;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use winit::application::ApplicationHandler;
use winit::dpi::LogicalSize;
use winit::event::{ElementState, MouseButton, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop, EventLoopProxy};
use winit::keyboard::{Key, NamedKey};
use winit::window::{Fullscreen, Window, WindowAttributes, WindowId};

use crate::core::camera::OrbitCamera;
use crate::layers::field::FieldLayer;
use crate::layers::glyph::{load_system_font, styles::PARTICLE_STYLES, GlyphLayer, Notice, Tone};
use crate::layers::markdown::Panel;
use crate::protocol::{reply, spawn_stdin_reader, Command, Reply, UserEvent};
use crate::render::gpu::Gpu;
use crate::render::uniforms::{CameraFrame, Globals};

const DEMO_NOTICES: &[(&str, Tone)] = &[
    ("粒子演示 · 星河浮现", Tone::Activity),
    ("正在执行 · cargo build --release", Tone::Activity),
    ("任务已完成 · Vulkan 渲染就绪", Tone::Success),
    ("等待确认 · 独立显示器全屏切换", Tone::Attention),
];

struct Config {
    wallpaper: Option<PathBuf>,
    style: Option<String>,
    transparent: bool,
}

impl Config {
    fn from_args() -> Self {
        let mut config = Self { wallpaper: None, style: None, transparent: true };
        let mut args = std::env::args().skip(1);
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--wallpaper" => config.wallpaper = args.next().map(PathBuf::from),
                "--style" => config.style = args.next(),
                "--opaque" => config.transparent = false,
                "--transparent" => config.transparent = true,
                _ => {}
            }
        }
        config
    }
}

enum StyleChange<'a> {
    Set(&'a str),
    Next,
}

struct App {
    config: Config,
    window: Option<Arc<Window>>,
    gpu: Option<Gpu>,
    time: f32,
    paused: bool,
    camera: OrbitCamera,
    field: FieldLayer,
    glyph: GlyphLayer,
    markdown: Panel,
    last_frame: Instant,
    dragging: bool,
    last_cursor: Option<(f32, f32)>,
    demo_index: usize,
}

impl App {
    fn new(config: Config, proxy: EventLoopProxy<UserEvent>) -> Self {
        let font = load_system_font();
        Self {
            field: FieldLayer::load(config.wallpaper.as_deref()),
            glyph: GlyphLayer::new(font.clone(), config.style.as_deref()),
            markdown: Panel::new(font, move |block| {
                let _ = proxy.send_event(UserEvent::Markdown(block));
            }),
            config,
            window: None,
            gpu: None,
            time: 0.0,
            paused: false,
            camera: OrbitCamera::default(),
            last_frame: Instant::now(),
            dragging: false,
            last_cursor: None,
            demo_index: 0,
        }
    }

    fn report(message: &str) {
        eprintln!("[mozi-particles] {message}");
        reply(Reply::Error { message });
    }

    fn redraw(&self) {
        if let Some(window) = &self.window {
            window.request_redraw();
        }
    }

    fn sync_viewport(&mut self) {
        let Some(window) = &self.window else { return };
        let size = window.inner_size();
        let scale = window.scale_factor();
        if let Some(gpu) = &mut self.gpu {
            if gpu.size() != (size.width, size.height) {
                gpu.resize(size.width, size.height);
            }
        }
        if let Err(message) = self.markdown.resize(size.width, size.height, scale) {
            Self::report(&message);
        }
        self.upload_markdown();
    }

    /// Uploads the board only when it actually changed.
    fn upload_markdown(&mut self) {
        if let Some(particles) = self.markdown.take_frame(self.time) {
            if let Some(gpu) = self.gpu.as_mut() {
                gpu.set_markdown(particles);
            }
        }
        self.redraw();
    }

    fn upload_field(&mut self) {
        if let Some(gpu) = self.gpu.as_mut() {
            gpu.set_field(&self.field.samples.instances, &self.field.pulse);
        }
    }

    fn change_style(&mut self, change: StyleChange) {
        match change {
            StyleChange::Set(id) => self.glyph.set_style(id),
            StyleChange::Next => self.glyph.cycle_style(),
        }
        if let Some(gpu) = self.gpu.as_mut() {
            gpu.set_glyph_bloom(self.glyph.style.bloom_size);
        }
    }

    fn toggle_fullscreen(&self) {
        if let Some(w) = &self.window {
            w.set_fullscreen(if w.fullscreen().is_some() { None } else { Some(Fullscreen::Borderless(None)) });
        }
    }

    fn trigger_demo(&mut self) {
        let (text, tone) = DEMO_NOTICES[self.demo_index % DEMO_NOTICES.len()];
        self.demo_index += 1;
        self.glyph.enqueue(Notice { key: format!("demo-{}", self.demo_index), text: text.to_string(), tone });
    }

    /// One frame uniform from one camera — every layer sees the same view.
    fn frame_globals(&self, width: f32, height: f32, dpr: f32) -> Globals {
        let (projection, view) = self.camera.matrices(self.time, width, height);
        let camera = CameraFrame { view_proj: projection * view, view, viewport: [width, height], dpr, time: self.time };
        Globals::compose(
            &camera,
            &self.glyph.focus(self.time),
            &self.field.params(self.glyph.style.pulse_alpha),
            &self.glyph.motion(),
            &self.markdown.params(width, height),
        )
    }

    fn handle_command(&mut self, event_loop: &ActiveEventLoop, command: Command) {
        match command {
            Command::Project { content } => {
                match content {
                    Some(content) => {
                        if let Err(message) = self.markdown.project(&content.key, &content.text, content.role) {
                            Self::report(&message);
                        }
                    }
                    None => self.markdown.clear(),
                }
                self.upload_markdown();
            }
            Command::Notice { key, text, tone } => {
                let key = key.unwrap_or_else(|| format!("ipc-{}", self.time));
                self.glyph.enqueue(Notice { key, text, tone: Tone::parse(tone.as_deref()) });
                self.redraw();
            }
            Command::Configure { style, paused, cruise, depth } => {
                self.change_style(StyleChange::Set(&style));
                self.paused = paused;
                self.camera.cruise = cruise;
                self.field.depth = depth;
                self.last_frame = Instant::now();
                self.redraw();
            }
            Command::Wallpaper { path } => {
                self.field.reload(path.as_deref().map(Path::new));
                self.upload_field();
                self.redraw();
            }
            Command::Focus => {
                if let Some(w) = &self.window {
                    w.set_minimized(false);
                    w.focus_window();
                }
            }
            Command::Quit => {
                reply(Reply::Closed);
                event_loop.exit();
            }
        }
    }

    fn handle_key(&mut self, key: &Key) {
        match key {
            Key::Named(NamedKey::Space) => self.trigger_demo(),
            Key::Named(NamedKey::Tab) => self.change_style(StyleChange::Next),
            Key::Named(NamedKey::F11) => self.toggle_fullscreen(),
            Key::Named(NamedKey::Escape) => {
                if let Some(w) = self.window.as_ref().filter(|w| w.fullscreen().is_some()) {
                    w.set_fullscreen(None);
                }
            }
            Key::Character(ch) => match ch.as_str() {
                "r" | "R" => self.camera.reset(self.time),
                "p" | "P" => self.paused = !self.paused,
                "c" | "C" => self.camera.cruise = !self.camera.cruise,
                "f" | "F" => self.toggle_fullscreen(),
                d if ("1"..="8").contains(&d) => {
                    let idx = (d.parse::<usize>().unwrap_or(1) - 1).min(PARTICLE_STYLES.len() - 1);
                    self.change_style(StyleChange::Set(PARTICLE_STYLES[idx].id));
                }
                _ => {}
            },
            _ => {}
        }
    }
}

impl ApplicationHandler<UserEvent> for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }
        let attrs = WindowAttributes::default()
            .with_title("Mozi Particles")
            .with_inner_size(LogicalSize::new(1280.0, 860.0))
            .with_min_inner_size(LogicalSize::new(760.0, 540.0))
            .with_transparent(self.config.transparent);
        let window = match event_loop.create_window(attrs) {
            Ok(w) => Arc::new(w),
            Err(e) => {
                reply(Reply::Error { message: &format!("create_window failed: {e}") });
                event_loop.exit();
                return;
            }
        };
        match pollster::block_on(Gpu::new(window.clone(), self.config.transparent)) {
            Ok(gpu) => {
                self.gpu = Some(gpu);
                self.window = Some(window);
                self.upload_field();
                self.change_style(StyleChange::Set(self.glyph.style.id));
                self.markdown.invalidate();
                self.sync_viewport();
                self.last_frame = Instant::now();
                reply(Reply::Ready);
            }
            Err(e) => {
                reply(Reply::Error { message: &e });
                event_loop.exit();
            }
        }
    }

    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: UserEvent) {
        match event {
            UserEvent::Markdown(block) => {
                if let Err(message) = self.markdown.accept(block) {
                    Self::report(&message);
                }
                self.upload_markdown();
            }
            UserEvent::StdinClosed => {
                reply(Reply::Closed);
                event_loop.exit();
            }
            UserEvent::Command(command) => self.handle_command(event_loop, command),
        }
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        match event {
            WindowEvent::CloseRequested => {
                reply(Reply::Closed);
                event_loop.exit();
            }
            WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => self.sync_viewport(),
            WindowEvent::MouseInput { state, button: MouseButton::Left, .. } => {
                self.dragging = state == ElementState::Pressed;
                if self.dragging {
                    self.field.set_pointer(None);
                }
            }
            WindowEvent::CursorLeft { .. } => {
                self.dragging = false;
                self.last_cursor = None;
                self.field.set_pointer(None);
            }
            WindowEvent::CursorMoved { position, .. } => {
                let (x, y) = (position.x as f32, position.y as f32);
                if self.dragging {
                    if let Some((lx, ly)) = self.last_cursor {
                        self.camera.rotate(x - lx, y - ly, self.time);
                    }
                } else if let Some(gpu) = &self.gpu {
                    let (w, h) = gpu.size();
                    self.field.set_pointer(self.camera.unproject(self.time, x, y, w as f32, h as f32));
                }
                self.last_cursor = Some((x, y));
            }
            WindowEvent::MouseWheel { delta, .. } => {
                let steps = match delta {
                    MouseScrollDelta::LineDelta(_, y) => y,
                    MouseScrollDelta::PixelDelta(p) => (p.y as f32) / 40.0,
                };
                self.camera.zoom(steps, self.time);
            }
            WindowEvent::KeyboardInput { event, .. } if event.state == ElementState::Pressed => {
                self.handle_key(&event.logical_key);
            }
            WindowEvent::RedrawRequested => {
                let now = Instant::now();
                let dt = (now - self.last_frame).as_secs_f32().clamp(0.0, 0.1);
                self.last_frame = now;
                if !self.paused {
                    self.time += dt;
                    self.field.update(dt);
                    if let Some(instances) = self.glyph.update(self.time, &self.field.samples) {
                        if let Some(gpu) = &self.gpu {
                            gpu.set_glyph(&instances);
                        }
                    }
                }
                let Some(window) = self.window.clone() else { return };
                let Some((w, h)) = self.gpu.as_ref().map(Gpu::size) else { return };
                let globals = self.frame_globals(w as f32, h as f32, window.scale_factor() as f32);
                let glyph_visible = self.glyph.visible(self.time);
                if let Some(gpu) = self.gpu.as_mut() {
                    gpu.render(&globals, glyph_visible);
                }
                if !self.paused {
                    window.request_redraw();
                }
            }
            _ => {}
        }
    }

    fn exiting(&mut self, _event_loop: &ActiveEventLoop) {
        // Release the Vulkan surface and window while the Wayland event loop is alive.
        self.gpu.take();
        self.window.take();
    }

    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        event_loop.set_control_flow(if self.paused { ControlFlow::Wait } else { ControlFlow::Poll });
        if !self.paused {
            self.redraw();
        }
    }
}

fn main() {
    let config = Config::from_args();
    let event_loop = EventLoop::<UserEvent>::with_user_event().build().expect("build winit event loop");
    event_loop.set_control_flow(ControlFlow::Poll);
    spawn_stdin_reader(event_loop.create_proxy());
    let mut app = App::new(config, event_loop.create_proxy());
    let _ = event_loop.run_app(&mut app);
}
