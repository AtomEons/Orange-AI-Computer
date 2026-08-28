// THE NOVA — the erupting plasma mind (Reference B's soul). Volumetric fractal
// eruption: white-hot heart → electric cyan → deep blue → violet ash, radial
// tendrils, asymmetric lobe. The operator's citrus survives as the EMBER HEART
// visible inside the plasma. No hard disc edge — light bleeds into the field.

struct Uniforms {
  res:   vec4<f32>,                 // x, y, time, count
  bodies: array<vec4<f32>, 16>,
  tints:  array<vec4<f32>, 16>,
  mood:  vec4<f32>,                 // intensity, ring_speed, ghost, _ (state atlas)
  bias:  vec4<f32>,
  pulse: vec4<f32>,   // shockwave x, y, age; w = portfolio complete-fraction
  cam:   vec4<f32>,   // living camera: offx, offy, zoom, _
};
@group(0) @binding(0) var<uniform> U: Uniforms;

fn hash(p: vec2<f32>) -> f32 {
  return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
}
fn vnoise(p: vec2<f32>) -> f32 {
  let i = floor(p);
  var f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  let a = hash(i);
  let b = hash(i + vec2<f32>(1.0, 0.0));
  let c = hash(i + vec2<f32>(0.0, 1.0));
  let d = hash(i + vec2<f32>(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
fn fbm(p_in: vec2<f32>) -> f32 {
  var p = p_in;
  var s = 0.0;
  var a = 0.5;
  for (var i = 0; i < 5; i++) {
    s += a * vnoise(p);
    p = p * 2.0 + vec2<f32>(1.7, 9.2);
    a *= 0.5;
  }
  return s;
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  var pos = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0),
  );
  return vec4<f32>(pos[vi], 0.0, 1.0);
}

@fragment
fn fs_main(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
  let res = U.res.xy;
  let t = U.res.z;
  let aspect = res.x / res.y;
  // FULL-RES again (2026-07-18): the wedges must cut sharp — fps headroom pays
  let p = fragCoord.xy / res;
  let C = vec2<f32>(0.5 * aspect, 0.46);
  // LIVING CAMERA — same eye as the field, the whole world moves as one
  let uvf0 = vec2<f32>(p.x * aspect, p.y);
  let uvf = C + (uvf0 - C) * U.cam.z + vec2<f32>(U.cam.x * aspect, U.cam.y);
  let R = 0.425;                           // COMMANDING reach — in the references
                                           // the mind is the protagonist, not a
                                           // decoration at the center of a chart
  let uv = (uvf - C) / R;
  let r = length(uv);
  // EARLY-OUT (perf): with R grown to 0.425 an r-limit of 2.6 ran the full
  // 5-octave plasma fbm across nearly the whole frame — RENDER fell 75→36.
  // 1.85 still covers the corona's useful reach; area cost drops ~2×.
  if (r > 1.85) { return vec4<f32>(0.0); }

  let ang = atan2(uv.y, uv.x);
  let breathe = 0.92 + 0.08 * sin(t * 0.45);
  let boost = clamp(U.mood.x, 0.6, 2.2);

  var col = vec3<f32>(0.0);
  var alpha = 0.0;

  // ── THE PLASMA ERUPTION — fractal radial tendrils, asymmetric lobe ──────
  // counter-rotating shells: the outer plasma turns one way, the fine inner
  // filaments the other — the eye reads VOLUME, not a flat sticker
  let swirl = fbm(vec2<f32>(ang * 1.3 + 3.0, t * 0.045)) * 2.2;
  let tendril = fbm(vec2<f32>((ang + t * 0.022) * 3.2 + swirl, r * 3.6 - t * 0.10));
  let fine = fbm(vec2<f32>((ang - t * 0.016) * 7.0 - swirl * 0.6, r * 7.5 - t * 0.16));
  // asymmetry: a brighter lobe toward upper-left (matches the field's pocket)
  let lobe = 1.0 + 0.55 * cos(ang - 2.35);
  // higher exponent = the plasma resolves into STRUCTURE instead of haze:
  // bright filaments against true dark, which is what reads as power
  var plasma = pow(clamp(tendril * 0.78 + fine * 0.46, 0.0, 1.25), 2.35)
             * exp(-r * 1.42) * lobe * breathe * boost;
  // THE DARK MOAT — a ring of quiet just outside the heart: contrast is what
  // makes the jewel burn (the washed center was the composition's weak zone)
  plasma *= 0.38 + 0.62 * smoothstep(0.16, 0.46, r);
  // the hot heart — tight, so the citrus survives inside it; the jewel's own
  // local exposure lift so it READS at a glance (finish law: light quality)
  // the SOURCE must out-burn the cables it feeds: a broad hot body plus a
  // tight incandescent seed — the mind is the protagonist of the frame
  plasma += exp(-r * r * 9.5) * 1.12 * breathe * boost;
  plasma += exp(-r * r * 40.0) * 0.72 * breathe * boost;

  // plasma color: white heart → electric cyan → deep blue, violet-ash floor
  var pc = mix(vec3<f32>(0.30, 0.42, 1.0), vec3<f32>(0.32, 0.80, 1.0), clamp(plasma * 0.9, 0.0, 1.0));
  pc = mix(pc, vec3<f32>(0.92, 0.99, 1.0), smoothstep(1.05, 1.9, plasma));
  pc = mix(vec3<f32>(0.30, 0.18, 0.55), pc, clamp(plasma * 1.6, 0.0, 1.0));
  col += pc * plasma;
  alpha = max(alpha, clamp(plasma * 0.9, 0.0, 1.0));

  // ── PROMINENCE ERUPTIONS — every ~14s the mind THROWS an arc of itself.
  // Cycle-hashed bearing; a white-hot head rides a luminous column outward.
  // web.wgsl launches spark riders and field.wgsl heats the gas on the SAME
  // cycle + bearing — one coordinated event across all three organs.
  let cyc = floor(t / 14.0);
  let phE = fract(t / 14.0);
  // THE PHRASE: eruptions belong to the CRESCENDO movement of the 56s bar
  let ph56 = fract(t / 56.0);
  let m3 = smoothstep(0.46, 0.54, ph56) * (1.0 - smoothstep(0.72, 0.82, ph56));
  let act = smoothstep(0.0, 0.06, phE) * (1.0 - smoothstep(0.42, 0.55, phE)) * m3;
  if (act > 0.001) {
    let dirE = hash(vec2<f32>(cyc, 7.7)) * 6.2831853;
    var dd = ang - dirE;
    dd = atan2(sin(dd), cos(dd));
    let front = 0.25 + (phE / 0.55) * 2.05;          // the rising eruption front
    let head = exp(-dd * dd * 26.0) * exp(-abs(r - front) * 4.0);
    let column = exp(-dd * dd * 34.0)
               * (1.0 - smoothstep(front * 0.85, front, r))
               * smoothstep(0.32, 0.55, r) * (1.0 - r * 0.28) * 0.6;
    let er = (head * 1.45 + max(column, 0.0)) * act * boost;
    col += mix(vec3<f32>(0.30, 0.68, 1.0), vec3<f32>(0.95, 0.99, 1.0),
               clamp(head * 1.4, 0.0, 1.0)) * er;
    alpha = max(alpha, clamp(er * 0.85, 0.0, 1.0));
  }

  // ── EARNED ERUPTION — a completion doubles as a DIRECTED prominence: the
  // mind throws toward the finished work (bearing derived from the pulse seat,
  // clocked by the shockwave age — zero extra uniforms, pure truth-coupling)
  let bage = U.pulse.z;
  if (bage > 0.0 && bage < 1.0) {
    let aspect2 = U.res.x / U.res.y;
    let bp = vec2<f32>(U.pulse.x * aspect2, U.pulse.y);
    let Cw = vec2<f32>(0.5 * aspect2, 0.46);
    let dirB = atan2(bp.y - Cw.y, bp.x - Cw.x);
    var db2 = ang - dirB;
    db2 = atan2(sin(db2), cos(db2));
    let act2 = smoothstep(0.0, 0.10, bage) * (1.0 - smoothstep(0.60, 1.0, bage));
    let front2 = 0.25 + bage * 2.2;
    let head2 = exp(-db2 * db2 * 30.0) * exp(-abs(r - front2) * 4.2);
    let col2 = exp(-db2 * db2 * 40.0)
             * (1.0 - smoothstep(front2 * 0.85, front2, r))
             * smoothstep(0.32, 0.55, r) * (1.0 - r * 0.28) * 0.55;
    let er2 = (head2 * 1.5 + max(col2, 0.0)) * act2 * boost;
    col += mix(vec3<f32>(0.35, 0.95, 0.60), vec3<f32>(0.95, 1.0, 0.98),
               clamp(head2 * 1.3, 0.0, 1.0)) * er2;   // green-white: the truth color
    alpha = max(alpha, clamp(er2 * 0.85, 0.0, 1.0));
  }

  // ── THE CORONA — presence beyond the body: a soft electric bleed that keeps
  // radiating past the plasma's edge, so the mind owns the space around it
  let corona = exp(-pow(max(r - 0.55, 0.0), 1.35) * 3.2) * (1.0 - smoothstep(0.5, 1.8, r));
  col += vec3<f32>(0.16, 0.34, 0.72) * corona * 0.30 * breathe * boost;
  alpha = max(alpha, clamp(corona * 0.28, 0.0, 1.0));

  // ── STELLAR LIMB — a thin broken ring of fire where the heart meets plasma ──
  let limb = exp(-abs(r - 0.44) * 55.0)
           * (0.30 + 0.70 * fbm(vec2<f32>(ang * 2.5 + t * 0.05, 3.3)));
  col += vec3<f32>(0.55, 0.85, 1.0) * limb * 0.52 * breathe * boost;
  alpha = max(alpha, clamp(limb * 0.40, 0.0, 1.0));

  // ── THE EMBER HEART — the operator's citrus, alive inside the plasma ────
  // the citrus reads at the same screen size as before the body grew (the
  // operator tuned this fruit; growing the plasma must not swallow it)
  let r2v = uv / 0.33;
  let r2 = length(r2v);
  if (r2 < 1.0) {
    let ang2 = atan2(r2v.y, r2v.x);
    let SEG = 9.0;
    let seg = (ang2 / 6.2831853 + 0.5) * SEG + t * 0.006;
    let w = fract(seg);
    let segId = floor(seg);
    let db = min(w, 1.0 - w);
    let wall = smoothstep(0.034, 0.009, db);
    let sacUv = vec2<f32>(w * 4.5 + hash(vec2<f32>(segId, 3.7)) * 7.0, r2 * 16.0);
    let sac = fbm(sacUv) * 1.25 - 0.08;
    let backlight = exp(-r2 * 2.0) * 0.92 + 0.05;
    var flesh = mix(vec3<f32>(0.34, 0.028, 0.002), vec3<f32>(1.0, 0.34, 0.03), clamp(sac * 0.95 - 0.02, 0.0, 1.0));
    flesh = mix(flesh, vec3<f32>(1.0, 0.78, 0.30), smoothstep(0.66, 0.97, sac) * 0.35);
    flesh *= backlight * breathe;
    // the portfolio dial + honest ghost survive on the heart
    let lit = step((segId + 0.5) / SEG, U.pulse.w);
    flesh *= (0.66 + 0.55 * lit);
    let ghosted = step((segId + 0.5) / SEG, U.mood.z) * (1.0 - lit);
    flesh = mix(flesh, vec3<f32>(1.0, 0.72, 0.34) * backlight, ghosted * 0.13);
    flesh = mix(flesh, vec3<f32>(1.0, 0.90, 0.62) * (backlight * 1.25), wall);
    // hex seed
    let ha = abs(fract(ang2 / 1.0471976 + 0.5) - 0.5) * 1.0471976;
    let hexR = 0.085 / max(cos(ha), 0.5);
    let hexEdge = smoothstep(0.016, 0.004, abs(r2 - hexR));
    flesh = mix(flesh, vec3<f32>(1.0, 0.86, 0.45) * (1.15 * breathe), hexEdge * 0.9);
    // 3D dome light
    let z = sqrt(max(0.0, 1.0 - r2 * r2 * 0.55));
    let n = normalize(vec3<f32>(r2v.x * 0.42, r2v.y * 0.42, z));
    let L = normalize(vec3<f32>(-0.55, -0.62, 0.62));
    flesh *= 0.58 + 0.55 * clamp(dot(n, L), 0.0, 1.0);
    // the heart shows THROUGH the plasma: clear at center, veiled at its rim
    let veil = 1.0 - smoothstep(0.45, 1.0, r2);
    let heart_a = veil * (1.0 - clamp(plasma * 0.22, 0.0, 0.30));
    col = mix(col, flesh, heart_a);
    alpha = max(alpha, heart_a);
  }

  // filmic — deep, never clipped
  col = col / (col + vec3<f32>(0.72));
  col = pow(col, vec3<f32>(0.88));
  alpha = clamp(alpha, 0.0, 1.0);
  return vec4<f32>(col * alpha, alpha);   // premultiplied
}
