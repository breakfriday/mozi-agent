//! wgpu device/surface and per-frame draw. Core + soft halo per geometry (Twin Bloom);
//! the Markdown board uses premultiplied output.
use std::sync::Arc;

use wgpu::util::DeviceExt;
use winit::window::Window;

use super::pipeline::{Material, PipelineFactory, BLEND_ADD, BLEND_OVER, BLEND_PREMULTIPLIED_ADD, BLEND_PREMULTIPLIED_OVER};
use super::uniforms::Globals;
use crate::layers::field::{FieldInstance, PulseInstance};
use crate::layers::glyph::GlyphInstance;
use crate::layers::markdown::Particle;
use crate::render_config::*;

#[derive(Clone, Copy)]
struct LayerSpec {
    material: Material,
    additive: bool,
    /// bloom_scale, soft, layer_alpha, size
    params: [f32; 4],
}

/// Draw order: background, short-message glyphs, then the Markdown halo and core.
const LAYERS: [LayerSpec; 8] = [
    LayerSpec { material: Material::Pulse, additive: true, params: [PULSE_HALO_SCALE, 1.0, PULSE_HALO_ALPHA, PULSE_PARTICLE_SIZE] },
    LayerSpec { material: Material::Pulse, additive: true, params: [1.0, 0.0, PULSE_CORE_ALPHA, PULSE_PARTICLE_SIZE] },
    LayerSpec { material: Material::Field, additive: true, params: [FIELD_HALO_SCALE, 1.0, FIELD_HALO_ALPHA, FIELD_PARTICLE_SIZE] },
    LayerSpec { material: Material::Field, additive: false, params: [1.0, 0.0, FIELD_CORE_ALPHA, FIELD_PARTICLE_SIZE] },
    LayerSpec { material: Material::Glyph, additive: true, params: [AUTO_GLYPH_HALO_SCALE, 1.0, GLYPH_HALO_ALPHA, GLYPH_PARTICLE_SIZE] },
    LayerSpec { material: Material::Glyph, additive: true, params: [1.0, 0.0, GLYPH_CORE_ALPHA, GLYPH_PARTICLE_SIZE] },
    LayerSpec { material: Material::Markdown, additive: true, params: [MARKDOWN_HALO_SCALE, 1.0, MARKDOWN_HALO_ALPHA, MARKDOWN_PARTICLE_RADIUS] },
    LayerSpec { material: Material::Markdown, additive: false, params: [1.0, 0.0, MARKDOWN_CORE_ALPHA, MARKDOWN_PARTICLE_RADIUS] },
];
/// The glyph halo follows the active style's bloom size.
const GLYPH_HALO_LAYER: usize = 4;

struct Layer {
    spec: LayerSpec,
    uniform: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
}

struct Pipelines {
    pulse: wgpu::RenderPipeline,
    field_add: wgpu::RenderPipeline,
    field_over: wgpu::RenderPipeline,
    glyph: wgpu::RenderPipeline,
    markdown_core: wgpu::RenderPipeline,
    markdown_halo: wgpu::RenderPipeline,
}

pub struct Gpu {
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    clear: wgpu::Color,
    globals: wgpu::Buffer,
    layers: Vec<Layer>,
    pipelines: Pipelines,
    field: (wgpu::Buffer, u32),
    pulse: (wgpu::Buffer, u32),
    glyph: wgpu::Buffer,
    markdown: (wgpu::Buffer, u32),
}

impl Gpu {
    pub async fn new(window: Arc<Window>, want_transparent: bool) -> Result<Self, String> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::VULKAN | wgpu::Backends::GL,
            ..Default::default()
        });
        let surface = instance.create_surface(window.clone()).map_err(|e| format!("create_surface: {e}"))?;
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: Some(&surface),
                force_fallback_adapter: false,
            })
            .await
            .ok_or("no compatible GPU adapter")?;
        let info = adapter.get_info();
        eprintln!("[mozi-particles] adapter: {} ({:?}, {:?})", info.name, info.backend, info.device_type);

        let (device, queue) = adapter
            .request_device(
                &wgpu::DeviceDescriptor {
                    label: Some("mozi-particles"),
                    required_features: wgpu::Features::empty(),
                    required_limits: wgpu::Limits::downlevel_defaults().using_resolution(adapter.limits()),
                    memory_hints: wgpu::MemoryHints::Performance,
                },
                None,
            )
            .await
            .map_err(|e| format!("request_device: {e}"))?;

        let caps = surface.get_capabilities(&adapter);
        // Non-sRGB target: wallpaper colors are already display-referred, same as the WebGL path.
        let format = caps.formats.iter().copied().find(|f| !f.is_srgb()).unwrap_or(caps.formats[0]);
        let alpha_mode = pick_alpha_mode(&caps.alpha_modes, want_transparent);
        let translucent = matches!(alpha_mode, wgpu::CompositeAlphaMode::PreMultiplied | wgpu::CompositeAlphaMode::PostMultiplied);
        eprintln!("[mozi-particles] surface: {format:?}, alpha {alpha_mode:?} (supported {:?})", caps.alpha_modes);

        let size = window.inner_size();
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width: size.width.max(1),
            height: size.height.max(1),
            present_mode: wgpu::PresentMode::Fifo,
            desired_maximum_frame_latency: 2,
            alpha_mode,
            view_formats: vec![],
        };
        surface.configure(&device, &config);

        let clear = if translucent {
            // Premultiplied clear: RGB scaled by A so the compositor never sees RGB > A.
            let a = BACKDROP_ALPHA;
            let k = if alpha_mode == wgpu::CompositeAlphaMode::PreMultiplied { a } else { 1.0 };
            wgpu::Color { r: BACKDROP_RGB[0] * k, g: BACKDROP_RGB[1] * k, b: BACKDROP_RGB[2] * k, a }
        } else {
            wgpu::Color { r: BACKDROP_RGB[0], g: BACKDROP_RGB[1], b: BACKDROP_RGB[2], a: 1.0 }
        };

        let factory = PipelineFactory::new(&device, format);
        let globals = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("globals"),
            size: std::mem::size_of::<Globals>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let layers = LAYERS
            .iter()
            .map(|spec| {
                let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("layer"),
                    contents: bytemuck::cast_slice(&spec.params),
                    usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                });
                let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("layer"),
                    layout: &factory.bind_group_layout,
                    entries: &[
                        wgpu::BindGroupEntry { binding: 0, resource: globals.as_entire_binding() },
                        wgpu::BindGroupEntry { binding: 1, resource: uniform.as_entire_binding() },
                    ],
                });
                Layer { spec: *spec, uniform, bind_group }
            })
            .collect();

        let pipelines = Pipelines {
            pulse: factory.build(&device, Material::Pulse, BLEND_ADD),
            field_add: factory.build(&device, Material::Field, BLEND_ADD),
            field_over: factory.build(&device, Material::Field, BLEND_OVER),
            glyph: factory.build(&device, Material::Glyph, BLEND_ADD),
            markdown_core: factory.build(&device, Material::Markdown, BLEND_PREMULTIPLIED_OVER),
            markdown_halo: factory.build(&device, Material::Markdown, BLEND_PREMULTIPLIED_ADD),
        };

        let empty = |label| {
            device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(label),
                size: 64,
                usage: wgpu::BufferUsages::VERTEX,
                mapped_at_creation: false,
            })
        };
        let field = (empty("field"), 0);
        let pulse = (empty("pulse"), 0);
        let markdown = (empty("markdown"), 0);
        let glyph = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("glyph"),
            size: (EVENT_PARTICLE_COUNT * std::mem::size_of::<GlyphInstance>()) as u64,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        Ok(Self { surface, device, queue, config, clear, globals, layers, pipelines, field, pulse, glyph, markdown })
    }

    pub fn size(&self) -> (u32, u32) {
        (self.config.width, self.config.height)
    }

    pub fn resize(&mut self, width: u32, height: u32) {
        if width == 0 || height == 0 {
            return; // minimized
        }
        self.config.width = width;
        self.config.height = height;
        self.surface.configure(&self.device, &self.config);
    }

    pub fn set_field(&mut self, field: &[FieldInstance], pulse: &[PulseInstance]) {
        let init = |label, contents: &[u8]| {
            self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some(label), contents, usage: wgpu::BufferUsages::VERTEX })
        };
        self.field = (init("field", bytemuck::cast_slice(field)), field.len() as u32);
        self.pulse = (init("pulse", bytemuck::cast_slice(pulse)), pulse.len() as u32);
    }

    pub fn set_markdown(&mut self, particles: &[Particle]) {
        self.markdown.1 = particles.len() as u32;
        if !particles.is_empty() {
            self.markdown.0 = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("markdown"),
                contents: bytemuck::cast_slice(particles),
                usage: wgpu::BufferUsages::VERTEX,
            });
        }
    }

    pub fn set_glyph(&self, glyph: &[GlyphInstance]) {
        let n = glyph.len().min(EVENT_PARTICLE_COUNT);
        self.queue.write_buffer(&self.glyph, 0, bytemuck::cast_slice(&glyph[..n]));
    }

    pub fn set_glyph_bloom(&mut self, bloom_scale: f32) {
        let layer = &mut self.layers[GLYPH_HALO_LAYER];
        layer.spec.params[0] = bloom_scale;
        self.queue.write_buffer(&layer.uniform, 0, bytemuck::cast_slice(&layer.spec.params));
    }

    pub fn render(&mut self, globals: &Globals, glyph_visible: bool) {
        let frame = match self.surface.get_current_texture() {
            Ok(frame) => frame,
            Err(wgpu::SurfaceError::Lost | wgpu::SurfaceError::Outdated) => {
                self.surface.configure(&self.device, &self.config);
                return;
            }
            Err(wgpu::SurfaceError::Timeout) => return,
            Err(e) => {
                eprintln!("[mozi-particles] surface error: {e}");
                return;
            }
        };
        let view = frame.texture.create_view(&wgpu::TextureViewDescriptor::default());
        self.queue.write_buffer(&self.globals, 0, bytemuck::bytes_of(globals));

        let markdown_visible = globals.markdown_visible();
        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("frame") });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("particles"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(self.clear), store: wgpu::StoreOp::Store },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            for layer in &self.layers {
                let (pipeline, buffer, count) = match layer.spec.material {
                    Material::Pulse => (&self.pipelines.pulse, &self.pulse.0, self.pulse.1),
                    Material::Field if layer.spec.additive => (&self.pipelines.field_add, &self.field.0, self.field.1),
                    Material::Field => (&self.pipelines.field_over, &self.field.0, self.field.1),
                    Material::Glyph if glyph_visible => (&self.pipelines.glyph, &self.glyph, EVENT_PARTICLE_COUNT as u32),
                    Material::Markdown if markdown_visible => (
                        if layer.spec.additive { &self.pipelines.markdown_halo } else { &self.pipelines.markdown_core },
                        &self.markdown.0,
                        self.markdown.1,
                    ),
                    Material::Glyph | Material::Markdown => continue,
                };
                if count == 0 {
                    continue;
                }
                pass.set_pipeline(pipeline);
                pass.set_bind_group(0, &layer.bind_group, &[]);
                pass.set_vertex_buffer(0, buffer.slice(..));
                pass.draw(0..6, 0..count);
            }
        }
        self.queue.submit(Some(encoder.finish()));
        frame.present();
    }
}

fn pick_alpha_mode(supported: &[wgpu::CompositeAlphaMode], want_transparent: bool) -> wgpu::CompositeAlphaMode {
    use wgpu::CompositeAlphaMode as M;
    let order: &[M] = if want_transparent {
        &[M::PreMultiplied, M::PostMultiplied, M::Opaque, M::Inherit]
    } else {
        &[M::Opaque, M::Inherit]
    };
    order.iter().copied().find(|m| supported.contains(m)).unwrap_or(supported[0])
}
