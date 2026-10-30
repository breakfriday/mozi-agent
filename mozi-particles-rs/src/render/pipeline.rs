//! Blend states, per-material vertex layouts, shader assembly and the one pipeline factory
//! used by both the renderer and GPU tests (so tests exercise the real pipelines).
use crate::layers::field::{FieldInstance, PulseInstance};
use crate::layers::glyph::GlyphInstance;
use crate::layers::markdown::Particle;
use crate::render_config::*;

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

static FIELD_ATTRS: [wgpu::VertexAttribute; 2] = wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3];
static PULSE_ATTRS: [wgpu::VertexAttribute; 3] = wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32, 2 => Float32x3];
static GLYPH_ATTRS: [wgpu::VertexAttribute; 4] =
    wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3, 2 => Float32x3, 3 => Float32];
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
            Material::Pulse => (std::mem::size_of::<PulseInstance>(), &PULSE_ATTRS),
            Material::Field => (std::mem::size_of::<FieldInstance>(), &FIELD_ATTRS),
            Material::Glyph => (std::mem::size_of::<GlyphInstance>(), &GLYPH_ATTRS),
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
        GLYPH_ASSEMBLE_SECONDS,
        GLYPH_STAGGER_SECONDS,
        GLYPH_HOLD_SECONDS,
        GLYPH_DISPERSE_SECONDS,
        GLYPH_LANDING,
        GLYPH_RELEASE,
        GLYPH_DURATION,
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
    layout: wgpu::PipelineLayout,
    shader: wgpu::ShaderModule,
    format: wgpu::TextureFormat,
}

impl PipelineFactory {
    pub fn new(device: &wgpu::Device, format: wgpu::TextureFormat) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("particles.wgsl"),
            source: wgpu::ShaderSource::Wgsl(shader_source().into()),
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
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("frame+layer"),
            entries: &[uniform_entry(0), uniform_entry(1)],
        });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("particles"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });
        Self { bind_group_layout, layout, shader, format }
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
