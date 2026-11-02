use wgpu::util::DeviceExt;

use super::pipeline::{
    Material, PipelineFactory, BLEND_ADD, BLEND_OVER, BLEND_PREMULTIPLIED_ADD, BLEND_PREMULTIPLIED_OVER, QUAD_INDICES,
    RESOLVED_SPRITE_STRIDE,
};
use super::uniforms::{CameraFrame, FieldParams, FocusSignal, Globals, GlyphMotion, PanelParams};
use crate::core::camera::OrbitCamera;
use crate::layers::field::{FieldInstance, PulseInstance};
use crate::layers::glyph::GlyphInstance;
use crate::layers::markdown::board;
use crate::protocol::ProjectionRole;
use crate::render_config;

#[test]
#[ignore = "requires a Vulkan/GL adapter"]
fn low_coverage_ink_does_not_darken_and_billboards_stay_round() {
    pollster::block_on(async {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::default());
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions::default())
            .await
            .expect("GPU adapter");
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor::default(), None)
            .await
            .unwrap();
        // The real pipeline factory: this test exercises exactly what the renderer builds.
        let factory = PipelineFactory::new(&device, wgpu::TextureFormat::Rgba8Unorm);
        let pipeline = factory.build(&device, Material::Markdown, BLEND_PREMULTIPLIED_OVER);
        let quad_indices = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("quad_indices"),
            contents: bytemuck::cast_slice(&QUAD_INDICES),
            usage: wgpu::BufferUsages::INDEX,
        });
        let bgl = &factory.bind_group_layout;
        let entry = board::Entry {
            id: 1,
            key: "test".into(),
            text: String::new(),
            role: ProjectionRole::Assistant,
        };
        let raster = board::Raster {
            image: image::RgbImage::from_pixel(1, 1, image::Rgb([204; 3])),
            source_y: 0,
        };
        let mut samples = board::samples(&entry, &raster, 0, 0, 1, 1);
        samples[0].vertex.position = [0.0, 0.0, render_config::MARKDOWN_PLANE_Z];
        samples[0].vertex.color = [1.0; 3];
        let mut animation = board::Animation::default();
        let mut subpixel_energy = Vec::new();
        let mut cases = vec![(0.0, false, 0.0), (1.0, false, 0.0)];
        cases.extend((0..8).map(|i| (0.0, true, i as f32 / 8.0)));
        for (yaw, subpixel, shift) in cases {
            samples[0].coverage = if subpixel { 1.0 } else { 0.2 };
            let vertices = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: None,
                contents: bytemuck::cast_slice(animation.update(&samples, 0.0)),
                usage: wgpu::BufferUsages::VERTEX,
            });
            let mut camera = OrbitCamera { cruise: false, ..OrbitCamera::default() };
            camera.yaw = yaw;
            let (projection, view) = camera.matrices(3.0, 256.0, 256.0);
            let panel = PanelParams {
                panel: [1.0, if subpixel { 0.025 } else { 0.8 }, render_config::MARKDOWN_ASSEMBLE_SECONDS, render_config::MARKDOWN_DISPERSE_SECONDS],
                motion: [render_config::MARKDOWN_REFLOW_SECONDS, 1.0, render_config::MARKDOWN_PLANE_Z, render_config::MARKDOWN_MIN_RADIUS_PX],
            };
            let frame = CameraFrame { view_proj: projection * view, view, viewport: [256.0, 256.0], dpr: 1.0, time: 3.0 };
            let mut globals = Globals::compose(&frame, &FocusSignal::default(), &FieldParams::default(), &GlyphMotion::default(), &panel);
            if subpixel {
                let translation =
                    glam::Mat4::from_translation(glam::Vec3::new(shift * 2.0 / 256.0, 0.0, 0.0));
                globals.view_proj = (translation
                    * glam::Mat4::from_cols_array_2d(&globals.view_proj))
                .to_cols_array_2d();
            }
            let background = if subpixel { 0.0 } else { 0.65 };
            let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: None,
                contents: bytemuck::bytes_of(&globals),
                usage: wgpu::BufferUsages::UNIFORM,
            });
            let layer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: None,
                contents: bytemuck::cast_slice(&[
                    1.0_f32,
                    0.0,
                    render_config::MARKDOWN_CORE_ALPHA,
                    render_config::MARKDOWN_PARTICLE_RADIUS,
                ]),
                usage: wgpu::BufferUsages::UNIFORM,
            });
            let bindings = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: bgl,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: uniform.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: layer.as_entire_binding(),
                    },
                ],
            });
            let texture = device.create_texture(&wgpu::TextureDescriptor {
                label: None,
                size: wgpu::Extent3d {
                    width: 256,
                    height: 256,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
                view_formats: &[],
            });
            let view = texture.create_view(&Default::default());
            let readback = device.create_buffer(&wgpu::BufferDescriptor {
                label: None,
                size: 256 * 256 * 4,
                usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                mapped_at_creation: false,
            });
            let mut encoder = device.create_command_encoder(&Default::default());
            {
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: None,
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &view,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color {
                                r: background,
                                g: background,
                                b: background,
                                a: 1.0,
                            }),
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    depth_stencil_attachment: None,
                    timestamp_writes: None,
                    occlusion_query_set: None,
                });
                pass.set_pipeline(&pipeline);
                pass.set_bind_group(0, &bindings, &[]);
                pass.set_index_buffer(quad_indices.slice(..), wgpu::IndexFormat::Uint16);
                pass.set_vertex_buffer(0, vertices.slice(..));
                pass.draw_indexed(0..6, 0, 0..1);
            }
            encoder.copy_texture_to_buffer(
                texture.as_image_copy(),
                wgpu::ImageCopyBuffer {
                    buffer: &readback,
                    layout: wgpu::ImageDataLayout {
                        offset: 0,
                        bytes_per_row: Some(1024),
                        rows_per_image: Some(256),
                    },
                },
                wgpu::Extent3d {
                    width: 256,
                    height: 256,
                    depth_or_array_layers: 1,
                },
            );
            queue.submit(Some(encoder.finish()));
            let (tx, rx) = std::sync::mpsc::channel();
            readback
                .slice(..)
                .map_async(wgpu::MapMode::Read, move |r| tx.send(r).unwrap());
            device.poll(wgpu::Maintain::Wait);
            rx.recv().unwrap().unwrap();
            let pixels = readback.slice(..).get_mapped_range();
            if subpixel {
                subpixel_energy.push(pixels.chunks_exact(4).map(|p| p[0] as u32).sum::<u32>());
                continue;
            }
            let mut bounds = [256_u32, 256, 0, 0];
            let mut brightest = 0;
            for (i, p) in pixels.chunks_exact(4).enumerate() {
                assert!(p[0] >= 165, "low coverage must not introduce a dark fringe");
                brightest = brightest.max(p[0]);
                if p[0] > 167 {
                    let x = i as u32 % 256;
                    let y = i as u32 / 256;
                    bounds = [
                        bounds[0].min(x),
                        bounds[1].min(y),
                        bounds[2].max(x),
                        bounds[3].max(y),
                    ];
                }
            }
            assert!(
                (175..=185).contains(&brightest),
                "coverage must remain 20%, got {brightest}"
            );
            let width = bounds[2] - bounds[0];
            let height = bounds[3] - bounds[1];
            assert!(
                width > 10 && width.abs_diff(height) <= 2,
                "billboard squashed at yaw {yaw}: {bounds:?}"
            );
        }
        let min = *subpixel_energy.iter().min().unwrap() as f32;
        let max = *subpixel_energy.iter().max().unwrap() as f32;
        assert!(
            min > 0.0 && max / min < 1.3,
            "subpixel ink must not blink across pixel boundaries: {subpixel_energy:?}"
        );
        eprintln!("subpixel integrated brightness across 8 offsets: {subpixel_energy:?}");
    });
}

/// 验证 3 项 GPU 无损优化（4 顶点索引缓冲、Compute Pre-Pass 预计算、Pulse/Glyph 单 Pass 合并）
/// 在真实 GPU 上完整跑通且产生物理正确的光晕与核心叠加像素。
#[test]
#[ignore = "requires a Vulkan/GL adapter"]
fn compute_prepass_and_merged_passes_render_accurately() {
    pollster::block_on(async {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::default());
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions::default())
            .await
            .expect("GPU adapter");
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor::default(), None)
            .await
            .unwrap();
        let factory = PipelineFactory::new(&device, wgpu::TextureFormat::Rgba8Unorm);

        let cs_pulse = factory.build_compute(&device, "cs_pulse");
        let cs_field = factory.build_compute(&device, "cs_field");
        let cs_glyph = factory.build_compute(&device, "cs_glyph");

        let p_pulse = factory.build(&device, Material::Pulse, BLEND_PREMULTIPLIED_ADD);
        let p_field_add = factory.build(&device, Material::Field, BLEND_ADD);
        let p_field_over = factory.build(&device, Material::Field, BLEND_OVER);
        let p_glyph = factory.build(&device, Material::Glyph, BLEND_PREMULTIPLIED_ADD);

        let quad_indices = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("quad_indices"),
            contents: bytemuck::cast_slice(&QUAD_INDICES),
            usage: wgpu::BufferUsages::INDEX,
        });

        let camera = OrbitCamera { cruise: false, ..OrbitCamera::default() };
        let (projection, view) = camera.matrices(2.0, 128.0, 128.0);
        let frame = CameraFrame { view_proj: projection * view, view, viewport: [128.0, 128.0], dpr: 1.0, time: 2.0 };
        let globals = Globals::compose(
            &frame,
            &FocusSignal { age: 1.2, ..FocusSignal::default() },
            &FieldParams { depth: 1.0, pulse_alpha: 1.0, ..FieldParams::default() },
            &GlyphMotion::default(),
            &PanelParams::default(),
        );
        let globals_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: None,
            contents: bytemuck::bytes_of(&globals),
            usage: wgpu::BufferUsages::UNIFORM,
        });

        let make_layer_bg = |params: [f32; 4]| {
            let u = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: None,
                contents: bytemuck::cast_slice(&params),
                usage: wgpu::BufferUsages::UNIFORM,
            });
            device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &factory.bind_group_layout,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: globals_buf.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 1, resource: u.as_entire_binding() },
                ],
            })
        };

        let bg_pulse = make_layer_bg([
            render_config::PULSE_HALO_SCALE,
            render_config::PULSE_CORE_ALPHA,
            render_config::PULSE_HALO_ALPHA,
            render_config::PULSE_PARTICLE_SIZE,
        ]);
        let bg_field_halo = make_layer_bg([
            render_config::FIELD_HALO_SCALE,
            1.0,
            render_config::FIELD_HALO_ALPHA,
            render_config::FIELD_PARTICLE_SIZE,
        ]);
        let bg_field_core = make_layer_bg([
            1.0,
            0.0,
            render_config::FIELD_CORE_ALPHA,
            render_config::FIELD_PARTICLE_SIZE,
        ]);
        let bg_glyph = make_layer_bg([
            render_config::AUTO_GLYPH_HALO_SCALE,
            render_config::GLYPH_CORE_ALPHA,
            render_config::GLYPH_HALO_ALPHA,
            render_config::GLYPH_PARTICLE_SIZE,
        ]);

        let make_stage = |bytes: &[u8], count: u32| {
            let raw = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: None,
                contents: bytes,
                usage: wgpu::BufferUsages::STORAGE,
            });
            let resolved = device.create_buffer(&wgpu::BufferDescriptor {
                label: None,
                size: count as u64 * RESOLVED_SPRITE_STRIDE,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::VERTEX,
                mapped_at_creation: false,
            });
            let bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &factory.compute_bind_group_layout,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: raw.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 1, resource: resolved.as_entire_binding() },
                ],
            });
            (resolved, bg, count)
        };

        let pulse_data = [PulseInstance { uv: [0.5, 0.4], rand: 0.3, color: [0.3, 0.7, 1.0] }];
        let field_data = [FieldInstance { position: [0.0, 0.0, 0.0], color: [0.2, 0.6, 0.9] }];
        let glyph_data = [GlyphInstance {
            home_pos: [0.0, 0.0, 0.0],
            target_pos: [0.0, 0.0, 0.0],
            home_color: [0.4, 0.8, 1.0],
            seed: 0.1,
        }];

        let (pulse_res, pulse_cbg, pulse_n) = make_stage(bytemuck::cast_slice(&pulse_data), 1);
        let (field_res, field_cbg, field_n) = make_stage(bytemuck::cast_slice(&field_data), 1);
        let (glyph_res, glyph_cbg, glyph_n) = make_stage(bytemuck::cast_slice(&glyph_data), 1);

        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: None,
            size: wgpu::Extent3d { width: 128, height: 128, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = texture.create_view(&Default::default());
        let readback = device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: 128 * 128 * 4,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });

        let mut encoder = device.create_command_encoder(&Default::default());
        {
            let mut cpass = encoder.begin_compute_pass(&Default::default());
            cpass.set_bind_group(0, &bg_pulse, &[]);
            cpass.set_pipeline(&cs_pulse);
            cpass.set_bind_group(1, &pulse_cbg, &[]);
            cpass.dispatch_workgroups(1, 1, 1);

            cpass.set_pipeline(&cs_field);
            cpass.set_bind_group(1, &field_cbg, &[]);
            cpass.dispatch_workgroups(1, 1, 1);

            cpass.set_pipeline(&cs_glyph);
            cpass.set_bind_group(1, &glyph_cbg, &[]);
            cpass.dispatch_workgroups(1, 1, 1);
        }
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: None,
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            pass.set_index_buffer(quad_indices.slice(..), wgpu::IndexFormat::Uint16);

            pass.set_pipeline(&p_pulse);
            pass.set_bind_group(0, &bg_pulse, &[]);
            pass.set_vertex_buffer(0, pulse_res.slice(..));
            pass.draw_indexed(0..6, 0, 0..pulse_n);

            pass.set_pipeline(&p_field_add);
            pass.set_bind_group(0, &bg_field_halo, &[]);
            pass.set_vertex_buffer(0, field_res.slice(..));
            pass.draw_indexed(0..6, 0, 0..field_n);

            pass.set_pipeline(&p_field_over);
            pass.set_bind_group(0, &bg_field_core, &[]);
            pass.set_vertex_buffer(0, field_res.slice(..));
            pass.draw_indexed(0..6, 0, 0..field_n);

            pass.set_pipeline(&p_glyph);
            pass.set_bind_group(0, &bg_glyph, &[]);
            pass.set_vertex_buffer(0, glyph_res.slice(..));
            pass.draw_indexed(0..6, 0, 0..glyph_n);
        }
        encoder.copy_texture_to_buffer(
            texture.as_image_copy(),
            wgpu::ImageCopyBuffer {
                buffer: &readback,
                layout: wgpu::ImageDataLayout {
                    offset: 0,
                    bytes_per_row: Some(128 * 4),
                    rows_per_image: Some(128),
                },
            },
            wgpu::Extent3d { width: 128, height: 128, depth_or_array_layers: 1 },
        );
        queue.submit(Some(encoder.finish()));
        let (tx, rx) = std::sync::mpsc::channel();
        readback.slice(..).map_async(wgpu::MapMode::Read, move |r| tx.send(r).unwrap());
        device.poll(wgpu::Maintain::Wait);
        rx.recv().unwrap().unwrap();
        let pixels = readback.slice(..).get_mapped_range();
        let max_alpha = pixels.chunks_exact(4).map(|p| p[3]).max().unwrap_or(0);
        assert!(max_alpha > 200, "Compute pre-pass + merged Glyph/Pulse must render bright center particles, got max_alpha={max_alpha}");
    });
}
