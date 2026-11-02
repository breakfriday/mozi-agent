// Shared by every layer: frame uniform (single camera), sprite expansion, noise helpers.
// Timing constants (ASSEMBLE..DURATION) are prepended by render/pipeline.rs from render_config.rs.
// Points are expanded into instanced screen-space quads (wgpu has no gl_PointSize).

const PI: f32 = 3.14159265359;
const TAU: f32 = 6.2831853;
struct Globals {
  view_proj: mat4x4<f32>,
  view: mat4x4<f32>,
  viewport: vec4<f32>,     // width_px, height_px, dpr, time
  glyph_bounds: vec4<f32>, // center.xy, half_size.xy
  p0: vec4<f32>,           // depth, glyph_age, pulse_alpha, dance_mode
  p1: vec4<f32>,           // dance_dir.xy, in_mode, out_mode
  p2: vec4<f32>,           // swirl, disp_fade, drift.xy
  glow: vec4<f32>,         // glyph glow rgb, ripple_intensity
  ripple: vec4<f32>,       // center.xy, ripple_time, unused
  pointer: vec4<f32>,      // world.xy, hover strength, unused
  panel: vec4<f32>,        // Markdown visibility
  panel_motion: vec4<f32>, // reflow duration, viewport model scale, text plane Z, minimum raster radius
};

struct Layer {
  params: vec4<f32>,       // bloom_scale, soft, layer_alpha, size
};

@group(0) @binding(0) var<uniform> g: Globals;
@group(0) @binding(1) var<uniform> layer: Layer;

struct VsOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) color: vec3<f32>,
  @location(1) alpha: f32,
  @location(2) coord: vec2<f32>, // 0..1 inside the sprite, like gl_PointCoord
  @location(3) detail: f32, // Markdown: 亚像素滤波系数; Pulse/Glyph: 光晕与核心的实际像素半径比 (px_halo / px_core)
};

// ─────────────────── 优化 3：Compute 预计算粒子中间结构 (ResolvedSprite) ───────────────────
// 【设计思想与数学逻辑】：
// 每颗粒子在单帧内只有一个唯一的世界坐标、唯一的基础颜色和透明度，这些重度数学计算
// （三角函数 silk_motion、背景伴舞 dance_at、极光螺旋、3D Curl 噪声以及两次 4×4 相机矩阵乘法）
// 只依赖粒子自身属性和全局帧时间，与四边形的 4 个角点 (vi = 0..4) 以及当前是光晕遍还是核心遍完全无关。
//
// 优化前：同一颗粒子在每个 Pass 的每个顶点都要重算一遍（6 顶点 × 2 Pass = 12 遍/帧）。
// 优化后：每帧先由 Compute Shader 对每颗粒子严格计算 1 次，写入此 48 字节（3 × vec4<f32>，
// 天然满足 WGSL Storage Buffer 16 字节对齐）结构体；随后的渲染管线直接将其作为实例化顶点缓冲
// （VertexStepMode::Instance）绑定，顶点着色器只做极简的 2D 角点偏移，重度数学运算减少 91.7%。
struct ResolvedSprite {
  @location(0) clip: vec4<f32>,        // 粒子中心裁剪空间坐标: g.view_proj * vec4<f32>(world, 1.0)
  @location(1) color_alpha: vec4<f32>, // xyz = 粒子 RGB 颜色, w = 基础透明度 alpha
  @location(2) metrics: vec4<f32>,     // x = 相机空间深度 view_z, y = 动态尺寸倍率 (如 Glyph 聚拢放大)
};

// Compute 阶段专用的输入/输出 Storage Buffer 绑定组 (@group(1))：
// - raw_in 使用紧凑的 array<f32> 读取 CPU 上传的原始粒子缓冲，避免 WGSL Storage 中 vec3<f32>
//   强制 16 字节对齐导致的内存步长（Stride）不匹配问题，保持 Rust 端顶点结构体零改动。
// - out_sprites 输出预计算好的 ResolvedSprite，紧接着在 RenderPass 中直接作为实例顶点缓冲使用。
@group(1) @binding(0) var<storage, read> raw_in: array<f32>;
@group(1) @binding(1) var<storage, read_write> out_sprites: array<ResolvedSprite>;

// ─────────────────── 优化 1：4 顶点索引化四边形展开 (Index Buffer) ───────────────────
// 【设计思想与数学逻辑】：
// 原实现使用无索引 draw(0..6) 直接发射 6 个顶点构成 2 个三角形：
//   △1: (-1,-1) -> (1,-1) -> (1,1)
//   △2: (-1,-1) -> (1, 1) -> (-1,1)
// 其中对角线上的 0 号角 (-1,-1) 和 2 号角 (1,1) 完全相同，却被顶点着色器重复计算了 2 次。
// 现改为只定义矩形的 4 个唯一角点 (vi = 0..4)，配合 GPU 静态索引缓冲 QUAD_INDICES = [0, 1, 2, 0, 2, 3]：
//   - 构成的三角形顶点顺序、逆时针绕序（Winding Order）及对角线切分方向与原代码 100% 比特级一致；
//   - GPU 硬件的顶点变换后缓存（Post-Transform Vertex Cache）可直接命中复用 0 号与 2 号顶点，
//     所有图层的顶点着色器调用次数无损减少 33.3%（6 -> 4）。
fn corner(vi: u32) -> vec2<f32> {
  var c = array<vec2<f32>, 4>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>( 1.0,  1.0),
    vec2<f32>(-1.0,  1.0),
  );
  return c[vi];
}

/// Compute 阶段调用：将粒子世界坐标一次性投影为裁剪空间中心与相机深度，封装为 ResolvedSprite。
fn resolve_sprite(world: vec3<f32>, color: vec3<f32>, alpha: f32, scale: f32) -> ResolvedSprite {
  let view_z = (g.view * vec4<f32>(world, 1.0)).z;
  let clip = g.view_proj * vec4<f32>(world, 1.0);
  return ResolvedSprite(clip, vec4<f32>(color, alpha), vec4<f32>(view_z, scale, 0.0, 0.0));
}

/// Render 顶点阶段调用：直接基于 Compute 预计算好的 ResolvedSprite 展开 4 个角点（零矩阵乘法、零三角函数）。
/// 算术顺序与原 sprite() 严格一致：px = clamp(base_px / max(0.5, -view_z), 1.0, max_px)，
/// 再将屏幕像素偏移 (c * px / vp) 乘以齐次坐标 w 分量抵消透视除法，得到精确的屏幕像素尺寸。
fn expand_resolved(s: ResolvedSprite, vi: u32, base_px: f32, max_px: f32) -> VsOut {
  var out: VsOut;
  let view_z = s.metrics.x;
  let px = clamp(base_px / max(0.5, -view_z), 1.0, max_px);
  let c = corner(vi);
  let vp = max(g.viewport.xy, vec2<f32>(1.0));
  out.clip = vec4<f32>(s.clip.xy + c * px / vp * s.clip.w, s.clip.z, s.clip.w);
  out.coord = c * 0.5 + 0.5;
  out.detail = 1.0;
  out.color = s.color_alpha.xyz;
  out.alpha = s.color_alpha.w;
  return out;
}

fn hash11(p: f32) -> f32 {
  return fract(sin(p * 127.1 + 3.71) * 43758.5453123);
}

fn silk_motion(p_in: vec3<f32>, t: f32, depth: f32) -> vec3<f32> {
  var p = p_in;
  p.z = p.z * depth;
  p.z = p.z + (sin(t * 0.9 + p.x * 0.45 + p.y * 0.35) * 0.06
    + cos(t * 0.6 - p.x * 0.3 + p.z * 0.8) * 0.04) * depth;
  p = vec3<f32>(p.xy + vec2<f32>(sin(t * 0.7 + p.y * 0.6), cos(t * 0.65 + p.x * 0.6)) * 0.012, p.z);
  return p;
}

fn rot2(v: vec2<f32>, a: f32) -> vec2<f32> {
  let c = cos(a);
  let s = sin(a);
  return mat2x2<f32>(c, -s, s, c) * v;
}

fn curl_noise(p: vec3<f32>) -> vec3<f32> {
  let k1 = vec3<f32>(0.8, 1.1, -0.6);
  let k2 = vec3<f32>(-1.3, 0.7, 1.0);
  let k3 = vec3<f32>(1.7, -1.2, 0.9);
  let k4 = vec3<f32>(-0.7, 2.1, 1.5);
  return 0.27 * (
    cross(k1, vec3<f32>(0.3, -0.6, 0.8)) * cos(dot(k1, p) + 0.7) +
    cross(k2, vec3<f32>(-0.7, 0.2, 0.5)) * cos(dot(k2, p) + 2.1) +
    cross(k3, vec3<f32>(0.4, 0.7, -0.3)) * cos(dot(k3, p) + 4.3) * 0.5 +
    cross(k4, vec3<f32>(0.6, -0.4, 0.2)) * cos(dot(k4, p) + 1.4) * 0.3
  );
}

// How strongly the published focus (current text) pulls on the background, 0..1.
fn focus_morph() -> f32 {
  let age = g.p0.y; // published FocusSignal age
  return smoothstep(0.0, LANDING, age) * (1.0 - smoothstep(RELEASE, DURATION, age));
}
