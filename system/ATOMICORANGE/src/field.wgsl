// The Resting Field at FULL POWER — the reference-bar stage.
// Dual-family nebula (indigo night / ember) + dust lanes + gravitational lensing
// + 5-ring orbital system with dotted tracks, traveling comets, radial spokes
// + 3 parallax starfield layers + hearth + circadian + 1/f. Calm-at-density:
// everything slow, everything organized radially, saturation carries truth.

struct Uniforms {
  res:   vec4<f32>,                 // x, y, time, count
  bodies: array<vec4<f32>, 16>,     // x, y (0..1, y down), mass, _
  tints:  array<vec4<f32>, 16>,     // r, g, b, _
  mood:  vec4<f32>,                 // intensity, ring_speed, _, _ (state atlas)
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
fn ridged(p: vec2<f32>) -> f32 {
  return 1.0 - abs(2.0 * fbm(p) - 1.0);   // dust-lane filaments
}
fn pink(t: f32) -> f32 {
  var s = 0.0; var a = 0.5; var f = 1.0;
  for (var k = 0; k < 4; k++) {
    s += a * sin(t * f + f32(k) * 1.7);
    f *= 2.0; a *= 0.5;
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
  let time = U.res.z;
  let count = i32(U.res.w);
  // HALF-RES TARGET: this pass renders at res/2 (the fbm gas is the frame's
  // dominant cost on the iGPU); ×2 keeps every coordinate in full-res space
  let p = fragCoord.xy * 2.0 / res;
  let aspect = res.x / res.y;
  let C = vec2<f32>(0.5 * aspect, 0.46);
  // LIVING CAMERA: sample the world through a breathing, drifting eye
  let uv0 = vec2<f32>(p.x * aspect, p.y);
  let uv = C + (uv0 - C) * U.cam.z + vec2<f32>(U.cam.x * aspect, U.cam.y);

  // ── gravity: lensing + state-tinted accretion ──────────────────────────
  var warp = vec2<f32>(0.0);
  var glow = vec3<f32>(0.0);
  var coreHeat = 0.0;
  for (var i = 0; i < 16; i++) {
    if (i >= count) { break; }
    let b = U.bodies[i];
    let bp = vec2<f32>(b.x * aspect, b.y);
    let d = uv - bp;
    let r = length(d) + 1e-4;
    let m = b.z;
    warp -= normalize(d) * (m * 0.013) / (r * r + 0.030);
    // tighter falloff: a project MARKS its region (instrument), it does not
    // wash a third of the sky — the field's dominance stays blue (canon)
    glow += U.tints[i].rgb * (m * exp(-r * r * (150.0 / (m + 0.40))));
    coreHeat += m * exp(-r * r * 760.0);
  }

  var suv = uv + warp;
  // ── THE STIR — differential rotation: the mind slowly turns its own gas.
  // Angle grows with time and decays with radius: a true vortex, not a spin.
  let relg = suv - C;
  let rg = length(relg);
  let stir = exp(-rg * 2.2) * (0.35 + time * 0.006);
  let cs_ = cos(stir);
  let sn_ = sin(stir);
  suv = C + vec2<f32>(relg.x * cs_ - relg.y * sn_, relg.x * sn_ + relg.y * cs_);

  // ── nebula: two families breathing against each other ──────────────────
  let q = vec2<f32>(fbm(suv * 2.0), fbm(suv * 2.0 + vec2<f32>(4.3, 1.7)));
  var nebA = fbm(suv * 2.6 + q * 1.5 + vec2<f32>(time * 0.004, 0.0));
  nebA = pow(clamp(nebA, 0.0, 1.0), 2.5);     // drama: pitch-black voids, brilliant pockets
  var nebB = fbm(suv * 1.7 - q * 1.1 + vec2<f32>(0.0, time * 0.003) + 11.0);
  nebB = pow(clamp(nebB, 0.0, 1.0), 2.7);
  // dust lanes: dark ridged filaments occluding the gas
  let dust = pow(clamp(ridged(suv * 3.1 + 5.0), 0.0, 1.0), 3.0);

  // ── SEE-SUITE PALETTE (Reference B primary): deep indigo/violet space,
  // magenta neural gas, electric cyan energy. Warmth cycle stays but cool-biased.
  let warmth = (0.5 + 0.5 * sin(time / 1800.0 * 6.2831853)) * 0.45;
  let nightA = vec3<f32>(0.014, 0.020, 0.085);   // deep indigo — the space itself
  let nightB = vec3<f32>(0.075, 0.018, 0.105);   // violet-magenta — neural gas
  let emberA = vec3<f32>(0.040, 0.026, 0.070);   // warm shift stays blue-violet
  let emberB = vec3<f32>(0.090, 0.024, 0.080);
  // GRANULATION — the gas is made of RESOLVED dust, not fog (anti-blur law):
  // fine high-frequency structure modulates every gas family
  let gran = pow(clamp(vnoise(suv * 90.0) * 0.55 + vnoise(suv * 190.0) * 0.45, 0.0, 1.0), 1.4);
  let granM = 0.45 + 1.05 * gran;
  // the gas gives ground back to the mind: less ambient wash, deeper voids —
  // light spent on structure, not atmosphere (the paint law)
  var col = mix(nightA, emberA, warmth) * (0.24 + 1.30 * nebA) * granM
          + mix(nightB, emberB, warmth) * (0.18 + 1.00 * nebB) * granM;
  // electric cyan family — the See-Suite signature, now PRIMARY energy color
  var nebC = fbm(suv * 2.2 - q * 0.8 + vec2<f32>(time * 0.0035, 7.0));
  nebC = pow(clamp(nebC, 0.0, 1.0), 2.1);
  col += vec3<f32>(0.014, 0.075, 0.105) * nebC * 1.1 * granM;         // cyan gas, granulated
  // asymmetric radiant pocket (upper-left) — cyan-magenta off-axis glow
  let pocket = exp(-length(uv - vec2<f32>(0.30 * aspect, 0.22)) * 3.4);
  col += vec3<f32>(0.025, 0.095, 0.110) * pocket * nebC * 2.3;
  // PALETTE DISCIPLINE: the magenta family is retired — one field color
  // (indigo), one energy color (cyan), white-hot focus, orange only as data.
  // Competing hues are what make a render read amateur.
  col += vec3<f32>(0.030, 0.034, 0.082) * pocket * nebA * 1.5;
  col += vec3<f32>(0.026, 0.030, 0.072) * pow(dust, 1.5) * 0.9;       // lanes stay in-family
  col += vec3<f32>(0.010, 0.040, 0.058) * pow(nebB * nebC, 2.0) * 1.1; // cyan at overlaps
  col *= (0.50 + 0.50 * (1.0 - dust * 0.92));    // lanes eat MORE light — contrast is sharpness

  // ── THE DEEP GALAXY BAND — a diagonal river of far light. The depth anchor:
  // everything else floats IN FRONT of this. Faint, granular, slow.
  let bandN = vec2<f32>(-0.56, 0.83);            // band normal (diagonal river)
  let bandD = dot(uv - vec2<f32>(0.5 * aspect, 0.30), bandN);
  let bandM = exp(-bandD * bandD * 16.0);
  let bandGas = fbm(uv * 5.0 + vec2<f32>(time * 0.0016, 0.0)) * fbm(uv * 11.0 + 3.0);
  col += vec3<f32>(0.085, 0.115, 0.26) * bandM * bandGas * 0.45;

  // ── the orbital ring system: 5 dotted tracks + traveling comets ────────
  // elliptical radius around the heart (matches the web's 0.72 squash)
  let rel = (uv - C) / vec2<f32>(1.0, 0.72);
  let rc = length(rel);
  let angC = atan2(rel.y, rel.x);
  var ringLight = 0.0;
  for (var k = 0; k < 5; k++) {
    let fk = f32(k);
    // non-uniform radii — organic constellation, not a diagram (matches web.wgsl riders)
    var ringR = 0.150;
    if (k == 1) { ringR = 0.198; }
    else if (k == 2) { ringR = 0.258; }
    else if (k == 3) { ringR = 0.336; }
    else if (k == 4) { ringR = 0.435; }
    // per-ring presence varies: some tracks bold, some whispers
    var amp = 1.0;
    if (k == 1) { amp = 0.45; }
    else if (k == 3) { amp = 0.6; }
    else if (k == 4) { amp = 0.35; }
    // TRACK HIERARCHY — a designed orbital system, not a generated one: one
    // bold primary, the rest hairlines. Uniform weights read as a diagram.
    var trackW = 0.0020;
    if (k == 1) { trackW = 0.0011; }
    else if (k == 2) { trackW = 0.0032; }   // the primary
    else if (k == 3) { trackW = 0.0013; }
    else if (k == 4) { trackW = 0.0009; }
    let dr = abs(rc - ringR);
    // CABLE TREATMENT: crisp core + soft sheath — the tracks read as lit rope,
    // not as plotted diagram lines (matching the dendrites they share a sky with)
    let track = smoothstep(trackW, 0.0, dr) + smoothstep(trackW * 3.4, trackW * 0.7, dr) * 0.32;
    let nDots = 90.0 + fk * 36.0;
    let dir = select(1.0, -1.0, (k % 2) == 0);
    let dash = smoothstep(0.35, 0.9, 0.5 + 0.5 * sin(angC * nDots + time * 0.05 * dir * U.mood.y));
    ringLight += track * dash * 0.17 * amp;
    // the comet: one bright pulse traveling each ring (~40-90s per revolution)
    let w = 6.2831853 / (40.0 + fk * 12.0) * dir * U.mood.y;
    var da = angC - time * w - fk * 2.4;
    da = atan2(sin(da), cos(da));               // wrap to [-pi, pi]
    ringLight += track * exp(-da * da * 30.0) * 1.4 * amp;
    // second courier, counter-phase and slower — the tracks carry TRAFFIC
    var da2 = angC - time * w * 0.62 - fk * 2.4 + 3.14159;
    da2 = atan2(sin(da2), cos(da2));
    ringLight += track * exp(-da2 * da2 * 44.0) * 0.8 * amp;
  }
  // radial spokes at the eight department bearings — FINE threads, not wedges
  // (the pale spoke-wheel washed the center; threads carry the structure)
  let spoke = pow(0.5 + 0.5 * cos(angC * 8.0 + 0.3927), 90.0);
  ringLight += spoke * smoothstep(0.42, 0.14, abs(rc - 0.28) ) * 0.055;
  // rings = electric synapse light (See-Suite): ice-cyan with a violet undertone
  col += vec3<f32>(0.52, 0.72, 1.0) * ringLight * 0.16;

  // ── hearth + truth accents ──────────────────────────────────────────────
  // the hearth cools to a violet aura — the mind's ambient radiance
  let hearth = exp(-length(uv - C) * 1.8);
  col += vec3<f32>(0.055, 0.035, 0.105) * hearth * (0.42 + 0.15 * pink(time * 0.1));
  let pulse = 0.5 + 0.5 * sin(time * 1.4);
  // project glow is ILLUMINATED GAS, not paint: the mass lights the structure
  // that is actually there (granulation + ridged filaments), so a working
  // project reads as a lit region of the nebula instead of a soft blob
  let glowStruct = (0.62 + 0.90 * pow(clamp(ridged(suv * 4.2 + 9.0), 0.0, 1.0), 1.6)) * granM;
  col += glow * (0.90 + 0.30 * pulse) * (0.42 + 0.78 * nebA) * glowStruct * U.mood.x;
  // canon: mass-heat is COOL white (the warm-white was the last orange-era relic)
  col += vec3<f32>(0.82, 0.91, 1.0) * coreHeat * (0.45 + 0.15 * pulse) * U.mood.x;
  // state weather — the atlas leans the whole field's color, gently
  col += U.bias.rgb * (0.4 + nebA);

  // ── the field FEELS the eruption — gas heats along the prominence bearing
  // (same cycle + hash as core.wgsl: one event, three organs answering)
  let cycE = floor(time / 14.0);
  let phE = fract(time / 14.0);
  // phrase gate — the gas answers eruptions only in the crescendo movement
  let ph56 = fract(time / 56.0);
  let m3 = smoothstep(0.46, 0.54, ph56) * (1.0 - smoothstep(0.72, 0.82, ph56));
  let actE = smoothstep(0.0, 0.06, phE) * (1.0 - smoothstep(0.42, 0.55, phE)) * m3;
  if (actE > 0.001) {
    let dirE = hash(vec2<f32>(cycE, 7.7)) * 6.2831853;
    var ddE = angC - dirE;
    ddE = atan2(sin(ddE), cos(ddE));
    let reachE = phE / 0.55;
    col += vec3<f32>(0.16, 0.40, 0.80) * exp(-ddE * ddE * 6.0) * exp(-rc * 2.6)
         * actE * (0.35 + 0.50 * reachE) * (0.4 + 1.6 * nebC) * U.mood.x;
  }

  // ── completion shockwave — the ONE earned fast motion: light expands from done work ──
  let bage = U.pulse.z;
  if (bage > 0.0 && bage < 1.0) {
    let bp = vec2<f32>(U.pulse.x * aspect, U.pulse.y);
    let bd = length(uv - bp);
    let ring = exp(-abs(bd - bage * 0.55) * 80.0) * (1.0 - bage) * (1.0 - bage);
    col += vec3<f32>(0.55, 1.0, 0.62) * ring * 1.5;      // green truth, racing outward
    col += vec3<f32>(1.0, 0.85, 0.45) * exp(-bd * 6.0) * (1.0 - bage) * 0.25; // afterglow
    // the gas heats along the completion bearing — the eruption is EARNED
    var ddB = angC - atan2((bp.y - C.y) / 0.72, bp.x - C.x);
    ddB = atan2(sin(ddB), cos(ddB));
    col += vec3<f32>(0.18, 0.55, 0.42) * exp(-ddB * ddB * 5.0) * exp(-rc * 2.4)
         * (1.0 - bage) * 0.5 * (0.4 + 1.6 * nebC);
  }

  // ── three parallax starfield layers ─────────────────────────────────────
  for (var L = 0; L < 3; L++) {
    let fl = f32(L);
    let sc = 180.0 + fl * 220.0;
    let g = (uv + warp * (0.3 + fl * 0.5)) * sc;
    let h = hash(floor(g) + fl * 17.0);
    let thresh = 0.9905 - fl * 0.004;            // far layers denser, dimmer
    if (h > thresh) {
      let gf = fract(g) - 0.5;
      let tw = 0.55 + 0.45 * sin(time * (0.5 + fl * 0.3) + h * 40.0);
      let star = smoothstep(0.5, 0.0, length(gf)) * tw;
      col += mix(vec3<f32>(0.78, 0.84, 1.0), vec3<f32>(1.0, 0.9, 0.75), h * 4.0 - 3.96)
           * star * (0.74 - fl * 0.18);   // crisp points brighter — sharp carries the eye
    }
  }
  // ── HERO STARS — rare near-field jewels with diffraction spikes ─────────
  let g4 = (uv + warp * 0.9) * 34.0;
  let h4s = hash(floor(g4) + 51.0);
  if (h4s > 0.9930) {
    let gf = fract(g4) - 0.5;
    let tw4 = 0.60 + 0.40 * sin(time * 0.7 + h4s * 90.0);
    let core4 = smoothstep(0.16, 0.0, length(gf));
    let spike = exp(-abs(gf.x) * 26.0) * exp(-gf.y * gf.y * 900.0)
              + exp(-abs(gf.y) * 26.0) * exp(-gf.x * gf.x * 900.0);
    col += vec3<f32>(0.85, 0.92, 1.0) * (core4 * 1.5 + spike * 0.85) * tw4 * 0.50;
  }

  // ── vignette to OLED black + gentle filmic ──────────────────────────────
  let vig = smoothstep(1.28, 0.14, length((p - 0.5) * vec2<f32>(aspect, 1.0)) * 1.30);
  col *= mix(0.10, 1.0, vig);   // corners sink toward OLED black — light stays concentrated
  col = col / (col + vec3<f32>(0.92));
  col = pow(col, vec3<f32>(0.90));
  return vec4<f32>(col, 1.0);
}
