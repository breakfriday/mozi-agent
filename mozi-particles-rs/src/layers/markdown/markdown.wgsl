// Conversation board layer: world-sized billboards that orbit with the shared camera.

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
