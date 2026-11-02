// Short-message text layer: Terse 9-move assembly/dispersal.

// ───────────────────────────── GLYPH ─────────────────────────────
// 【优化 2 & 优化 3：Compute 预计算 9 种聚散编舞与 Curl 噪声 + 单 Pass 合并核心与光晕】
// 设计思想与数学逻辑：
// 1. Compute 预计算（cs_glyph）：
//    中央大字（Glyph）包含高开销的 silk_motion、两次 3D curl_noise（每次含 6 次噪声采样）以及 9 种聚散编舞（glyph_disp）。
//    原方案每颗粒子每帧在 2 个 Pass × 6 个顶点中被重复计算 12 次。
//    现在提取到 cs_glyph 中每帧仅算 1 次，并将聚拢放大系数 mix(1.0, 1.3, morph) 存入 ResolvedSprite.metrics.y。
// 2. 光晕与核心单 Pass 合并（vs_glyph + fs_glyph）：
//    原方案中 Glyph 的光晕（Pass 5）与核心（Pass 6）均使用纯加法混合（BLEND_ADD），且两者之间没有任何其他图层介入。
//    根据加法交换律与结合律：∑ Halo_i + ∑ Core_i ≡ ∑(Halo_i + Core_i)。
//    注意：当 r = 0 时，a_halo + a_core 约为 0.17745 + 0.95 = 1.12745 > 1.0。
//    为避免片元着色器输出 Alpha 被 Unorm 帧缓冲截断在 1.0 导致 RGB 亮度损失，我们使用 BLEND_PREMULTIPLIED_ADD（One + One），
//    在 Shader 内部以 32 位浮点数直接算出 c * (a_halo + a_core)，与原两遍 BLEND_ADD 累加后的硬件截断结果 100% 严格一致。

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

fn eval_glyph(home_pos: vec3<f32>, target_pos: vec3<f32>, home_color: vec3<f32>, seed: f32) -> ResolvedSprite {
  let t = g.viewport.w;
  let age = g.p0.y;
  let depth = g.p0.x;
  let in_mode = g.p1.z;
  let out_mode = g.p1.w;
  let swirl_amt = g.p2.x;
  let disp_fade = g.p2.y;
  let drift = g.p2.zw;

  let delay = seed * STAGGER;
  let arrival = smoothstep(0.0, ASSEMBLE, age - delay);
  let departure = smoothstep(0.0, DISPERSE, age - RELEASE - delay);
  let rnd = hash11(seed * 97.3 + target_pos.x * 13.7 + target_pos.y * 29.1);
  let rel = target_pos.xy - g.glyph_bounds.xy;

  let home = silk_motion(home_pos, t, depth);
  let in_scatter = target_pos + glyph_disp(in_mode, 1.0 - arrival, rel, rnd, swirl_amt, drift);
  let origin = mix(home, in_scatter, 0.62);
  var p = mix(origin, target_pos, arrival);
  let sw = curl_noise(p * 0.85 + vec3<f32>(t * 0.32));
  p = p + sw * (sin(arrival * PI) * 0.55 * (1.0 - disp_fade * 0.7) + arrival * 0.03);

  let outgoing = curl_noise(target_pos * 1.1 + home_pos * 0.45 + vec3<f32>(seed * TAU + t * 0.4));
  let out_scatter = glyph_disp(out_mode, departure, rel, rnd, swirl_amt, drift) + outgoing * (0.35 * departure);
  p = mix(p, target_pos + out_scatter, departure);

  let scatter = max(1.0 - arrival, departure);
  let fade = 1.0 - scatter * disp_fade * 0.75;
  let twinkle = 0.75 + 0.25 * sin(t * 2.8 + rnd * 21.0);
  let alpha = smoothstep(0.0, 0.16, arrival) * (1.0 - smoothstep(0.05, 1.0, departure)) * fade * twinkle;

  let sweep_p = clamp((age - LANDING) / HOLD, 0.0, 1.0);
  let sweep_x = mix(g.glyph_bounds.x - g.glyph_bounds.z - 0.5, g.glyph_bounds.x + g.glyph_bounds.z + 0.5, sweep_p);
  let gate = smoothstep(LANDING, LANDING + 0.2, age) * (1.0 - smoothstep(RELEASE - 0.2, RELEASE, age));
  let sd = target_pos.x - sweep_x; // no pow(): negative bases are NaN on some drivers
  let sweep = exp(-(sd * sd) / 0.18) * gate;
  let morph = arrival * (1.0 - departure);

  let color = mix(home_color, g.glow.xyz, arrival) + vec3<f32>(0.25, 0.32, 0.35) * sweep;
  return resolve_sprite(p, color, alpha, mix(1.0, 1.3, morph));
}

// Compute Pre-Pass 入口：每个线程处理 1 颗 GLYPH 大字粒子（stride = 10 个 f32：home.xyz + target.xyz + color.xyz + seed）
@compute @workgroup_size(64)
fn cs_glyph(@builtin(global_invocation_id) gid: vec3<u32>) {
  let ii = gid.x;
  let b = ii * 10u;
  if (b + 9u >= arrayLength(&raw_in)) { return; }
  let home_pos = vec3<f32>(raw_in[b], raw_in[b + 1u], raw_in[b + 2u]);
  let target_pos = vec3<f32>(raw_in[b + 3u], raw_in[b + 4u], raw_in[b + 5u]);
  let home_color = vec3<f32>(raw_in[b + 6u], raw_in[b + 7u], raw_in[b + 8u]);
  let seed = raw_in[b + 9u];
  out_sprites[ii] = eval_glyph(home_pos, target_pos, home_color, seed);
}

// 单 Pass 合并后的大字顶点着色器：
// layer.params 布局为 [bloom_scale, GLYPH_CORE_ALPHA, GLYPH_HALO_ALPHA, GLYPH_PARTICLE_SIZE]
@vertex
fn vs_glyph(@builtin(vertex_index) vi: u32, s: ResolvedSprite) -> VsOut {
  let morph_scale = s.metrics.y;
  let base_scale = layer.params.w * morph_scale * 16.0;
  let dist = max(0.5, -s.metrics.x);
  let max_px_halo = 22.0 * max(1.0, layer.params.x * 0.5);
  let px_halo = clamp(base_scale * layer.params.x / dist, 1.0, max_px_halo);
  let px_core = clamp(base_scale / dist, 1.0, 22.0);
  var out = expand_resolved(s, vi, base_scale * layer.params.x, max_px_halo);
  // 传递外圈光晕像素直径与内圈核心像素直径的精确比值（含各自的 max_px 截断）
  out.detail = px_halo / px_core;
  return out;
}

@fragment
fn fs_glyph(in: VsOut) -> @location(0) vec4<f32> {
  let r_halo = length(in.coord - 0.5);
  if (r_halo > 0.5) { discard; }

  // 1. 外圈光晕贡献（对应原 Pass 5：soft = 1.0, alpha 权重 = layer.params.z 即 GLYPH_HALO_ALPHA）
  let halo_outer = (1.0 - smoothstep(0.04, 0.5, r_halo)) * 0.65;
  let shape_halo = halo_outer * halo_outer * 1.4;
  let a_halo = clamp(in.alpha * shape_halo * layer.params.z, 0.0, 1.0);

  // 2. 内圈核心贡献（对应原 Pass 6：soft = 0.0, alpha 权重 = layer.params.y 即 GLYPH_CORE_ALPHA）
  let r_core = r_halo * in.detail;
  var a_core = 0.0;
  if (r_core <= 0.5) {
    let core_inner = 1.0 - smoothstep(0.08, 0.3, r_core);
    let halo_inner = (1.0 - smoothstep(0.04, 0.5, r_core)) * 0.3;
    let shape_core = core_inner * 0.7 + halo_inner;
    a_core = clamp(in.alpha * shape_core * layer.params.y, 0.0, 1.0);
  }

  // 3. 预乘加法输出（配合 BLEND_PREMULTIPLIED_ADD：src * 1 + dst * 1）
  let c = clamp(in.color, vec3<f32>(0.0), vec3<f32>(1.0));
  let a_total = a_halo + a_core;
  return vec4<f32>(c * a_total, a_total);
}
