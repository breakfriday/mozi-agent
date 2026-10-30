// Short-message text layer: Terse 9-move assembly/dispersal.

// ───────────────────────────── GLYPH ─────────────────────────────

struct GlyphIn {
  @location(0) home_pos: vec3<f32>,
  @location(1) target_pos: vec3<f32>,
  @location(2) home_color: vec3<f32>,
  @location(3) seed: f32,
};

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
