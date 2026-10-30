// Mozi native particle engine — WGSL port of the Three.js SILK / PULSE / GLYPH shaders.
// Points are expanded into instanced screen-space quads (wgpu has no gl_PointSize).

const PI: f32 = 3.14159265359;
const TAU: f32 = 6.2831853;
// Keep in sync with sampling.rs
const ASSEMBLE: f32 = 1.0;
const STAGGER: f32 = 0.45;
const HOLD: f32 = 2.0;
const DISPERSE: f32 = 1.5;
const LANDING: f32 = 1.45;  // ASSEMBLE + STAGGER
const RELEASE: f32 = 3.45;  // LANDING + HOLD
const DURATION: f32 = 5.4;  // RELEASE + DISPERSE + STAGGER

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

// Terse 6-mode gentle field choreography around the glyph center.
fn dance_at(p: vec2<f32>, rnd: f32, amt: f32, mode: f32, t: f32, center: vec2<f32>, dir: vec2<f32>) -> vec3<f32> {
  if (amt < 0.001) { return vec3<f32>(0.0); }
  let d = p - center;
  let dist = length(d);
  let reach = exp(-(dist * dist) / 14.0);
  var o = vec3<f32>(0.0);
  if (mode < 0.5) {          // CLOUD 行云
    let ph = dot(p, dir) * 0.80 - t * 1.15;
    o = vec3<f32>(dir * cos(ph) * 0.11, sin(ph) * 0.44);
  } else if (mode < 1.5) {   // SWIRL 回旋
    let a = 0.42 * reach * sin(t * 0.85);
    o = vec3<f32>(rot2(d, a) - d, reach * sin(t * 1.25 + dist * 0.4) * 0.30);
  } else if (mode < 2.5) {   // BREATHE 呼吸
    let b = sin(t * 1.05) * reach;
    o = vec3<f32>(d / max(dist, 0.001) * b * 0.36, b * 0.38);
  } else if (mode < 3.5) {   // SWAY 摇曳
    let sway = sin(t * 0.95 + p.y * 0.50 + rnd * 1.3);
    o = vec3<f32>(sway * (0.11 + abs(p.y) * 0.070), 0.0, sway * 0.20 * (0.35 + reach));
  } else if (mode < 4.5) {   // STARFALL 星落
    let ph = t * 1.45 + rnd * TAU;
    o = vec3<f32>(vec2<f32>(cos(ph * 0.7), sin(ph * 0.5)) * 0.055, sin(ph) * 0.32 * (0.40 + reach));
  } else {                   // RIPPLE 涟纹
    let ph = dot(p, dir) * 1.75 + sin(t * 0.55) * 1.5;
    o = vec3<f32>(dir * sin(ph) * 0.065, sin(ph) * cos(dist * 0.45 - t * 0.75) * 0.38);
  }
  return o * amt;
}

fn glyph_morph() -> f32 {
  let age = g.p0.y;
  return smoothstep(0.0, LANDING, age) * (1.0 - smoothstep(RELEASE, DURATION, age));
}

// ───────────────────────────── SILK field ─────────────────────────────

struct FieldIn {
  @location(0) position: vec3<f32>,
  @location(1) color: vec3<f32>,
};

@vertex
fn vs_field(@builtin(vertex_index) vi: u32, inst: FieldIn) -> VsOut {
  let t = g.viewport.w;
  let depth = g.p0.x;
  var p = silk_motion(inst.position, t, depth);

  let elapsed = t - g.ripple.z;
  var wave = 0.0;
  if (elapsed >= 0.0 && elapsed < 7.0) {
    let dist = distance(p.xy, g.ripple.xy);
    let front = dist - elapsed * 2.4;
    let envelope = exp(-(front * front) / 0.65);
    wave = sin(front * 7.0) * envelope * smoothstep(0.0, 0.18, elapsed) * exp(-elapsed * 0.8);
  }

  let offset = p.xy - g.pointer.xy;
  let dp = length(offset);
  let hover = exp(-(dp * dp) / 0.48) * g.pointer.z;

  let morph = glyph_morph();
  let box = max(abs(inst.position.xy - g.glyph_bounds.xy) - g.glyph_bounds.zw, vec2<f32>(0.0)) / vec2<f32>(0.85, 0.55);
  let well = exp(-dot(box, box) * 1.8) * morph;
  let sparkle = fract(sin(dot(inst.position.xy, vec2<f32>(127.1, 311.7))) * 43758.5453);
  let dnc = dance_at(p.xy, sparkle, morph * 0.42, g.p0.w, t, g.glyph_bounds.xy, g.p1.xy);

  p = vec3<f32>(p.xy + dnc.xy + offset / max(dp, 0.001) * hover * 0.07, p.z + dnc.z * depth - well * 0.45);
  p.z = p.z + wave * g.glow.w + hover * 0.24;

  let s = 0.5 + 0.5 * sin(t * 1.3 + sparkle * 71.0);
  let s2 = s * s;
  let shimmer = smoothstep(0.96, 1.0, sparkle) * s2 * s2 * s2 * 0.15;

  var out = sprite(p, vi, layer.params.w * layer.params.x * 15.0, 18.0 * max(1.0, layer.params.x * 0.6));
  out.color = inst.color * (1.0 + abs(wave) * 0.85 + hover * 0.25 + shimmer) * (1.0 - well * 0.4);
  out.alpha = 1.0;
  return out;
}

@fragment
fn fs_field(in: VsOut) -> @location(0) vec4<f32> {
  let r = length(in.coord - 0.5);
  if (r > 0.5) { discard; }
  let soft = layer.params.y;
  let edge = 1.0 - smoothstep(mix(0.32, 0.04, soft), 0.5, r);
  let a = mix(edge, edge * edge, soft) * layer.params.z;
  return vec4<f32>(clamp(in.color, vec3<f32>(0.0), vec3<f32>(1.0)), clamp(a, 0.0, 1.0));
}

// ───────────────────────── PULSE aurora + star dust ─────────────────────────

struct PulseIn {
  @location(0) uv: vec2<f32>,
  @location(1) rand: f32,
  @location(2) color: vec3<f32>,
};

@vertex
fn vs_pulse(@builtin(vertex_index) vi: u32, inst: PulseIn) -> VsOut {
  let t = g.viewport.w;
  let depth = g.p0.x;
  let lane = inst.uv.y;
  let morph = glyph_morph();
  var pos: vec3<f32>;
  var alpha: f32;
  var color: vec3<f32>;

  if (lane < 0.80) {
    let warped = clamp(lane + sin(inst.uv.x * 3.2 + t * 0.16 + inst.rand * 4.0) * 0.06, 0.0, 0.80);
    let band_coord = warped / 0.80 * 5.65 + sin(inst.uv.x * 5.0 + lane * 4.0 + t * 0.22) * 0.42;
    let band = floor(band_coord);
    let local = fract(band_coord + hash11(band * 9.13 + inst.rand * 2.4) * 0.18);
    let band_n = clamp((band + 0.5) / 5.65, 0.0, 1.0);
    let seed = hash11(band * 19.17 + inst.rand * 31.0);
    let flow = fract(inst.uv.x + t * (0.008 + band_n * 0.009 + seed * 0.005) + seed * 0.53);
    let arc = (flow - 0.5) * PI * (1.35 + band_n * 0.72 + seed * 0.24);
    let arm = sin(arc + band_n * 2.2 + seed * 5.3);
    let radius = 2.1 + band_n * 2.6 + seed * 1.3 + local * 0.65;
    let x = cos(arc * 0.72 + band_n * 0.92 + seed * 1.3) * radius + (flow - 0.5) * (3.1 + band_n * 2.1);
    let phase = flow * TAU * (0.55 + band_n * 0.24 + seed * 0.10) + t * (0.18 + band_n * 0.12) + seed * 5.7;
    let broad = sin(phase) * 0.22;
    let y_base = (band_n - 0.5) * 3.1 + arm * (0.52 + band_n * 0.36) + (seed - 0.5) * 0.42;
    let rd = (local - (0.43 + (seed - 0.5) * 0.18)) / (0.25 + seed * 0.04);
    let ridge = exp(-(rd * rd));
    let mask = smoothstep(0.01, 0.12, lane) * (1.0 - smoothstep(0.72, 0.81, lane));
    let z_layer = (mix(-5.2, 3.2, band_n) + (seed - 0.5) * 1.3) * max(0.35, depth);
    pos = vec3<f32>(
      x + sin(t * 0.24 + seed * 8.0) * 0.18,
      y_base + broad + (local - 0.5) * (0.14 + ridge * 0.04),
      z_layer + broad * 0.35,
    );
    let aurora = mix(vec3<f32>(0.24, 0.68, 0.96), vec3<f32>(0.46, 0.32, 0.95), band_n);
    alpha = (0.12 + ridge * 0.52) * mask * g.p0.z * (0.85 + morph * 0.35);
    color = mix(inst.color, aurora, 0.58 + ridge * 0.22) * (0.65 + ridge * 0.65 + morph * 0.25);
  } else {
    let q = (lane - 0.80) / 0.20;
    let seed = hash11(inst.rand * 917.0 + floor(q * 130.0));
    let drift = fract(inst.uv.x + t * (0.004 + seed * 0.012) + seed * 0.63);
    let x = (drift - 0.5) * (10.5 + seed * 4.8);
    let y = (hash11(inst.rand * 331.0 + seed * 5.0) - 0.5) * 5.4 + sin(t * (0.22 + seed * 0.32) + seed * 7.0) * 0.22;
    let z = (mix(-7.2, 3.8, seed) + sin(t * 0.28 + inst.rand * 8.0) * 0.25) * max(0.35, depth);
    let tw = 0.5 + 0.5 * sin(t * (0.8 + seed * 1.1) + inst.rand * 17.0);
    let twinkle = tw * tw * tw * tw;
    let dust = smoothstep(0.22, 0.98, hash11(inst.rand * 661.0 + floor(q * 160.0)));
    pos = vec3<f32>(x, y, z);
    alpha = dust * (0.10 + twinkle * 0.38) * g.p0.z;
    color = mix(inst.color, vec3<f32>(0.82, 0.93, 1.0), 0.58 + twinkle * 0.18) * (0.65 + twinkle * 0.55);
  }

  let dnc = dance_at(pos.xy, inst.rand, morph * 0.65, g.p0.w, t, g.glyph_bounds.xy, g.p1.xy);
  pos = vec3<f32>(pos.xy + dnc.xy * (1.0 + morph * 0.2), pos.z + dnc.z * max(0.4, depth));

  var out = sprite(pos, vi, layer.params.w * layer.params.x * 18.0, 20.0);
  out.color = color;
  out.alpha = alpha;
  return out;
}

@fragment
fn fs_pulse(in: VsOut) -> @location(0) vec4<f32> {
  let r = length(in.coord - 0.5);
  if (r > 0.5) { discard; }
  let soft = layer.params.y;
  let edge = 1.0 - smoothstep(mix(0.18, 0.02, soft), 0.5, r);
  let a = mix(edge, edge * edge, soft) * in.alpha * layer.params.z;
  return vec4<f32>(clamp(in.color, vec3<f32>(0.0), vec3<f32>(1.0)), clamp(a, 0.0, 1.0));
}

// ───────────────────────────── GLYPH ─────────────────────────────

struct GlyphIn {
  @location(0) home_pos: vec3<f32>,
  @location(1) target_pos: vec3<f32>,
  @location(2) home_color: vec3<f32>,
  @location(3) seed: f32,
};

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

// Terse 9-mode glyph displacement: u=1 scattered, u=0 landed on the stroke.
fn glyph_disp(mode: f32, u: f32, rel: vec2<f32>, rnd: f32, swirl: f32, drift: vec2<f32>) -> vec3<f32> {
  let a = rnd * TAU;
  if (mode < 0.5) {        // BURST 四方
    return vec3<f32>(vec2<f32>(cos(a), sin(a)) * (0.55 + rnd * 1.35) * u, u * (rnd - 0.5) * 1.6);
  } else if (mode < 1.5) { // ABOVE 星陨
    return vec3<f32>(vec2<f32>(sin(rnd * 31.0) * 0.34, 1.05 + rnd * 2.10) * u, u * (rnd - 0.5) * 0.7);
  } else if (mode < 2.5) { // VORTEX 星涡
    let ang = u * swirl * (0.55 + rnd * 0.90);
    return vec3<f32>(rot2(rel, ang) * (1.0 + u * 1.15) - rel, u * (rnd - 0.5) * 1.2);
  } else if (mode < 3.5) { // SIDE 打字机
    return vec3<f32>(-2.90 * u, sin(rnd * 17.0) * 0.22 * u, u * (rnd - 0.5) * 0.5);
  } else if (mode < 4.5) { // DIFFUSE 水墨
    return vec3<f32>(vec2<f32>(cos(a), sin(a)) * (0.06 + rnd * 0.30) * u * u, u * (rnd - 0.5) * 0.35);
  } else if (mode < 5.5) { // RING 星环
    let ang = a + u * swirl;
    return vec3<f32>(vec2<f32>(cos(ang), sin(ang)) * (2.35 * u), sin(ang * 3.0) * u * 0.80);
  } else if (mode < 6.5) { // SHATTER 花火
    let dir = rel / max(length(rel), 0.001);
    return vec3<f32>(dir * (u * (1.15 + rnd * 2.30)) + vec2<f32>(cos(a), sin(a)) * u * 0.45, u * (rnd - 0.5) * 2.6);
  } else if (mode < 7.5) { // DRIFT 极光
    return vec3<f32>(drift * (u * 3.20) + vec2<f32>(0.0, sin(rnd * 23.0) * 0.30 * u), u * (rnd - 0.5) * 0.6);
  }
  // BELOW 静水
  return vec3<f32>(vec2<f32>(sin(rnd * 19.0) * 0.28, -(0.95 + rnd * 1.75)) * u, u * (rnd - 0.5) * 0.6);
}

@vertex
fn vs_glyph(@builtin(vertex_index) vi: u32, inst: GlyphIn) -> VsOut {
  let t = g.viewport.w;
  let age = g.p0.y;
  let depth = g.p0.x;
  let in_mode = g.p1.z;
  let out_mode = g.p1.w;
  let swirl_amt = g.p2.x;
  let disp_fade = g.p2.y;
  let drift = g.p2.zw;

  let delay = inst.seed * STAGGER;
  let arrival = smoothstep(0.0, ASSEMBLE, age - delay);
  let departure = smoothstep(0.0, DISPERSE, age - RELEASE - delay);
  let rnd = hash11(inst.seed * 97.3 + inst.target_pos.x * 13.7 + inst.target_pos.y * 29.1);
  let rel = inst.target_pos.xy - g.glyph_bounds.xy;

  let home = silk_motion(inst.home_pos, t, depth);
  let in_scatter = inst.target_pos + glyph_disp(in_mode, 1.0 - arrival, rel, rnd, swirl_amt, drift);
  let origin = mix(home, in_scatter, 0.62);
  var p = mix(origin, inst.target_pos, arrival);
  let sw = curl_noise(p * 0.85 + vec3<f32>(t * 0.32));
  p = p + sw * (sin(arrival * PI) * 0.55 * (1.0 - disp_fade * 0.7) + arrival * 0.03);

  let outgoing = curl_noise(inst.target_pos * 1.1 + inst.home_pos * 0.45 + vec3<f32>(inst.seed * TAU + t * 0.4));
  let out_scatter = glyph_disp(out_mode, departure, rel, rnd, swirl_amt, drift) + outgoing * (0.35 * departure);
  p = mix(p, inst.target_pos + out_scatter, departure);

  let scatter = max(1.0 - arrival, departure);
  let fade = 1.0 - scatter * disp_fade * 0.75;
  let twinkle = 0.75 + 0.25 * sin(t * 2.8 + rnd * 21.0);
  let alpha = smoothstep(0.0, 0.16, arrival) * (1.0 - smoothstep(0.05, 1.0, departure)) * fade * twinkle;

  let sweep_p = clamp((age - LANDING) / HOLD, 0.0, 1.0);
  let sweep_x = mix(g.glyph_bounds.x - g.glyph_bounds.z - 0.5, g.glyph_bounds.x + g.glyph_bounds.z + 0.5, sweep_p);
  let gate = smoothstep(LANDING, LANDING + 0.2, age) * (1.0 - smoothstep(RELEASE - 0.2, RELEASE, age));
  let sd = inst.target_pos.x - sweep_x; // no pow(): negative bases are NaN on some drivers
  let sweep = exp(-(sd * sd) / 0.18) * gate;
  let morph = arrival * (1.0 - departure);

  var out = sprite(p, vi, layer.params.w * layer.params.x * mix(1.0, 1.3, morph) * 16.0, 22.0 * max(1.0, layer.params.x * 0.5));
  out.color = mix(inst.home_color, g.glow.xyz, arrival) + vec3<f32>(0.25, 0.32, 0.35) * sweep;
  out.alpha = alpha;
  return out;
}

@fragment
fn fs_glyph(in: VsOut) -> @location(0) vec4<f32> {
  let r = length(in.coord - 0.5);
  if (r > 0.5) { discard; }
  let soft = layer.params.y;
  let core = 1.0 - smoothstep(0.08, 0.3, r);
  let halo = (1.0 - smoothstep(0.04, 0.5, r)) * mix(0.3, 0.65, soft);
  let shape = mix(core * 0.7 + halo, halo * halo * 1.4, soft);
  return vec4<f32>(clamp(in.color, vec3<f32>(0.0), vec3<f32>(1.0)), clamp(in.alpha * shape * layer.params.z, 0.0, 1.0));
}

// Per-pixel birth times survive streaming updates; only new ink assembles.
@vertex
fn vs_markdown(@builtin(vertex_index) vi: u32, @location(0) position: vec3<f32>, @location(1) color: vec3<f32>, @location(2) life: vec2<f32>, @location(3) origin: vec3<f32>, @location(4) moved_at: f32, @location(5) appearance: vec2<f32>) -> VsOut {
  let t = g.viewport.w;
  let seed = appearance.x;
  let age = max(0.0, t - life.x);
  let arrival = smoothstep(0.0, g.panel.z, max(0.0, age - seed * 0.18));
  var departure = 0.0;
  if (life.y >= 0.0) { departure = clamp((t - life.y) / g.panel.w, 0.0, 1.0); }
  let destination = mix(origin, position, smoothstep(0.0, g.panel_motion.x, t - moved_at));
  let flow = curl_noise(destination * 1.2 + vec3<f32>(seed * TAU + t * 0.45));
  let home = destination + vec3<f32>((seed - 0.5) * 1.4, -0.5 - seed * 0.5, -1.4);
  var p = mix(home, destination, arrival);
  p += flow * sin(arrival * PI) * 0.8;
  p += vec3<f32>(flow.x * 1.2, 0.8 + abs(flow.y), flow.z * 0.8) * departure;
  // Gentle motion and travelling highlight keep settled ink alive without blurring it.
  p.z += sin(t * 1.2 + destination.x * 0.8 + destination.y * 0.6) * 0.025 * arrival;
  let sweepX = -6.0 + fract(t * 0.16) * 12.0;
  let sweep_distance = destination.x - sweepX;
  let sweep = exp(-sweep_distance * sweep_distance / 0.22) * arrival * (1.0 - departure);
  var out: VsOut;
  let c = corner(vi);
  let size = mix(1.7, 1.0, arrival) + departure * 0.6;
  // World-sized billboard: the center orbits with the scene; the dot faces the camera.
  // Scale all local displacements around the text plane, not around world Z=0.
  let scale = g.panel_motion.y;
  let anchor = vec3<f32>(0.0, 0.0, g.panel_motion.z);
  let center = anchor + (p - anchor) * scale;
  let right = vec3<f32>(g.view[0][0], g.view[1][0], g.view[2][0]);
  let up = vec3<f32>(g.view[0][1], g.view[1][1], g.view[2][1]);
  let radius = g.panel.y * layer.params.w * layer.params.x * size * scale;
  let center_clip = g.view_proj * vec4<f32>(center, 1.0);
  let projected_right = g.view_proj * vec4<f32>(right * radius, 0.0);
  let radius_px = length(projected_right.xy * g.viewport.xy * 0.5) / max(0.1, center_clip.w);
  let filtered_px = max(radius_px, g.panel_motion.w);
  let footprint_scale = filtered_px / radius_px;
  let area_ratio = radius_px / filtered_px;
  let detail = smoothstep(g.panel_motion.w * 0.5, g.panel_motion.w, radius_px);
  out.clip = g.view_proj * vec4<f32>(center + (right * c.x + up * c.y) * radius * footprint_scale, 1.0);
  out.coord = c * 0.5 + 0.5;
  out.detail = detail;
  out.color = color * (0.88 + 0.12 * sin(t * 1.7 + seed * TAU) * detail) + vec3<f32>(0.15, 0.22, 0.3) * sweep * detail;
  out.alpha = area_ratio * area_ratio * appearance.y * g.panel.x * smoothstep(0.0, 0.12, age) * (1.0 - smoothstep(0.2, 1.0, departure));
  return out;
}
@fragment
fn fs_markdown(in: VsOut) -> @location(0) vec4<f32> {
  let radius = length(in.coord * 2.0 - 1.0);
  let edge_width = max(0.175, fwidth(radius) * 0.5);
  let core = 1.0 - smoothstep(0.825 - edge_width, 1.0, radius);
  let halo = 1.0 - smoothstep(0.0, 1.0, radius);
  let round_shape = mix(core, halo * halo, layer.params.y);
  // Separable tent filter: integer pixel-radius support keeps integrated coverage
  // stable as subpixel centers move. Coefficients match the round kernels' area.
  let q = abs(in.coord * 2.0 - 1.0);
  let filtered = max(0.0, 1.0 - q.x) * max(0.0, 1.0 - q.y) * mix(2.15, 0.58, layer.params.y);
  let shape = mix(filtered, round_shape, in.detail);
  let alpha = clamp(in.alpha * shape * layer.params.z, 0.0, 1.0);
  return vec4<f32>(clamp(in.color, vec3<f32>(0.0), vec3<f32>(1.0)) * alpha, alpha);
}
