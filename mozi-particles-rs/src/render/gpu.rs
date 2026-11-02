//! wgpu device/surface and per-frame draw. Core + soft halo per geometry (Twin Bloom);
//! the Markdown board uses premultiplied output.
use std::sync::Arc;

use wgpu::util::DeviceExt;
use winit::window::Window;

use super::pipeline::{
    Material, PipelineFactory, BLEND_ADD, BLEND_OVER, BLEND_PREMULTIPLIED_ADD, BLEND_PREMULTIPLIED_OVER, QUAD_INDICES,
    RESOLVED_SPRITE_STRIDE,
};
use super::uniforms::Globals;
use crate::layers::field::{FieldInstance, PulseInstance};
use crate::layers::glyph::GlyphInstance;
use crate::layers::markdown::Particle;
use crate::render_config;

#[derive(Clone, Copy)]
struct LayerSpec {
    material: Material,
    additive: bool,
    /// - 对于保留双 Pass（Halo + Core）的图层（Field、Markdown）：`[bloom_scale, soft, layer_alpha, size]`
    /// - 对于单 Pass 合并的纯加法图层（Pulse、Glyph）：`[bloom_scale, core_alpha, halo_alpha, size]`
    params: [f32; 4],
}

/// 【优化 2：渲染 Pass 从 8 个精简为 6 个】
/// 设计思想与数学逻辑：
/// - `Pulse`（原 Pass 1 & 2）与 `Glyph`（原 Pass 5 & 6）的光晕和核心均使用纯加法混合（`BLEND_ADD`），
///   且光晕与核心之间没有穿插任何非加法图层。根据加法交换律与结合律：
///     ∑ Halo_i + ∑ Core_i ≡ ∑(Halo_i + Core_i)
///   将它们各自合并为 1 个 `BLEND_PREMULTIPLIED_ADD` Pass，最终帧缓冲区的像素值 100% 不变。
/// - `Field`（Pass 2 & 3）与 `Markdown`（Pass 5 & 6）的核心使用 `BLEND_OVER`（含 `1 - SrcAlpha` 遮挡项），
///   不满足交换律，因此严格保留“先画全屏光晕、再画全屏核心”的两遍顺序，确保丝绸立体感与文字墨色锐度 100% 无损。
const LAYERS: [LayerSpec; 6] = [
    // Pass 1（合并原 Pass 1 & 2）：PULSE 极光与星尘（光晕 + 核心单次输出）
    LayerSpec {
        material: Material::Pulse,
        additive: true,
        params: [
            render_config::PULSE_HALO_SCALE,
            render_config::PULSE_CORE_ALPHA,
            render_config::PULSE_HALO_ALPHA,
            render_config::PULSE_PARTICLE_SIZE,
        ],
    },
    // Pass 2（原 Pass 3）：SILK 背景粒子光晕（BLEND_ADD）
    LayerSpec {
        material: Material::Field,
        additive: true,
        params: [
            render_config::FIELD_HALO_SCALE,
            1.0,
            render_config::FIELD_HALO_ALPHA,
            render_config::FIELD_PARTICLE_SIZE,
        ],
    },
    // Pass 3（原 Pass 4）：SILK 背景粒子核心（BLEND_OVER）
    LayerSpec {
        material: Material::Field,
        additive: false,
        params: [
            1.0,
            0.0,
            render_config::FIELD_CORE_ALPHA,
            render_config::FIELD_PARTICLE_SIZE,
        ],
    },
    // Pass 4（合并原 Pass 5 & 6）：GLYPH 中央短消息大字（光晕 + 核心单次输出）
    LayerSpec {
        material: Material::Glyph,
        additive: true,
        params: [
            render_config::AUTO_GLYPH_HALO_SCALE,
            render_config::GLYPH_CORE_ALPHA,
            render_config::GLYPH_HALO_ALPHA,
            render_config::GLYPH_PARTICLE_SIZE,
        ],
    },
    // Pass 5（原 Pass 7）：Markdown 面板文字光晕（BLEND_PREMULTIPLIED_ADD）
    LayerSpec {
        material: Material::Markdown,
        additive: true,
        params: [
            render_config::MARKDOWN_HALO_SCALE,
            1.0,
            render_config::MARKDOWN_HALO_ALPHA,
            render_config::MARKDOWN_PARTICLE_RADIUS,
        ],
    },
    // Pass 6（原 Pass 8）：Markdown 面板文字核心（BLEND_PREMULTIPLIED_OVER）
    LayerSpec {
        material: Material::Markdown,
        additive: false,
        params: [
            1.0,
            0.0,
            render_config::MARKDOWN_CORE_ALPHA,
            render_config::MARKDOWN_PARTICLE_RADIUS,
        ],
    },
];
/// The glyph halo follows the active style's bloom size (`params[0]` = `bloom_scale`).
const GLYPH_HALO_LAYER: usize = 3;

struct Layer {
    spec: LayerSpec,
    uniform: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
}

/// 【优化 3：Compute Pre-Pass 阶段缓冲】
/// `raw` 存放 CPU 上传的原始粒子属性（只读 Storage Buffer），
/// `resolved` 存放 Compute Shader 每帧计算 1 次后输出的 `ResolvedSprite`（兼具 Storage 写入与 Vertex 实例读取用途）。
struct ComputeStage {
    raw: wgpu::Buffer,
    resolved: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
    count: u32,
}

impl ComputeStage {
    fn new(
        device: &wgpu::Device,
        layout: &wgpu::BindGroupLayout,
        label: &str,
        raw_bytes: Option<&[u8]>,
        raw_byte_len: u64,
        count: u32,
    ) -> Self {
        let raw_size = raw_byte_len.max(64);
        let raw = match raw_bytes {
            Some(bytes) if !bytes.is_empty() => device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some(label),
                contents: bytes,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            }),
            _ => device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(label),
                size: raw_size,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            }),
        };
        let resolved_size = (count as u64 * RESOLVED_SPRITE_STRIDE).max(64);
        let resolved = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some(label),
            size: resolved_size,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::VERTEX,
            mapped_at_creation: false,
        });
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some(label),
            layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: raw.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: resolved.as_entire_binding() },
            ],
        });
        Self { raw, resolved, bind_group, count }
    }
}

struct Pipelines {
    cs_pulse: wgpu::ComputePipeline,
    cs_field: wgpu::ComputePipeline,
    cs_glyph: wgpu::ComputePipeline,
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
    compute_bind_group_layout: wgpu::BindGroupLayout,
    quad_indices: wgpu::Buffer,
    layers: Vec<Layer>,
    pipelines: Pipelines,
    field: ComputeStage,
    pulse: ComputeStage,
    glyph: ComputeStage,
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
            let a = render_config::BACKDROP_ALPHA;
            let k = if alpha_mode == wgpu::CompositeAlphaMode::PreMultiplied { a } else { 1.0 };
            wgpu::Color { r: render_config::BACKDROP_RGB[0] * k, g: render_config::BACKDROP_RGB[1] * k, b: render_config::BACKDROP_RGB[2] * k, a }
        } else {
            wgpu::Color { r: render_config::BACKDROP_RGB[0], g: render_config::BACKDROP_RGB[1], b: render_config::BACKDROP_RGB[2], a: 1.0 }
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
            cs_pulse: factory.build_compute(&device, "cs_pulse"),
            cs_field: factory.build_compute(&device, "cs_field"),
            cs_glyph: factory.build_compute(&device, "cs_glyph"),
            pulse: factory.build(&device, Material::Pulse, BLEND_PREMULTIPLIED_ADD),
            field_add: factory.build(&device, Material::Field, BLEND_ADD),
            field_over: factory.build(&device, Material::Field, BLEND_OVER),
            glyph: factory.build(&device, Material::Glyph, BLEND_PREMULTIPLIED_ADD),
            markdown_core: factory.build(&device, Material::Markdown, BLEND_PREMULTIPLIED_OVER),
            markdown_halo: factory.build(&device, Material::Markdown, BLEND_PREMULTIPLIED_ADD),
        };
        let compute_bind_group_layout = factory.compute_bind_group_layout;
        let quad_indices = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("quad_indices"),
            contents: bytemuck::cast_slice(&QUAD_INDICES),
            usage: wgpu::BufferUsages::INDEX,
        });

        let empty_vertex = |label| {
            device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(label),
                size: 64,
                usage: wgpu::BufferUsages::VERTEX,
                mapped_at_creation: false,
            })
        };
        let field = ComputeStage::new(&device, &compute_bind_group_layout, "field", None, 64, 0);
        let pulse = ComputeStage::new(&device, &compute_bind_group_layout, "pulse", None, 64, 0);
        let glyph_raw_bytes = (render_config::EVENT_PARTICLE_COUNT * std::mem::size_of::<GlyphInstance>()) as u64;
        let glyph = ComputeStage::new(
            &device,
            &compute_bind_group_layout,
            "glyph",
            None,
            glyph_raw_bytes,
            render_config::EVENT_PARTICLE_COUNT as u32,
        );
        let markdown = (empty_vertex("markdown"), 0);

        Ok(Self {
            surface,
            device,
            queue,
            config,
            clear,
            globals,
            compute_bind_group_layout,
            quad_indices,
            layers,
            pipelines,
            field,
            pulse,
            glyph,
            markdown,
        })
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
        let field_bytes: &[u8] = bytemuck::cast_slice(field);
        let pulse_bytes: &[u8] = bytemuck::cast_slice(pulse);
        self.field = ComputeStage::new(
            &self.device,
            &self.compute_bind_group_layout,
            "field",
            Some(field_bytes),
            field_bytes.len() as u64,
            field.len() as u32,
        );
        self.pulse = ComputeStage::new(
            &self.device,
            &self.compute_bind_group_layout,
            "pulse",
            Some(pulse_bytes),
            pulse_bytes.len() as u64,
            pulse.len() as u32,
        );
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
        let n = glyph.len().min(render_config::EVENT_PARTICLE_COUNT);
        self.queue.write_buffer(&self.glyph.raw, 0, bytemuck::cast_slice(&glyph[..n]));
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

        // 1. Compute Pre-Pass：每颗粒子每帧仅计算 1 次运动方程（三角函数、噪声、伴舞）与 3D 相机投影，
        //    将计算结果写入各自的 ResolvedSprite 缓冲区，供后续 Render Pass 直接读取。
        {
            let mut cpass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("particles_prepass"),
                timestamp_writes: None,
            });
            cpass.set_bind_group(0, &self.layers[0].bind_group, &[]);
            if self.pulse.count > 0 {
                cpass.set_pipeline(&self.pipelines.cs_pulse);
                cpass.set_bind_group(1, &self.pulse.bind_group, &[]);
                cpass.dispatch_workgroups(self.pulse.count.div_ceil(64), 1, 1);
            }
            if self.field.count > 0 {
                cpass.set_pipeline(&self.pipelines.cs_field);
                cpass.set_bind_group(1, &self.field.bind_group, &[]);
                cpass.dispatch_workgroups(self.field.count.div_ceil(64), 1, 1);
            }
            if glyph_visible && self.glyph.count > 0 {
                cpass.set_pipeline(&self.pipelines.cs_glyph);
                cpass.set_bind_group(1, &self.glyph.bind_group, &[]);
                cpass.dispatch_workgroups(self.glyph.count.div_ceil(64), 1, 1);
            }
        }

        // 2. Render Pass：使用 4 顶点 + 静态索引缓冲（QUAD_INDICES）按严格顺序绘制 6 个图层 Pass。
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
            pass.set_index_buffer(self.quad_indices.slice(..), wgpu::IndexFormat::Uint16);
            for layer in &self.layers {
                let (pipeline, buffer, count) = match layer.spec.material {
                    Material::Pulse => (&self.pipelines.pulse, &self.pulse.resolved, self.pulse.count),
                    Material::Field if layer.spec.additive => (&self.pipelines.field_add, &self.field.resolved, self.field.count),
                    Material::Field => (&self.pipelines.field_over, &self.field.resolved, self.field.count),
                    Material::Glyph if glyph_visible => (&self.pipelines.glyph, &self.glyph.resolved, self.glyph.count),
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
                pass.draw_indexed(0..6, 0, 0..count);
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
