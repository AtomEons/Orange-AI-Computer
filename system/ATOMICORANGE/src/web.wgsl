// LivingWeb — the thought made visible, at NATIVE power. 45,000 GPU particles
// (9x the webview), each an instanced soft-light quad; ALL trajectory math in
// the vertex shader from instance id + time. Additive blending: light adds like
// light. Two populations: FIELD (log-spiral storm out of the core) and STREAM
// (causal filaments core -> each project mass — the bodies ARE the anchors).

struct Uniforms {
  res:   vec4<f32>,                 // x, y, time, count
  bodies: array<vec4<f32>, 16>,
  tints:  array<vec4<f32>, 16>,
  mood:  vec4<f32>,                 // intensity, ring_speed, _, _ (state atlas)
  bias:  vec4<f32>,
  pulse: vec4<f32>,   // shockwave x, y, age; w = portfolio complete-fraction
  cam:   vec4<f32>,   // living camera: offx, offy, zoom, _
};
@group(0) @binding(0) var<uniform> U: Uniforms;

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) corner: vec2<f32>,   // -1..1 quad-local
  @location(1) color: vec3<f32>,
  @location(2) bright: f32,
};

fn hashf(n: f32) -> f32 {
  return fract(sin(n) * 43758.5453123);
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let res = U.res.xy;
  let t = U.res.z;
  let count = max(1.0, U.res.w);
  let aspect = res.x / res.y;
  let C = vec2<f32>(0.5 * aspect, 0.46);

  let id = f32(ii);
  let h1 = hashf(id * 1.013);
  let h2 = hashf(id * 2.117);
  let h3 = hashf(id * 3.331);
  let h4 = hashf(id * 4.741);
  let layer = floor(h2 * 3.0);

  var P: vec2<f32>;
  var bright: f32;
  var col: vec3<f32>;
  // THE VOLUME — 3D members carry a z (world units) + vol flag; the cloud
  // turns slowly about the vertical axis with true perspective
  var Z: f32 = 0.0;
  var vol: f32 = 0.0;

  if (ii >= 8u && ii < 14u) {
    // SHOOTING STARS — TRUE ARRIVALS: these fire ONLY when something real
    // landed (receipt on the spine, the brain waking, an artifact written, an
    // order taken, work completed). U.bias.w carries the arrival's age 0..1.
    // Light crosses this sky because the world changed, never on a timer.
    let arr = U.bias.w;
    let stagger = h4 * 0.30;
    let phase = (arr - stagger) * 0.72;   // staggered flight through the event
    let ang = h2 * 6.2831853;
    let dirv = vec2<f32>(cos(ang), sin(ang) * 0.72);
    let start = C - dirv * 0.75 + vec2<f32>(h4 - 0.5, h3 - 0.5) * 0.4;
    if (arr < 1.0 && phase > 0.0 && phase < 0.32) {
      let prog = phase / 0.32;
      P = start + dirv * prog * 1.5;
      bright = sin(prog * 3.14159) * 1.25;
      col = vec3<f32>(0.92, 0.97, 1.0);
    } else {
      P = vec2<f32>(-9.0);   // parked far off-screen between runs
      bright = 0.0;
      col = vec3<f32>(0.0);
    }
  } else if (ii < 8u) {
    // BOKEH on a diet: five smaller, fainter near-field orbs — depth cue only,
    // never smear (operator: "weird blurry low res look" — soft mass was chief suspect)
    if (ii >= 5u) {
      P = vec2<f32>(-9.0);
      bright = 0.0;
      col = vec3<f32>(0.0);
    } else {
      let age = fract(t * 0.008 + h4);
      let ang = h3 * 6.2831853 + t * 0.01;
      let r = 0.25 + 0.45 * h2;
      P = C + vec2<f32>(cos(ang) * r * 1.3, sin(ang) * r * 0.8);
      bright = 0.034 * sin(age * 3.14159);
      col = mix(vec3<f32>(0.60, 0.42, 1.0), vec3<f32>(0.45, 0.70, 1.0), h2);   // violet↔cyan bokeh
    }
  } else if (h1 < 0.38) {
    // DENDRITES — the erupting neural web (Reference B's soul): 24 branching
    // fibers radiate from the mind; signal packets RACE outward along them.
    let tree = floor(h2 * 24.0);
    let ht = hashf(tree * 9.17);
    let a0 = tree / 24.0 * 6.2831853 + ht * 0.26;
    let s = h3;                                   // arc position 0..1 along the fiber
    // organic curvature; half the fibers fork past midway
    var aa = a0 + (ht - 0.5) * 1.1 * s + 0.38 * sin(s * 4.2 + tree);
    if (h4 > 0.5) {
      aa += select(-0.55, 0.55, hashf(id * 6.71) > 0.5) * smoothstep(0.45, 0.62, s);
    }
    let rr = 0.10 + s * (0.22 + ht * 0.36);      // GRAND arcs — fibers reach far
    P = C + vec2<f32>(cos(aa) * rr, sin(aa) * rr * 0.72)
      + vec2<f32>(hashf(id * 11.3) - 0.5, hashf(id * 12.7) - 0.5) * 0.006;
    // each fiber lifts out of the plane along its length — a 3D dendrite crown
    Z = sin(a0 * 2.3 + ht * 6.2831853) * rr * 0.55;
    vol = 1.0;
    // neural firing: a light packet travels each fiber, base glow stays faint
    // LUMINOUS CABLE: a standing glow along the whole fiber (the reference's
    // neural ropes are always lit) with a hot packet racing its length
    let pulse = fract(t * 0.14 + ht * 7.3);
    bright = 0.11 + exp(-abs(s - pulse) * 13.0) * 0.92 * (0.6 + 0.4 * hashf(id * 8.3));
    // deep electric blue — saturation must SURVIVE additive stacking (sharp law's twin)
    col = mix(vec3<f32>(0.20, 0.38, 1.0), vec3<f32>(0.55, 0.88, 1.0), exp(-abs(s - pulse) * 10.0));
  } else if (h1 < 0.52) {
    let h5 = hashf(id * 5.393);
    if (h5 > 0.90) {
      // ERUPTION SPARKS — when the core throws a prominence, these RIDE it.
      // Same cycle + bearing hash as core.wgsl — one event, three organs.
      let cyc = floor(t / 14.0);
      var phE = fract(t / 14.0);
      // phrase gate — sparks fly only in the crescendo (earned overrides below)
      let ph56 = fract(t / 56.0);
      let m3 = smoothstep(0.46, 0.54, ph56) * (1.0 - smoothstep(0.72, 0.82, ph56));
      var act = smoothstep(0.0, 0.06, phE) * (1.0 - smoothstep(0.42, 0.55, phE)) * m3;
      var dirE = fract(sin(cyc * 127.1 + 2400.09) * 43758.5453) * 6.2831853;
      // EARNED override: a completion shockwave aims the sparks at the seat
      let bageS = U.pulse.z;
      if (bageS > 0.0 && bageS < 1.0) {
        let bp = vec2<f32>(U.pulse.x * aspect, U.pulse.y);
        dirE = atan2(bp.y - C.y, bp.x - C.x);
        phE = bageS * 0.55;                       // ride the shockwave clock
        act = max(act, smoothstep(0.0, 0.10, bageS) * (1.0 - smoothstep(0.60, 1.0, bageS)) * 1.2);
      }
      let s = clamp((phE - h4 * 0.18) / 0.40, 0.0, 1.0);   // staggered launch
      let aaE = dirE + (h3 - 0.5) * 0.55 * s + sin(s * 6.0 + h2 * 6.2831853) * 0.05;
      let rE = 0.16 + pow(s, 0.8) * (0.30 + h2 * 0.30);
      P = C + vec2<f32>(cos(aaE) * rE, sin(aaE) * rE * 0.72);
      bright = act * (1.0 - s) * (1.0 - s) * 1.15;
      col = mix(vec3<f32>(0.95, 0.99, 1.0), vec3<f32>(0.35, 0.65, 1.0), s);
    } else {
    // FIELD: born OUTSIDE the fruit, spiral wind outward — discrete embers, not sand
    let speed = mix(0.012, 0.030, h3) * (0.8 + 0.4 * layer);
    let age = fract(t * speed + h4);
    let r = mix(0.11, 0.62, pow(age, 0.66));
    let wind = mix(2.2, 3.6, h2);
    let ang = h3 * 6.2831853 + log(r + 0.06) * wind + t * mix(0.02, 0.05, h2);
    P = C + vec2<f32>(cos(ang) * r, sin(ang) * r * 0.72);
    bright = (1.0 - age) * (1.0 - age) * mix(0.35, 1.0, layer / 2.0) * 0.55;
    // the storm is a CLOUD, not a sheet — each ember on its own depth shell
    Z = (hashf(id * 4.157) - 0.5) * r * 1.1;
    vol = 1.0;
    // spectral storm: most threads run white→orange→ember→violet-ash, but a
    // fifth run cyan→violet and a twelfth run rose — the full rainbow, in motion
    if (h5 < 0.20) {
      col = mix(vec3<f32>(0.75, 0.95, 1.0), vec3<f32>(0.45, 0.55, 1.0), smoothstep(0.0, 0.45, age));
      col = mix(col, vec3<f32>(0.40, 0.20, 0.55), smoothstep(0.45, 1.0, age));
    } else if (h5 < 0.28) {
      // (the rose family retired — palette discipline: embers cool through the
      // one blue family so nothing competes with the mind or with real data)
      col = mix(vec3<f32>(0.98, 0.99, 1.0), vec3<f32>(0.52, 0.72, 1.0), smoothstep(0.0, 0.55, age));
      col = mix(col, vec3<f32>(0.22, 0.26, 0.52), smoothstep(0.55, 1.0, age));
    } else {
      col = mix(vec3<f32>(0.92, 0.98, 1.0), vec3<f32>(0.45, 0.80, 1.0), smoothstep(0.0, 0.22, age));
      col = mix(col, vec3<f32>(0.35, 0.45, 1.0), smoothstep(0.30, 0.62, age));
      col = mix(col, vec3<f32>(0.30, 0.16, 0.50), smoothstep(0.62, 1.0, age));
    }
    }
  } else if (h1 < 0.70) {
    // RING RIDER: lit nodes traveling the five orbital tracks — the reference's
    // living rings. Non-uniform radii (organic, not diagram) — MUST match field.wgsl.
    let k = floor(h2 * 5.0);
    var ringR = 0.150;
    if (k == 1.0) { ringR = 0.198; }
    else if (k == 2.0) { ringR = 0.258; }
    else if (k == 3.0) { ringR = 0.336; }
    else if (k == 4.0) { ringR = 0.435; }
    let dir = select(1.0, -1.0, (i32(k) % 2) == 0);
    let w = 6.2831853 / (40.0 + k * 12.0) * dir * U.mood.y;
    let ang = h3 * 6.2831853 + t * w * mix(0.8, 1.6, h4);
    let wob = 1.0 + sin(t * 0.5 + h4 * 6.28) * 0.006;
    P = C + vec2<f32>(cos(ang), sin(ang) * 0.72) * ringR * wob;
    bright = (0.35 + 0.55 * hashf(id * 7.77)) * (0.7 + 0.3 * sin(t * 1.1 + h4 * 9.0)) * 0.34;
    // each track carries its own hue — gold / violet / teal / rose / ice (reference's multi-hue rings)
    // PALETTE DISCIPLINE: five competing hues collapsed to one family —
    // the tracks vary in VALUE, not in colour. Art direction, not decoration.
    var ringCol = vec3<f32>(0.58, 0.80, 1.0);
    if (k == 1.0) { ringCol = vec3<f32>(0.44, 0.66, 1.0); }
    else if (k == 2.0) { ringCol = vec3<f32>(0.70, 0.90, 1.0); }
    else if (k == 3.0) { ringCol = vec3<f32>(0.38, 0.58, 0.96); }
    else if (k == 4.0) { ringCol = vec3<f32>(0.62, 0.84, 1.0); }
    col = mix(vec3<f32>(0.88, 0.94, 1.0), ringCol, 0.62);   // ice base — synapse riders
  } else {
    // STREAM: core -> project mass along a bowed quadratic, living wobble
    let ai = i32(id) % i32(count);
    let b = U.bodies[ai];
    let A = vec2<f32>(b.x * aspect, b.y);
    let u = fract(t * mix(0.05, 0.10, h3) + h4);
    let d = A - C;
    let perp = normalize(vec2<f32>(-d.y, d.x) + vec2<f32>(1e-5));
    let mid = mix(C, A, 0.5) + perp * (h2 - 0.5) * 0.22 * length(d);
    let p0 = mix(C, mid, u);
    let p1 = mix(mid, A, u);
    P = mix(p0, p1, u) + perp * sin(u * 9.42 + h3 * 6.28 + t * 0.7) * 0.006;
    // light POOLS where it arrives — the instrument visibly RECEIVES the thought
    bright = (sin(u * 3.14159) * 0.85 + 0.15) * 0.45
           * (0.75 + 0.65 * smoothstep(0.72, 0.98, u));
    // the filament carries its project's STATE color — truth travels the wire
    // (deep electric cyan base — the See-Suite synapse — tinted by the project's truth)
    col = mix(vec3<f32>(0.28, 0.60, 1.0), U.tints[ai].rgb, 0.55);
  }

  // expand the instance into a tiny soft quad (two triangles, 6 verts)
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
    vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
  );
  let corner = corners[vi];
  // ── THE VOLUME TURNS — slow majestic rotation about the vertical axis;
  // perspective makes near light swell and far light recede (See-Suite's mind)
  var persp = 1.0;
  if (vol > 0.5) {
    let th = t * 0.05;
    let rel = P - C;
    let xr = rel.x * cos(th) + Z * sin(th);
    let zr = -rel.x * sin(th) + Z * cos(th);
    persp = clamp(1.0 / (1.0 + zr * 0.85), 0.55, 1.8);
    P = C + vec2<f32>(xr * persp, rel.y * (0.72 + 0.28 * persp));
    bright *= persp;
  }
  // DEPTH — every particle lives on its own plane: near ones larger, and they
  // ride the living camera harder (true parallax, not a flat sheet)
  var zdepth = 0.70 + h2 * 0.60;
  if (ii < 8u) { zdepth = 1.55; }              // bokeh floats nearest the eye
  // ── AERIAL PERSPECTIVE — the oldest painterly law: distance COOLS and DIMS.
  // Far light drifts blue and quiet, near light stays true. Free depth (the
  // z values already exist); this is what makes a field read as volume.
  let dep = clamp((zdepth - 0.70) / 0.60, 0.0, 1.0);   // 0 far · 1 near
  col = mix(col * vec3<f32>(0.66, 0.79, 1.20), col, dep);
  bright = bright * (0.78 + 0.32 * dep);
  // bokeh population gets huge soft discs; everything else discrete embers
  // RAZOR LAW: 1080p-normalized, thin floor — points of light, never fat dots
  var sizePx = (1.7 + layer * 1.3 + bright * 2.0) * (res.y / 1080.0) * (0.62 + 0.50 * zdepth) * persp;
  // dendrite members render thicker — cables, not hairs (vol marks them)
  if (vol > 0.5 && h1 < 0.38) { sizePx = sizePx * 1.55; }
  if (ii < 8u) { sizePx = (22.0 + 36.0 * h3) * (res.y / 1080.0); }

  // LIVING CAMERA — world → view (same eye as the field/core shaders)
  let Pv = C + (P - C - vec2<f32>(U.cam.x * aspect, U.cam.y) * zdepth) / U.cam.z;
  var clip = vec2<f32>(Pv.x / aspect, Pv.y) * 2.0 - vec2<f32>(1.0);
  clip.y = -clip.y;
  clip += corner * (sizePx / res) * 2.0;

  var out: VOut;
  out.pos = vec4<f32>(clip, 0.0, 1.0);
  out.corner = corner;
  out.color = col;
  out.bright = bright * U.mood.x;   // state-atlas arousal scales the whole mind
  return out;
}

@fragment
fn fs_main(in: VOut) -> @location(0) vec4<f32> {
  // SHARP LAW: every particle = a crisp core + a soft halo. Points of light,
  // not fog — the reference is tack-sharp with glow, never blurry.
  let d = length(in.corner);
  let core = smoothstep(0.26, 0.02, d) * 1.35;   // razor point, hotter
  let halo = pow(smoothstep(1.0, 0.0, d), 3.0) * 0.11;   // whisper of glow only
  return vec4<f32>(in.color * in.bright * (core + halo) * 1.10, 0.0);
}
