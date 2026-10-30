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
  @location(3) detail: f32, // text raster detail; unused by other materials
};

fn corner(vi: u32) -> vec2<f32> {
  var c = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0),
  );
  return c[vi];
}

/// Projects a world-space point and expands it into a pixel-sized sprite.
fn sprite(world: vec3<f32>, vi: u32, base_px: f32, max_px: f32) -> VsOut {
  var out: VsOut;
  let view_z = (g.view * vec4<f32>(world, 1.0)).z;
  let px = clamp(base_px / max(0.5, -view_z), 1.0, max_px);
  let c = corner(vi);
  var clip = g.view_proj * vec4<f32>(world, 1.0);
  let vp = max(g.viewport.xy, vec2<f32>(1.0));
  clip = vec4<f32>(clip.xy + c * px / vp * clip.w, clip.z, clip.w);
  out.clip = clip;
  out.coord = c * 0.5 + 0.5;
  out.detail = 1.0;
  out.color = vec3<f32>(0.0);
  out.alpha = 1.0;
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
