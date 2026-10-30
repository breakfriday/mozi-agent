//! wgpu renderer: core + soft halo per geometry; Markdown uses premultiplied output.

use std::sync::Arc;

use wgpu::util::DeviceExt;
use winit::window::Window;

use crate::sampling::{FieldInstance, GlyphInstance, PulseInstance};
use crate::scene::Globals;

use crate::render_config::*;

const MARKDOWN_ATTRS: [wgpu::VertexAttribute; 6] = wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3, 2 => Float32x2, 3 => Float32x3, 4 => Float32, 5 => Float32x2];
const FIELD_ATTRS: [wgpu::VertexAttribute; 2] = wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3];
const PULSE_ATTRS: [wgpu::VertexAttribute; 3] = wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32, 2 => Float32x3];
const GLYPH_ATTRS: [wgpu::VertexAttribute; 4] =
    wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3, 2 => Float32x3, 3 => Float32];

/// Straight-alpha "over" that keeps the framebuffer valid premultiplied (RGB <= A).
const BLEND_OVER: wgpu::BlendState = wgpu::BlendState {
    color: wgpu::BlendComponent {
        src_factor: wgpu::BlendFactor::SrcAlpha,
        dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
        operation: wgpu::BlendOperation::Add,
    },
    alpha: wgpu::BlendComponent {
        src_factor: wgpu::BlendFactor::One,
        dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
        operation: wgpu::BlendOperation::Add,
    },
};

/// Additive glow; alpha accumulates with factor One so RGB never outgrows A (no compositor garbage).
const BLEND_ADD: wgpu::BlendState = wgpu::BlendState {
    color: wgpu::BlendComponent {
        src_factor: wgpu::BlendFactor::SrcAlpha,
        dst_factor: wgpu::BlendFactor::One,
        operation: wgpu::BlendOperation::Add,
    },
    alpha: wgpu::BlendComponent {
        src_factor: wgpu::BlendFactor::One,
        dst_factor: wgpu::BlendFactor::One,
        operation: wgpu::BlendOperation::Add,
    },
};

// Markdown fragment output already includes all coverage, shape and animation alpha.
const BLEND_PREMULTIPLIED_OVER: wgpu::BlendState = wgpu::BlendState {
    color: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, ..BLEND_OVER.color },
    alpha: BLEND_OVER.alpha,
};
const BLEND_PREMULTIPLIED_ADD: wgpu::BlendState = wgpu::BlendState {
    color: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, ..BLEND_ADD.color },
    alpha: BLEND_ADD.alpha,
};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Geometry {
    Pulse,
    Field,
    Glyph,
    Markdown,
}

#[derive(Clone, Copy)]
pub struct LayerSpec {
    pub geometry: Geometry,
    pub additive: bool,
    /// bloom_scale, soft, layer_alpha, size
    pub params: [f32; 4],
}

/// Background, legacy glyphs, then the Markdown halo and core.
pub const LAYERS: [LayerSpec; 8] = [
    LayerSpec { geometry: Geometry::Pulse, additive: true, params: [PULSE_HALO_SCALE, 1.0, PULSE_HALO_ALPHA, PULSE_PARTICLE_SIZE] },
    LayerSpec { geometry: Geometry::Pulse, additive: true, params: [1.0, 0.0, PULSE_CORE_ALPHA, PULSE_PARTICLE_SIZE] },
    LayerSpec { geometry: Geometry::Field, additive: true, params: [FIELD_HALO_SCALE, 1.0, FIELD_HALO_ALPHA, FIELD_PARTICLE_SIZE] },
    LayerSpec { geometry: Geometry::Field, additive: false, params: [1.0, 0.0, FIELD_CORE_ALPHA, FIELD_PARTICLE_SIZE] },
    LayerSpec { geometry: Geometry::Glyph, additive: true, params: [AUTO_GLYPH_HALO_SCALE, 1.0, GLYPH_HALO_ALPHA, GLYPH_PARTICLE_SIZE] },
    LayerSpec { geometry: Geometry::Glyph, additive: true, params: [1.0, 0.0, GLYPH_CORE_ALPHA, GLYPH_PARTICLE_SIZE] },
    LayerSpec { geometry: Geometry::Markdown, additive: true, params: [MARKDOWN_HALO_SCALE, 1.0, MARKDOWN_HALO_ALPHA, MARKDOWN_PARTICLE_RADIUS] },
    LayerSpec { geometry: Geometry::Markdown, additive: false, params: [1.0, 0.0, MARKDOWN_CORE_ALPHA, MARKDOWN_PARTICLE_RADIUS] },
];
pub const GLYPH_BLOOM_LAYER: usize = 4;

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
    pub translucent: bool,
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

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("particles.wgsl"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shader.wgsl").into()),
        });

        let uniform_entry = |binding| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        };
        let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("globals+layer"),
            entries: &[uniform_entry(0), uniform_entry(1)],
        });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("particles"),
            bind_group_layouts: &[&bgl],
            push_constant_ranges: &[],
        });

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
                    layout: &bgl,
                    entries: &[
                        wgpu::BindGroupEntry { binding: 0, resource: globals.as_entire_binding() },
                        wgpu::BindGroupEntry { binding: 1, resource: uniform.as_entire_binding() },
                    ],
                });
                Layer { spec: *spec, uniform, bind_group }
            })
            .collect();

        let vb = |stride: usize, attributes: &'static [wgpu::VertexAttribute]| wgpu::VertexBufferLayout {
            array_stride: stride as u64,
            step_mode: wgpu::VertexStepMode::Instance,
            attributes,
        };
        let markdown_vb = [vb(std::mem::size_of::<crate::projection_board::Particle>(), &MARKDOWN_ATTRS)];
        let field_vb = [vb(std::mem::size_of::<FieldInstance>(), &FIELD_ATTRS)];
        let pulse_vb = [vb(std::mem::size_of::<PulseInstance>(), &PULSE_ATTRS)];
        let glyph_vb = [vb(std::mem::size_of::<GlyphInstance>(), &GLYPH_ATTRS)];
        let make = |vs: &str, fs: &str, buffers: &[wgpu::VertexBufferLayout], blend: wgpu::BlendState| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(vs),
                layout: Some(&layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: vs,
                    compilation_options: Default::default(),
                    buffers,
                },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: fs,
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format,
                        blend: Some(blend),
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                }),
                primitive: wgpu::PrimitiveState {
                    topology: wgpu::PrimitiveTopology::TriangleList,
                    cull_mode: None,
                    ..Default::default()
                },
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                multiview: None,
                cache: None,
            })
        };
        let pipelines = Pipelines {
            pulse: make("vs_pulse", "fs_pulse", &pulse_vb, BLEND_ADD),
            field_add: make("vs_field", "fs_field", &field_vb, BLEND_ADD),
            field_over: make("vs_field", "fs_field", &field_vb, BLEND_OVER),
            glyph: make("vs_glyph", "fs_glyph", &glyph_vb, BLEND_ADD),
            markdown_core: make("vs_markdown", "fs_markdown", &markdown_vb, BLEND_PREMULTIPLIED_OVER),
            markdown_halo: make("vs_markdown", "fs_markdown", &markdown_vb, BLEND_PREMULTIPLIED_ADD),
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

        Ok(Self { surface, device, queue, config, clear, globals, layers, pipelines, field, pulse, glyph, markdown, translucent })
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
            self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some(label),
                contents,
                usage: wgpu::BufferUsages::VERTEX,
            })
        };
        self.field = (init("field", bytemuck::cast_slice(field)), field.len() as u32);
        self.pulse = (init("pulse", bytemuck::cast_slice(pulse)), pulse.len() as u32);
    }

    pub fn set_markdown(&mut self, particles: &[crate::projection_board::Particle]) {
        self.markdown.1 = particles.len() as u32;
        if !particles.is_empty() {
            self.markdown.0 = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("markdown"), contents: bytemuck::cast_slice(particles), usage: wgpu::BufferUsages::VERTEX,
            });
        }
    }

    pub fn set_glyph(&self, glyph: &[GlyphInstance]) {
        let n = glyph.len().min(EVENT_PARTICLE_COUNT);
        self.queue.write_buffer(&self.glyph, 0, bytemuck::cast_slice(&glyph[..n]));
    }

    pub fn set_layer_bloom(&mut self, index: usize, bloom_scale: f32) {
        if let Some(layer) = self.layers.get_mut(index) {
            layer.spec.params[0] = bloom_scale;
            self.queue.write_buffer(&layer.uniform, 0, bytemuck::cast_slice(&layer.spec.params));
        }
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
                let (pipeline, buffer, count) = match layer.spec.geometry {
                    Geometry::Pulse => (&self.pipelines.pulse, &self.pulse.0, self.pulse.1),
                    Geometry::Field if layer.spec.additive => (&self.pipelines.field_add, &self.field.0, self.field.1),
                    Geometry::Field => (&self.pipelines.field_over, &self.field.0, self.field.1),
                    Geometry::Glyph if glyph_visible => (&self.pipelines.glyph, &self.glyph, EVENT_PARTICLE_COUNT as u32),
                    Geometry::Glyph => continue,
                    Geometry::Markdown if globals.panel[0] > 0.0 => (
                        if layer.spec.additive { &self.pipelines.markdown_halo } else { &self.pipelines.markdown_core },
                        &self.markdown.0, self.markdown.1,
                    ),
                    Geometry::Markdown => continue,
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

#[cfg(test)]
#[path = "text_material_tests.rs"]
mod text_material_tests;
