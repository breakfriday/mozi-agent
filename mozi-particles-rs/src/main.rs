mod markdown;
mod projection_board;
mod render_config;
mod gpu;
mod ipc;
mod sampling;
mod scene;
mod styles;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use winit::application::ApplicationHandler;
use winit::dpi::LogicalSize;
use winit::event::{ElementState, MouseButton, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::keyboard::{Key, NamedKey};
use winit::window::{Fullscreen, Window, WindowAttributes, WindowId};

use crate::gpu::{Gpu, GLYPH_BLOOM_LAYER};
use crate::render_config::{FIELD_GRID_H, FIELD_GRID_W, PULSE_GRID_H, PULSE_GRID_W};
use crate::ipc::{reply, spawn_stdin_reader, Command, Reply, UserEvent};
use crate::sampling::{
    load_system_font, load_wallpaper, sample_field, sample_pulse, FieldSamples,
};
use crate::scene::{Notice, Scene, Tone};
use crate::styles::PARTICLE_STYLES;

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
        let mut wallpaper = None;
        let mut style = None;
        let mut transparent = true;
        let mut args = std::env::args().skip(1);
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--wallpaper" => wallpaper = args.next().map(PathBuf::from),
                "--style" => style = args.next(),
                "--opaque" => transparent = false,
                "--transparent" => transparent = true,
                _ => {}
            }
        }
        if wallpaper.is_none() {
            wallpaper = detect_gnome_wallpaper();
        }
        Self { wallpaper, style, transparent }
    }
}

/// Auto-detects Ubuntu GNOME desktop wallpaper via gsettings if available.
fn detect_gnome_wallpaper() -> Option<PathBuf> {
    for key in ["picture-uri-dark", "picture-uri"] {
        let output = std::process::Command::new("gsettings")
            .args(["get", "org.gnome.desktop.background", key])
            .output()
            .ok()?;
        if !output.status.success() {
            continue;
        }
        let raw = String::from_utf8_lossy(&output.stdout);
        let trimmed = raw.trim().trim_matches('\'').trim_matches('"');
        let path_str = trimmed.strip_prefix("file://").unwrap_or(trimmed);
        if !path_str.is_empty() {
            let path = PathBuf::from(path_str);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

struct App {
    config: Config,
    markdown: markdown::Panel,
    window: Option<Arc<Window>>,
    gpu: Option<Gpu>,
    field: FieldSamples,
    scene: Scene,
    last_frame: Instant,
    dragging: bool,
    last_cursor: Option<(f32, f32)>,
    demo_index: usize,
}

impl App {
    fn new(config: Config, proxy: winit::event_loop::EventLoopProxy<UserEvent>) -> Self {
        let img = load_wallpaper(config.wallpaper.as_deref());
        let field = sample_field(&img, FIELD_GRID_W, FIELD_GRID_H);
        let font = load_system_font();
        let scene = Scene::new(font, config.style.as_deref());
        Self {
            config,
            markdown: markdown::Panel::new(move |frame| { let _ = proxy.send_event(UserEvent::Markdown(frame)); }),
            window: None,
            gpu: None,
            field,
            scene,
            last_frame: Instant::now(),
            dragging: false,
            last_cursor: None,
            demo_index: 0,
        }
    }

    fn sync_viewport(&mut self) {
        if let Some(window) = &self.window {
            let size = window.inner_size();
            if let Some(gpu) = &mut self.gpu {
                if gpu.size() != (size.width, size.height) { gpu.resize(size.width, size.height); }
            }
            if let Err(message) = self.markdown.resize(size.width, size.height, window.scale_factor()) {
                eprintln!("[mozi-particles] {message}");
            }
            window.request_redraw();
        }
    }

    fn reload_wallpaper(&mut self, path: Option<&Path>) {
        let resolved = path.map(Path::to_path_buf).or_else(detect_gnome_wallpaper);
        let img = load_wallpaper(resolved.as_deref());
        self.field = sample_field(&img, FIELD_GRID_W, FIELD_GRID_H);
        let pulse = sample_pulse(&self.field, PULSE_GRID_W, PULSE_GRID_H);
        if let Some(gpu) = self.gpu.as_mut() {
            gpu.set_field(&self.field.instances, &pulse);
        }
    }

    fn trigger_demo(&mut self) {
        let (text, tone) = DEMO_NOTICES[self.demo_index % DEMO_NOTICES.len()];
        self.demo_index += 1;
        self.scene.enqueue(Notice {
            key: format!("demo-{}", self.demo_index),
            text: text.to_string(),
            tone,
        });
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
            Ok(mut gpu) => {
                let pulse = sample_pulse(&self.field, PULSE_GRID_W, PULSE_GRID_H);
                gpu.set_field(&self.field.instances, &pulse);
                gpu.set_layer_bloom(GLYPH_BLOOM_LAYER, self.scene.style.bloom_size);
                self.gpu = Some(gpu);
                self.window = Some(window.clone());
                self.sync_viewport();
                self.last_frame = Instant::now();
                reply(Reply::Ready);
                window.request_redraw();
            }
            Err(e) => {
                reply(Reply::Error { message: &e });
                event_loop.exit();
            }
        }
    }

    fn user_event(&mut self, event_loop: &ActiveEventLoop, event: UserEvent) {
        match event {
            UserEvent::Markdown(frame) => {
                if let Some(result) = self.markdown.accept(frame) {
                    match result {
                        Ok(frame) => if let Some(gpu) = &mut self.gpu { gpu.set_markdown(self.markdown.animate(&frame, self.scene.time)); },
                        Err(message) => { eprintln!("[mozi-particles] {message}"); reply(Reply::Error { message: &message }); }
                    }
                    if let Some(w) = &self.window { w.request_redraw(); }
                }
            }
            UserEvent::StdinClosed => {
                reply(Reply::Closed);
                event_loop.exit();
            }
            UserEvent::Command(cmd) => match cmd {
                Command::Project { content } => {
                    self.scene.project(None);
                    if let Some(content) = content {
                        if let Err(message) = self.markdown.project(&content.key, &content.text, content.role) {
                            eprintln!("[mozi-particles] {message}"); reply(Reply::Error { message: &message });
                        }
                    } else { self.markdown.clear(); }
                    if let Some(w) = &self.window { w.request_redraw(); }
                }
                Command::Notice { key, text, tone } => {
                    self.scene.enqueue(Notice {
                        key: key.unwrap_or_else(|| format!("ipc-{}", self.scene.time)),
                        text,
                        tone: Tone::parse(tone.as_deref()),
                    });
                    if let Some(w) = &self.window {
                        w.request_redraw();
                    }
                }
                Command::Configure { style, paused, cruise, depth } => {
                    self.scene.set_style(&style);
                    self.scene.paused = paused;
                    self.scene.cruise = cruise;
                    self.scene.depth = depth;
                    if let Some(gpu) = self.gpu.as_mut() {
                        gpu.set_layer_bloom(GLYPH_BLOOM_LAYER, self.scene.style.bloom_size);
                    }
                    self.last_frame = Instant::now();
                    if let Some(w) = &self.window { w.request_redraw(); }
                }
                Command::Style { id } => {
                    self.scene.set_style(&id);
                    if let Some(gpu) = self.gpu.as_mut() {
                        gpu.set_layer_bloom(GLYPH_BLOOM_LAYER, self.scene.style.bloom_size);
                    }
                }
                Command::Wallpaper { path } => {
                    self.reload_wallpaper(path.as_deref().map(Path::new));
                    if let Some(w) = &self.window { w.request_redraw(); }
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
            },
        }
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        match event {
            WindowEvent::CloseRequested => {
                reply(Reply::Closed);
                event_loop.exit();
            }
            WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => {
                self.sync_viewport();
            }
            WindowEvent::MouseInput { state, button: MouseButton::Left, .. } => {
                self.dragging = state == ElementState::Pressed;
                if self.dragging {
                    self.scene.set_pointer(None);
                }
            }
            WindowEvent::CursorLeft { .. } => {
                self.dragging = false;
                self.last_cursor = None;
                self.scene.set_pointer(None);
            }
            WindowEvent::CursorMoved { position, .. } => {
                let (x, y) = (position.x as f32, position.y as f32);
                if self.dragging {
                    if let Some((lx, ly)) = self.last_cursor {
                        self.scene.camera.rotate(x - lx, y - ly, self.scene.time);
                    }
                } else if let Some(gpu) = &self.gpu {
                    let (w, h) = gpu.size();
                    let world = self.scene.unproject(x, y, w as f32, h as f32);
                    self.scene.set_pointer(world);
                }
                self.last_cursor = Some((x, y));
            }
            WindowEvent::MouseWheel { delta, .. } => {
                let steps = match delta {
                    MouseScrollDelta::LineDelta(_, y) => y,
                    MouseScrollDelta::PixelDelta(p) => (p.y as f32) / 40.0,
                };
                self.scene.camera.zoom(steps, self.scene.time);
            }
            WindowEvent::KeyboardInput { event, .. } if event.state == ElementState::Pressed => {
                match &event.logical_key {
                    Key::Named(NamedKey::Space) => {
                        self.trigger_demo();
                    }
                    Key::Named(NamedKey::Tab) => {
                        self.scene.cycle_style();
                        if let Some(gpu) = self.gpu.as_mut() {
                            gpu.set_layer_bloom(GLYPH_BLOOM_LAYER, self.scene.style.bloom_size);
                        }
                    }
                    Key::Named(NamedKey::F11) => {
                        if let Some(w) = &self.window {
                            let next = if w.fullscreen().is_some() {
                                None
                            } else {
                                Some(Fullscreen::Borderless(None))
                            };
                            w.set_fullscreen(next);
                        }
                    }
                    Key::Named(NamedKey::Escape) => {
                        if let Some(w) = &self.window {
                            if w.fullscreen().is_some() {
                                w.set_fullscreen(None);
                            }
                        }
                    }
                    Key::Character(ch) => match ch.as_str() {
                        "r" | "R" => self.scene.camera.reset(self.scene.time),
                        "p" | "P" => self.scene.paused = !self.scene.paused,
                        "c" | "C" => self.scene.cruise = !self.scene.cruise,
                        "f" | "F" => {
                            if let Some(w) = &self.window {
                                let next = if w.fullscreen().is_some() {
                                    None
                                } else {
                                    Some(Fullscreen::Borderless(None))
                                };
                                w.set_fullscreen(next);
                            }
                        }
                        d if ("1"..="8").contains(&d) => {
                            let idx = (d.parse::<usize>().unwrap_or(1) - 1).min(PARTICLE_STYLES.len() - 1);
                            self.scene.set_style(PARTICLE_STYLES[idx].id);
                            if let Some(gpu) = self.gpu.as_mut() {
                                gpu.set_layer_bloom(GLYPH_BLOOM_LAYER, self.scene.style.bloom_size);
                            }
                        }
                        _ => {}
                    },
                    _ => {}
                }
            }
            WindowEvent::RedrawRequested => {
                let now = Instant::now();
                let dt = (now - self.last_frame).as_secs_f32().clamp(0.0, 0.1);
                self.last_frame = now;

                if let Some(upload) = self.scene.update(dt, &self.field) {
                    if let Some(gpu) = &self.gpu {
                        gpu.set_glyph(&upload.instances);
                    }
                }

                if let (Some(gpu), Some(window)) = (self.gpu.as_mut(), self.window.as_ref()) {
                    let (w, h) = gpu.size();
                    let dpr = window.scale_factor() as f32;
                    let mut globals = self.scene.globals(w as f32, h as f32, dpr);
                    globals.panel = self.markdown.uniforms();
                    globals.panel_motion = [render_config::MARKDOWN_REFLOW_SECONDS, self.markdown.world_scale(w as f32, h as f32), render_config::MARKDOWN_PLANE_Z, render_config::MARKDOWN_MIN_RADIUS_PX];
                    gpu.render(&globals, self.scene.glyph_visible());
                    if !self.scene.paused {
                        window.request_redraw();
                    }
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
        event_loop.set_control_flow(if self.scene.paused { ControlFlow::Wait } else { ControlFlow::Poll });
        if !self.scene.paused {
            if let Some(w) = &self.window {
                w.request_redraw();
            }
        }
    }
}

fn main() {
    let config = Config::from_args();
    let event_loop = EventLoop::<UserEvent>::with_user_event()
        .build()
        .expect("build winit event loop");
    event_loop.set_control_flow(ControlFlow::Poll);
    spawn_stdin_reader(event_loop.create_proxy());
    let mut app = App::new(config, event_loop.create_proxy());
    let _ = event_loop.run_app(&mut app);
}
