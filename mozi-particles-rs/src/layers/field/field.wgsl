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
// 【优化 3：Compute 预计算每颗背景粒子的运动轨迹】
// 设计思想：
// 原方案中，同一颗背景粒子在画光晕（Pass 3）和画核心（Pass 4）时，每个 Pass 的 6 个顶点都会重复执行一遍
// silk_motion（三角函数波浪）、水波纹（ripple）、鼠标悬停（hover）以及中央凹陷伴舞（dance_at），
// 导致每颗粒子每帧被重复计算 12 次。
// 优化后，由 Compute Shader（cs_field）在每帧开头对每颗粒子仅计算 1 次 3D 运动、颜色调制与透视投影，
// 将结果写入 ResolvedSprite 缓冲区；随后光晕与核心两遍 Render Pass 的顶点着色器（vs_field）直接读取该缓冲区，
// 仅做轻量级的 4 顶点屏幕空间四角展开，画面像素与原方案 100% 严格等价。

fn eval_field(inst_pos: vec3<f32>, inst_color: vec3<f32>) -> ResolvedSprite {
  let t = g.viewport.w;
  let depth = g.p0.x;
  var p = silk_motion(inst_pos, t, depth);

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
  let box = max(abs(inst_pos.xy - g.glyph_bounds.xy) - g.glyph_bounds.zw, vec2<f32>(0.0)) / vec2<f32>(0.85, 0.55);
  let well = exp(-dot(box, box) * 1.8) * morph;
  let sparkle = fract(sin(dot(inst_pos.xy, vec2<f32>(127.1, 311.7))) * 43758.5453);
  let dnc = dance_at(p.xy, sparkle, morph * 0.42, g.p0.w, t, g.glyph_bounds.xy, g.p1.xy);

  p = vec3<f32>(p.xy + dnc.xy + offset / max(dp, 0.001) * hover * 0.07, p.z + dnc.z * depth - well * 0.45);
  p.z = p.z + wave * g.glow.w + hover * 0.24;

  let s = 0.5 + 0.5 * sin(t * 1.3 + sparkle * 71.0);
  let s2 = s * s;
  let shimmer = smoothstep(0.96, 1.0, sparkle) * s2 * s2 * s2 * 0.15;

  let color = inst_color * (1.0 + abs(wave) * 0.85 + hover * 0.25 + shimmer) * (1.0 - well * 0.4);
  return resolve_sprite(p, color, 1.0, 1.0);
}

// Compute Pre-Pass 入口：每个线程处理 1 颗 SILK 背景粒子（stride = 6 个 f32：pos.xyz + color.xyz）
@compute @workgroup_size(64)
fn cs_field(@builtin(global_invocation_id) gid: vec3<u32>) {
  let ii = gid.x;
  let b = ii * 6u;
  if (b + 5u >= arrayLength(&raw_in)) { return; }
  let pos = vec3<f32>(raw_in[b], raw_in[b + 1u], raw_in[b + 2u]);
  let col = vec3<f32>(raw_in[b + 3u], raw_in[b + 4u], raw_in[b + 5u]);
  out_sprites[ii] = eval_field(pos, col);
}

// Render Pass 顶点入口：直接读取 Compute 预计算好的 ResolvedSprite，按当前 Pass（光晕或核心）的参数展开 4 个角点
@vertex
fn vs_field(@builtin(vertex_index) vi: u32, s: ResolvedSprite) -> VsOut {
  return expand_resolved(s, vi, layer.params.w * layer.params.x * 15.0, 18.0 * max(1.0, layer.params.x * 0.6));
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
// 【优化 2 & 优化 3：Compute 预计算极光运动 + 单 Pass 合并核心与光晕（加法交换律与结合律）】
// 设计思想与数学逻辑：
// 1. Compute 预计算（cs_pulse）：将极光旋臂（aurora）与星尘（star dust）的复杂三角函数轨迹提取到 Compute 阶段，
//    每颗极光粒子每帧仅计算 1 次。
// 2. 光晕与核心单 Pass 合并（vs_pulse + fs_pulse）：
//    原方案中 Pulse 的光晕（Pass 1）与核心（Pass 2）均使用纯加法混合（BLEND_ADD，即 dst + src * a）。
//    根据向量加法的交换律与结合律：
//      ∑(c_i * a_halo_i) + ∑(c_i * a_core_i) ≡ ∑(c_i * (a_halo_i + a_core_i))
//    因此，我们在单次绘制中直接按外圈光晕尺寸（px_halo）展开 4 顶点四边形，并通过 out.detail 传入精确的
//    外圈/内圈像素半径比（px_halo / px_core，已严格包含两端 clamp(px, 1.0, 20.0) 的截断效应）。
//    片元着色器同时算出光晕透明度 a_halo 与核心透明度 a_core，配合 BLEND_PREMULTIPLIED_ADD（One + One）
//    一次性输出 vec4(c * (a_halo + a_core), a_halo + a_core)，省去整整 1 个全屏 Pass 和 50% 的光栅化开销，
//    且最终帧缓冲区的每一个像素值与原两遍绘制 100% 相等。

fn eval_pulse(uv: vec2<f32>, rand: f32, inst_color: vec3<f32>) -> ResolvedSprite {
  let t = g.viewport.w;
  let depth = g.p0.x;
  let lane = uv.y;
  let morph = focus_morph();
  var pos: vec3<f32>;
  var alpha: f32;
  var color: vec3<f32>;

  if (lane < 0.80) {
    let warped = clamp(lane + sin(uv.x * 3.2 + t * 0.16 + rand * 4.0) * 0.06, 0.0, 0.80);
    let band_coord = warped / 0.80 * 5.65 + sin(uv.x * 5.0 + lane * 4.0 + t * 0.22) * 0.42;
    let band = floor(band_coord);
    let local = fract(band_coord + hash11(band * 9.13 + rand * 2.4) * 0.18);
    let band_n = clamp((band + 0.5) / 5.65, 0.0, 1.0);
    let seed = hash11(band * 19.17 + rand * 31.0);
    let flow = fract(uv.x + t * (0.008 + band_n * 0.009 + seed * 0.005) + seed * 0.53);
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
    color = mix(inst_color, aurora, 0.58 + ridge * 0.22) * (0.65 + ridge * 0.65 + morph * 0.25);
  } else {
    let q = (lane - 0.80) / 0.20;
    let seed = hash11(rand * 917.0 + floor(q * 130.0));
    let drift = fract(uv.x + t * (0.004 + seed * 0.012) + seed * 0.63);
    let x = (drift - 0.5) * (10.5 + seed * 4.8);
    let y = (hash11(rand * 331.0 + seed * 5.0) - 0.5) * 5.4 + sin(t * (0.22 + seed * 0.32) + seed * 7.0) * 0.22;
    let z = (mix(-7.2, 3.8, seed) + sin(t * 0.28 + rand * 8.0) * 0.25) * max(0.35, depth);
    let tw = 0.5 + 0.5 * sin(t * (0.8 + seed * 1.1) + rand * 17.0);
    let twinkle = tw * tw * tw * tw;
    let dust = smoothstep(0.22, 0.98, hash11(rand * 661.0 + floor(q * 160.0)));
    pos = vec3<f32>(x, y, z);
    alpha = dust * (0.10 + twinkle * 0.38) * g.p0.z;
    color = mix(inst_color, vec3<f32>(0.82, 0.93, 1.0), 0.58 + twinkle * 0.18) * (0.65 + twinkle * 0.55);
  }

  let dnc = dance_at(pos.xy, rand, morph * 0.65, g.p0.w, t, g.glyph_bounds.xy, g.p1.xy);
  pos = vec3<f32>(pos.xy + dnc.xy * (1.0 + morph * 0.2), pos.z + dnc.z * max(0.4, depth));

  return resolve_sprite(pos, color, alpha, 1.0);
}

// Compute Pre-Pass 入口：每个线程处理 1 颗 PULSE 极光/星尘粒子（stride = 6 个 f32：uv.xy + rand + color.xyz）
@compute @workgroup_size(64)
fn cs_pulse(@builtin(global_invocation_id) gid: vec3<u32>) {
  let ii = gid.x;
  let b = ii * 6u;
  if (b + 5u >= arrayLength(&raw_in)) { return; }
  let uv = vec2<f32>(raw_in[b], raw_in[b + 1u]);
  let rand = raw_in[b + 2u];
  let col = vec3<f32>(raw_in[b + 3u], raw_in[b + 4u], raw_in[b + 5u]);
  out_sprites[ii] = eval_pulse(uv, rand, col);
}

// 单 Pass 合并后的极光顶点着色器：
// layer.params 布局为 [PULSE_HALO_SCALE, PULSE_CORE_ALPHA, PULSE_HALO_ALPHA, PULSE_PARTICLE_SIZE]
@vertex
fn vs_pulse(@builtin(vertex_index) vi: u32, s: ResolvedSprite) -> VsOut {
  let base_scale = layer.params.w * 18.0;
  let dist = max(0.5, -s.metrics.x);
  let px_halo = clamp(base_scale * layer.params.x / dist, 1.0, 20.0);
  let px_core = clamp(base_scale / dist, 1.0, 20.0);
  var out = expand_resolved(s, vi, base_scale * layer.params.x, 20.0);
  // 保存外圈光晕像素直径与内圈核心像素直径的精确比值，供片元着色器将 UV 半径映射到内圈核心坐标系
  out.detail = px_halo / px_core;
  return out;
}

@fragment
fn fs_pulse(in: VsOut) -> @location(0) vec4<f32> {
  let r_halo = length(in.coord - 0.5);
  if (r_halo > 0.5) { discard; }

  // 1. 外圈光晕贡献（对应原 Pass 1：soft = 1.0, alpha 权重 = layer.params.z 即 PULSE_HALO_ALPHA）
  let edge_halo = 1.0 - smoothstep(0.02, 0.5, r_halo);
  let a_halo = clamp(edge_halo * edge_halo * in.alpha * layer.params.z, 0.0, 1.0);

  // 2. 内圈核心贡献（对应原 Pass 2：soft = 0.0, alpha 权重 = layer.params.y 即 PULSE_CORE_ALPHA）
  let r_core = r_halo * in.detail;
  var a_core = 0.0;
  if (r_core <= 0.5) {
    let edge_core = 1.0 - smoothstep(0.18, 0.5, r_core);
    a_core = clamp(edge_core * in.alpha * layer.params.y, 0.0, 1.0);
  }

  // 3. 预乘加法输出（配合 BLEND_PREMULTIPLIED_ADD：src * 1 + dst * 1）
  let c = clamp(in.color, vec3<f32>(0.0), vec3<f32>(1.0));
  let a_total = a_halo + a_core;
  return vec4<f32>(c * a_total, a_total);
}
