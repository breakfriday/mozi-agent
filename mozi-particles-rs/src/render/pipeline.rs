//! Blend states, per-material vertex layouts, shader assembly and the one pipeline factory
//! used by both the renderer and GPU tests (so tests exercise the real pipelines).
use crate::layers::markdown::Particle;
use crate::render_config;

/// 【优化 1：4 顶点 + 静态索引缓冲（Index Buffer）】
/// 设计思想与数学逻辑：
/// 每个粒子是一个矩形广告牌（Quad），几何上只有 4 个唯一角点：
///   0: (-0.5, -0.5), 1: (0.5, -0.5), 2: (0.5, 0.5), 3: (-0.5, 0.5)
/// 原方案使用无索引 `draw(0..6)`，对角线上的顶点 0 和顶点 2 在每次绘制中都被顶点着色器重复计算了 2 遍。
/// 改为 4 个唯一顶点配合静态索引 `[0, 1, 2, 0, 2, 3]` 后，光栅化生成的两个三角形 `(0,1,2)` 与 `(0,2,3)`
/// 的顶点坐标、绕序和插值 UV 与原方案 100% 严格一致，同时所有图层顶点着色器调用次数直接减少 33.3%。
pub const QUAD_INDICES: [u16; 6] = [0, 1, 2, 0, 2, 3];

/// 【优化 3：Compute 预计算输出结构 `ResolvedSprite` 的字节步长】
/// 对应 `common.wgsl` 中的 `struct ResolvedSprite`（3 个 `vec4<f32>` = 48 字节，天然满足 16 字节对齐）。
pub const RESOLVED_SPRITE_STRIDE: u64 = 48;

/// Straight-alpha "over" that keeps the framebuffer valid premultiplied (RGB <= A).
pub const BLEND_OVER: wgpu::BlendState = wgpu::BlendState {
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
pub const BLEND_ADD: wgpu::BlendState = wgpu::BlendState {
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
pub const BLEND_PREMULTIPLIED_OVER: wgpu::BlendState = wgpu::BlendState {
    color: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, ..BLEND_OVER.color },
    alpha: BLEND_OVER.alpha,
};
pub const BLEND_PREMULTIPLIED_ADD: wgpu::BlendState = wgpu::BlendState {
    color: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, ..BLEND_ADD.color },
    alpha: BLEND_ADD.alpha,
};

/// `Pulse`、`Field`、`Glyph` 经 Compute Pre-Pass 预计算后，统一输出为 `ResolvedSprite`（3 × `Float32x4`）。
static RESOLVED_ATTRS: [wgpu::VertexAttribute; 3] =
    wgpu::vertex_attr_array![0 => Float32x4, 1 => Float32x4, 2 => Float32x4];
static MARKDOWN_ATTRS: [wgpu::VertexAttribute; 6] =
    wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3, 2 => Float32x2, 3 => Float32x3, 4 => Float32, 5 => Float32x2];

/// One instanced sprite material per layer geometry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Material {
    Pulse,
    Field,
    Glyph,
    Markdown,
}

impl Material {
    fn entry_points(self) -> (&'static str, &'static str) {
        match self {
            Material::Pulse => ("vs_pulse", "fs_pulse"),
            Material::Field => ("vs_field", "fs_field"),
            Material::Glyph => ("vs_glyph", "fs_glyph"),
            Material::Markdown => ("vs_markdown", "fs_markdown"),
        }
    }

    fn vertex_layout(self) -> wgpu::VertexBufferLayout<'static> {
        let (stride, attributes): (usize, &'static [wgpu::VertexAttribute]) = match self {
            Material::Pulse | Material::Field | Material::Glyph => (RESOLVED_SPRITE_STRIDE as usize, &RESOLVED_ATTRS),
            Material::Markdown => (std::mem::size_of::<Particle>(), &MARKDOWN_ATTRS),
        };
        wgpu::VertexBufferLayout { array_stride: stride as u64, step_mode: wgpu::VertexStepMode::Instance, attributes }
    }
}

/// Generated timing constants + shared helpers + one file per layer, compiled as a single module.
pub fn shader_source() -> String {
    let timing = format!(
        "// Generated from render_config.rs — do not duplicate in .wgsl files.\n\
         const ASSEMBLE: f32 = {:.6};\nconst STAGGER: f32 = {:.6};\nconst HOLD: f32 = {:.6};\nconst DISPERSE: f32 = {:.6};\n\
         const LANDING: f32 = {:.6};\nconst RELEASE: f32 = {:.6};\nconst DURATION: f32 = {:.6};\n",
        render_config::GLYPH_ASSEMBLE_SECONDS,
        render_config::GLYPH_STAGGER_SECONDS,
        render_config::GLYPH_HOLD_SECONDS,
        render_config::GLYPH_DISPERSE_SECONDS,
        render_config::GLYPH_LANDING,
        render_config::GLYPH_RELEASE,
        render_config::GLYPH_DURATION,
    );
    [
        timing.as_str(),
        include_str!("common.wgsl"),
        include_str!("../layers/field/field.wgsl"),
        include_str!("../layers/glyph/glyph.wgsl"),
        include_str!("../layers/markdown/markdown.wgsl"),
    ]
    .join("\n")
}

pub struct PipelineFactory {
    pub bind_group_layout: wgpu::BindGroupLayout,
    pub compute_bind_group_layout: wgpu::BindGroupLayout,
    layout: wgpu::PipelineLayout,
    compute_layout: wgpu::PipelineLayout,
    shader: wgpu::ShaderModule,
    format: wgpu::TextureFormat,
}

impl PipelineFactory {
    pub fn new(device: &wgpu::Device, format: wgpu::TextureFormat) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("particles.wgsl"),
            source: wgpu::ShaderSource::Wgsl(shader_source().into()),
        });
        // 允许 VERTEX | FRAGMENT | COMPUTE 共享 @group(0) 全局与图层 Uniform 绑定
        let uniform_entry = |binding| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT | wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        };
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("frame+layer"),
            entries: &[uniform_entry(0), uniform_entry(1)],
        });
        // Compute Pre-Pass 专用的 @group(1) 布局：binding(0) 只读原始粒子缓冲，binding(1) 可读写 ResolvedSprite 缓冲
        let storage_entry = |binding, read_only| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Storage { read_only },
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        };
        let compute_bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("compute_io"),
            entries: &[storage_entry(0, true), storage_entry(1, false)],
        });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("particles"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });
        let compute_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("particles_compute"),
            bind_group_layouts: &[&bind_group_layout, &compute_bind_group_layout],
            push_constant_ranges: &[],
        });
        Self { bind_group_layout, compute_bind_group_layout, layout, compute_layout, shader, format }
    }

    /// 构建每帧执行 1 次粒子物理与投影预计算的 Compute Pipeline（`cs_pulse` / `cs_field` / `cs_glyph`）。
    pub fn build_compute(&self, device: &wgpu::Device, entry_point: &str) -> wgpu::ComputePipeline {
        device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some(entry_point),
            layout: Some(&self.compute_layout),
            module: &self.shader,
            entry_point,
            compilation_options: Default::default(),
            cache: None,
        })
    }

    pub fn build(&self, device: &wgpu::Device, material: Material, blend: wgpu::BlendState) -> wgpu::RenderPipeline {
        let (vs, fs) = material.entry_points();
        let buffers = [material.vertex_layout()];
        device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some(vs),
            layout: Some(&self.layout),
            vertex: wgpu::VertexState {
                module: &self.shader,
                entry_point: vs,
                compilation_options: Default::default(),
                buffers: &buffers,
            },
            fragment: Some(wgpu::FragmentState {
                module: &self.shader,
                entry_point: fs,
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: self.format,
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
    }
}
