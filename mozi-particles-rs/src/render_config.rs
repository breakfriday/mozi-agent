//! 粒子渲染调参入口（编译期配置）。修改后 cargo build --release，再关闭并重开粒子场。
//! 默认面向全屏投影：提高采样密度，同时缩小点尺寸与光晕，减少笔画粘连。
//! 实际帧率取决于显示分辨率和 GPU；这些默认值尚不代表全屏性能保证。

// ── 采样数量 ──
// 背景 / 波纹粒子数 = W × H；文字容量同时用于 CPU 采样、GPU 缓冲区与绘制数量。
pub const FIELD_GRID_W: u32 = 640;
pub const FIELD_GRID_H: u32 = 400;
pub const PULSE_GRID_W: u32 = 160;
pub const PULSE_GRID_H: u32 = 96;
pub const EVENT_PARTICLE_COUNT: usize = 12000;

// ── 字形采样与布局 ──
pub const TEXT_RASTER_SIZE_PX: f32 = 128.0; // 栅格化字号，不是屏幕显示字号
pub const TEXT_SAMPLE_STRIDE: u32 = 1; // (x + y) % stride == 0；1 全采样，2 棋盘式半采样
pub const TEXT_COVERAGE_THRESHOLD: f32 = 0.32; // 字形覆盖率超过此值才采样
pub const TEXT_LETTER_SPACING_PX: f32 = 5.0;
pub const TEXT_MAX_CHARS: usize = 38; // 短消息字数上限；用户/活动发送最近 34 字，AI Markdown 不走此限制
pub const TEXT_MAX_WIDTH: f32 = 8.8; // 以下布局参数均为世界坐标单位；当前仍是单行布局
pub const TEXT_MAX_HEIGHT: f32 = 1.65;
pub const TEXT_PLANE_Z: f32 = 2.3;
pub const TEXT_DEPTH_JITTER: f32 = 0.06; // Z 抖动总跨度，实际为 ± 此值 / 2
pub const TEXT_TARGET_JITTER: f32 = 0.01; // XY 抖动总跨度

// ── 短消息展示节奏（秒）；Markdown 页面持续显示，不使用此计时 ──
// 接收频率不变；成形后保留阅读时间，期间只保存最新内容，不排队播放增量。
pub const PROJECTION_MIN_READ_SECONDS: f32 = 2.5;
pub const PROJECTION_READ_CHARS_PER_SECOND: f32 = 12.0;
pub const PROJECTION_TRANSITION_SECONDS: f32 = 0.35;

// ── 粒子尺寸系数 ──
// 无单位系数，最终屏幕尺寸还经过 Shader 的相机距离衰减与像素上限裁剪。
pub const FIELD_PARTICLE_SIZE: f32 = 1.4;
pub const PULSE_PARTICLE_SIZE: f32 = 1.55;
pub const GLYPH_PARTICLE_SIZE: f32 = 1.35;

// ── 实体层 / 光晕层 Alpha 与光晕尺寸倍率 ──
pub const FIELD_CORE_ALPHA: f32 = 1.0;
pub const FIELD_HALO_ALPHA: f32 = 0.14;
pub const FIELD_HALO_SCALE: f32 = 1.8;
pub const PULSE_CORE_ALPHA: f32 = 0.85;
pub const PULSE_HALO_ALPHA: f32 = 0.36;
pub const PULSE_HALO_SCALE: f32 = 2.5;
pub const GLYPH_CORE_ALPHA: f32 = 0.95;
pub const GLYPH_HALO_ALPHA: f32 = 0.30;

// 文字光晕尺寸随风格切换；初始化及每次风格更新均引用这里，避免被 styles.rs 覆盖。
pub const AUTO_GLYPH_HALO_SCALE: f32 = 1.9;
pub const METEOR_GLYPH_HALO_SCALE: f32 = 2.0;
pub const FIREWORK_GLYPH_HALO_SCALE: f32 = 2.25;
pub const INK_GLYPH_HALO_SCALE: f32 = 1.7;
pub const VORTEX_GLYPH_HALO_SCALE: f32 = 2.05;
pub const AURORA_GLYPH_HALO_SCALE: f32 = 2.1;
pub const RING_GLYPH_HALO_SCALE: f32 = 2.0;
pub const STILL_GLYPH_HALO_SCALE: f32 = 1.75;

// ── 清屏底色 ──
pub const BACKDROP_RGB: [f64; 3] = [6.0 / 255.0, 10.0 / 255.0, 15.0 / 255.0];
pub const BACKDROP_ALPHA: f64 = 0.78; // 仅透明 Surface 使用；0 完全透明，1 不透明

// 避免手动调参导致采样除零，编译时直接指出不合法配置。
const _: () = {
    assert!(FIELD_GRID_W >= 2 && FIELD_GRID_H >= 2);
    assert!(PULSE_GRID_W >= 2 && PULSE_GRID_H >= 2);
    assert!(EVENT_PARTICLE_COUNT >= 2 && EVENT_PARTICLE_COUNT <= u32::MAX as usize);
    assert!(TEXT_SAMPLE_STRIDE >= 1);
    assert!(PROJECTION_MIN_READ_SECONDS > 0.0);
    assert!(PROJECTION_READ_CHARS_PER_SECOND > 0.0);
    assert!(PROJECTION_TRANSITION_SECONDS > 0.0);
};

// Wordcraft page in points; raster scale and sampling are independent of window DPI.
pub const MARKDOWN_PAGE_WIDTH: f32 = 768.0;
pub const MARKDOWN_PAGE_HEIGHT: f32 = 480.0;
pub const MARKDOWN_MARGIN: f32 = 12.0;
pub const MARKDOWN_SCALE: f32 = 2.0;
pub const MARKDOWN_SAMPLE_STRIDE: usize = 1;
pub const MARKDOWN_WORLD_WIDTH: f32 = 10.0;
pub const MARKDOWN_PLANE_Z: f32 = 2.3;

pub const MARKDOWN_ASSEMBLE_SECONDS: f32 = 0.9;
pub const MARKDOWN_DISPERSE_SECONDS: f32 = 1.1;

// Reading rectangle as fractions of the current viewport; layout density in logical pixels.
pub const MARKDOWN_VIEW_WIDTH: f32 = 0.90;
pub const MARKDOWN_VIEW_HEIGHT: f32 = 0.84;
pub const MARKDOWN_POINTS_PER_PIXEL: f32 = 2.0 / 3.0;

// Conversation column fractions inside the reading rectangle.
pub const PROJECTION_LEFT_FRACTION: f32 = 0.70;
pub const PROJECTION_RIGHT_FRACTION: f32 = 0.25;
pub const PROJECTION_BLOCK_GAP_PT: f32 = 12.0;
pub const PROJECTION_USER_SHORT_FONT_PT: f32 = 18.0;
pub const PROJECTION_USER_LONG_FONT_PT: f32 = 13.0;
pub const PROJECTION_USER_SHORT_CHARS: usize = 18;
pub const PROJECTION_ACTIVITY_FONT_PT: f32 = 10.0;
pub const MARKDOWN_REFLOW_SECONDS: f32 = 0.4;

// Shared scene camera; viewport fitting uses its initial pose, never the current zoom.
pub const CAMERA_INITIAL_DISTANCE: f32 = 12.5;
pub const CAMERA_FOV_DEGREES: f32 = 45.0;

// Text particle material: world-space radius relative to sample spacing.
pub const MARKDOWN_COVERAGE_THRESHOLD: f32 = 0.12;
pub const MARKDOWN_PARTICLE_RADIUS: f32 = 0.62;
pub const MARKDOWN_CORE_ALPHA: f32 = 1.0;
pub const MARKDOWN_HALO_ALPHA: f32 = 0.08;
pub const MARKDOWN_HALO_SCALE: f32 = 1.65;
const _: () = {
    assert!(MARKDOWN_ASSEMBLE_SECONDS > 0.0);
    assert!(MARKDOWN_DISPERSE_SECONDS > 0.0);
    assert!(MARKDOWN_REFLOW_SECONDS > 0.0);
    assert!(MARKDOWN_SAMPLE_STRIDE >= 1 && MARKDOWN_SCALE > 0.0);
    assert!(MARKDOWN_PARTICLE_RADIUS > 0.0 && MARKDOWN_HALO_SCALE >= 1.0);
    assert!(MARKDOWN_COVERAGE_THRESHOLD > 0.0 && MARKDOWN_COVERAGE_THRESHOLD < 1.0);
    assert!(MARKDOWN_CORE_ALPHA > 0.0 && MARKDOWN_CORE_ALPHA <= 1.0);
    assert!(MARKDOWN_HALO_ALPHA >= 0.0 && MARKDOWN_HALO_ALPHA <= 1.0);
};

// Minimum raster footprint only; alpha compensates area so distant strokes do not thicken.
pub const MARKDOWN_MIN_RADIUS_PX: f32 = 2.0;
const _: () = assert!(MARKDOWN_MIN_RADIUS_PX > 0.0);
