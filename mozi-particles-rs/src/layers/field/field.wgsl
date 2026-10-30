// Background layer: SILK relief field + PULSE aurora. Reacts to text only via the focus uniform.

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

  let morph = focus_morph();
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
  let morph = focus_morph();
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
