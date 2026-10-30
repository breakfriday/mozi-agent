use super::*;

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
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("actual text material"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shader.wgsl").into()),
        });
        let uniform_entry = |binding| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        };
        let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: None,
            entries: &[uniform_entry(0), uniform_entry(1)],
        });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: None,
            bind_group_layouts: &[&bgl],
            push_constant_ranges: &[],
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: None,
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: "vs_markdown",
                compilation_options: Default::default(),
                buffers: &[wgpu::VertexBufferLayout {
                    array_stride: std::mem::size_of::<crate::projection_board::Particle>() as u64,
                    step_mode: wgpu::VertexStepMode::Instance,
                    attributes: &MARKDOWN_ATTRS,
                }],
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: "fs_markdown",
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    blend: Some(BLEND_PREMULTIPLIED_OVER),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: Default::default(),
            depth_stencil: None,
            multisample: Default::default(),
            multiview: None,
            cache: None,
        });
        let entry = crate::projection_board::Entry {
            id: 1,
            key: "test".into(),
            text: String::new(),
            role: crate::scene::ProjectionRole::Assistant,
        };
        let raster = crate::projection_board::Raster {
            image: image::RgbImage::from_pixel(1, 1, image::Rgb([204; 3])),
            source_y: 0,
        };
        let mut samples = crate::projection_board::samples(&entry, &raster, 0, 0, 1, 1);
        samples[0].vertex.position = [0.0, 0.0, MARKDOWN_PLANE_Z];
        samples[0].vertex.color = [1.0; 3];
        let mut animation = crate::projection_board::Animation::default();
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
            let mut scene = crate::scene::Scene::new(None, None);
            scene.cruise = false;
            scene.time = 3.0;
            scene.camera.yaw = yaw;
            let mut globals = scene.globals(256.0, 256.0, 1.0);
            globals.panel = [
                1.0,
                if subpixel { 0.025 } else { 0.8 },
                MARKDOWN_ASSEMBLE_SECONDS,
                MARKDOWN_DISPERSE_SECONDS,
            ];
            globals.panel_motion = [
                MARKDOWN_REFLOW_SECONDS,
                1.0,
                MARKDOWN_PLANE_Z,
                MARKDOWN_MIN_RADIUS_PX,
            ];
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
                    MARKDOWN_CORE_ALPHA,
                    MARKDOWN_PARTICLE_RADIUS,
                ]),
                usage: wgpu::BufferUsages::UNIFORM,
            });
            let bindings = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &bgl,
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
                pass.set_vertex_buffer(0, vertices.slice(..));
                pass.draw(0..6, 0..1);
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
