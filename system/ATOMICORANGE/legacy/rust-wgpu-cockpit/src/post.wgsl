// Post chain — the light becomes REAL. Scene lives in HDR; bright energy bleeds
// (bloom), the heart casts volumetric god-rays through the frame, ACES filmic
// tonemap lands it. Three entry points, one module:
//   fs_bright_h : threshold + horizontal gaussian (HDR A -> half-res B0)
//   fs_blur_v   : vertical gaussian               (B0 -> B1)
//   fs_composite: A + bloom + god-rays + ACES     (-> swapchain)

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VOut {
  var p = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0),
  );
  var out: VOut;
  out.pos = vec4<f32>(p[vi], 0.0, 1.0);
  out.uv = vec2<f32>((p[vi].x + 1.0) * 0.5, (1.0 - p[vi].y) * 0.5);
  return out;
}

@group(0) @binding(0) var tex_a: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex_b: texture_2d<f32>;   // bloom (composite only)

// the uniform bridge reaches the composite too (grain time, shock flash)
struct Uniforms {
  res:   vec4<f32>,                 // x, y, time, count
  bodies: array<vec4<f32>, 16>,
  tints:  array<vec4<f32>, 16>,
  mood:  vec4<f32>,
  bias:  vec4<f32>,
  pulse: vec4<f32>,   // shockwave x, y, age; w = portfolio complete-fraction
  cam:   vec4<f32>,
};
@group(0) @binding(3) var<uniform> U: Uniforms;   // composite entry only
@group(0) @binding(4) var tex_f: texture_2d<f32>; // half-res field (composite only)

@fragment
fn fs_bright_h(in: VOut) -> @location(0) vec4<f32> {
  var w = array<f32, 5>(0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
  let texel = 1.0 / vec2<f32>(textureDimensions(tex_a));
  var acc = vec3<f32>(0.0);
  for (var i = -4; i <= 4; i++) {
    let s = textureSample(tex_a, samp, in.uv + vec2<f32>(f32(i) * texel.x * 2.0, 0.0)).rgb;
    // soft threshold: only TRUE light blooms; mids stay crisp (sharp law)
    let l = max(vec3<f32>(0.0), s - vec3<f32>(0.82));
    acc += l * w[abs(i)];
  }
  return vec4<f32>(acc, 1.0);
}

@fragment
fn fs_blur_v(in: VOut) -> @location(0) vec4<f32> {
  var w = array<f32, 5>(0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
  let texel = 1.0 / vec2<f32>(textureDimensions(tex_a));
  var acc = vec3<f32>(0.0);
  for (var i = -4; i <= 4; i++) {
    acc += textureSample(tex_a, samp, in.uv + vec2<f32>(0.0, f32(i) * texel.y * 2.0)).rgb * w[abs(i)];
  }
  return vec4<f32>(acc, 1.0);
}

fn aces(x: vec3<f32>) -> vec3<f32> {
  let a = 2.51; let b = 0.03; let c = 2.43; let d = 0.59; let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3<f32>(0.0), vec3<f32>(1.0));
}

@fragment
fn fs_composite(in: VOut) -> @location(0) vec4<f32> {
  // ── CINEMA LENS: chromatic aberration — only at the frame's edge, never center.
  // The red and blue planes part ~3px at the corners: glass, not a screenshot.
  let cvec = in.uv - vec2<f32>(0.5, 0.5);
  let ab = cvec * dot(cvec, cvec) * 0.0075;
  let s0 = textureSample(tex_a, samp, in.uv).rgb;
  let sr = textureSample(tex_a, samp, in.uv + ab).r;
  let sb = textureSample(tex_a, samp, in.uv - ab).b;
  // the half-res field joins the frame here (bilinear upscale — gas is smooth)
  let f0 = textureSample(tex_f, samp, in.uv).rgb;
  let fr = textureSample(tex_f, samp, in.uv + ab).r;
  let fb = textureSample(tex_f, samp, in.uv - ab).b;
  var scene = vec3<f32>(sr, s0.g, sb) + vec3<f32>(fr, f0.g, fb);
  // ── UNSHARP MASK — the anti-blur weapon: subtract the local blur, the
  // remainder is EDGE. Everything (gas, filaments, points) snaps into focus.
  let px = 1.0 / vec2<f32>(textureDimensions(tex_a));
  let nb = textureSample(tex_a, samp, in.uv + vec2<f32>(px.x, 0.0)).rgb
         + textureSample(tex_f, samp, in.uv + vec2<f32>(px.x, 0.0)).rgb
         + textureSample(tex_a, samp, in.uv - vec2<f32>(px.x, 0.0)).rgb
         + textureSample(tex_f, samp, in.uv - vec2<f32>(px.x, 0.0)).rgb
         + textureSample(tex_a, samp, in.uv + vec2<f32>(0.0, px.y)).rgb
         + textureSample(tex_f, samp, in.uv + vec2<f32>(0.0, px.y)).rgb
         + textureSample(tex_a, samp, in.uv - vec2<f32>(0.0, px.y)).rgb
         + textureSample(tex_f, samp, in.uv - vec2<f32>(0.0, px.y)).rgb;
  scene = max(scene * 1.88 - nb * 0.22, vec3<f32>(0.0));
  let bloom = textureSample(tex_b, samp, in.uv).rgb;

  // volumetric god-rays: march the bloom buffer toward the heart — light shafts
  let heart = vec2<f32>(0.5, 0.46);
  var ray = vec3<f32>(0.0);
  var w = 1.0;
  var totw = 0.0;
  let step = (heart - in.uv) / 14.0;
  var suv = in.uv;
  for (var i = 0; i < 14; i++) {
    suv += step;
    ray += textureSample(tex_b, samp, suv).rgb * w;
    totw += w;
    w *= 0.86;
  }
  ray /= totw;

  // ── ANAMORPHIC STREAK — the hottest light draws a horizontal blade (lens
  // cinema): sampled from the bloom buffer, electric blue, falls off fast.
  // ── MULTI-SCALE BLOOM — reference-class light is TWO glows at once: a tight
  // halo hugging the source and a wide atmospheric one carrying it into the
  // frame. One gaussian can only be one of those; eight wide taps buy the other.
  var wide = vec3<f32>(0.0);
  for (var w2 = 0; w2 < 8; w2++) {
    let a2 = f32(w2) * 0.7853982;
    wide += textureSample(tex_b, samp, in.uv + vec2<f32>(cos(a2), sin(a2)) * 0.022).rgb;
  }
  wide *= 0.125;

  var streak = vec3<f32>(0.0);
  for (var k = 1; k <= 4; k++) {
    let o = f32(k) * f32(k) * 0.005;
    let wk = exp(-f32(k) * 0.60);
    streak += textureSample(tex_b, samp, vec2<f32>(in.uv.x + o, in.uv.y)).rgb * wk;
    streak += textureSample(tex_b, samp, vec2<f32>(in.uv.x - o, in.uv.y)).rgb * wk;
  }
  streak *= 0.15;

  // SHARP LAW (operator: "blurry not sharp"): the scene stays crisp everywhere.
  // Glow comes ONLY from true highlights (bloom), never from softening the world.
  var col = scene * 0.74
          + bloom * 0.13
          + wide * vec3<f32>(0.42, 0.62, 1.0) * 0.11   // the atmospheric half
          + ray * vec3<f32>(0.55, 0.72, 1.0) * 0.05    // god-rays go electric (See-Suite)
          + streak * vec3<f32>(0.45, 0.65, 1.0) * 0.70; // the blade, restrained
  // completion shockwave kisses the WHOLE frame — one earned flash
  let bage = U.pulse.z;
  if (bage > 0.0 && bage < 1.0) {
    col *= 1.0 + 0.16 * (1.0 - bage) * (1.0 - bage);
  }
  // ── GRADE — teal-leaning shadows, clean neutral highs (See-Suite cinema)
  let luma = dot(col, vec3<f32>(0.299, 0.587, 0.114));
  col = mix(col * vec3<f32>(0.90, 1.00, 1.10), col, smoothstep(0.0, 0.45, luma));
  col = aces(col);
  col = pow(col, vec3<f32>(0.98));
  // ── THE VALUE STRUCTURE (notan) — the single discipline that separates
  // reference-class images from busy ones: light is not spread, it is SPENT.
  // Bright at the mind, falling to deep dark at the rim (~60/30/10 by area).
  let aspect2 = U.res.x / max(U.res.y, 1.0);
  // `nr` = notan radius (distance from the heart, aspect-corrected).
  // Named `nr`, not `fr`: `fr` is already the FIELD RED sample at line 82 and
  // belongs to the sr/sb/fr/fb chromatic-aberration family. Two different
  // meanings under one abbreviation is what broke the module ('redefinition
  // of `fr`', wgsl:82 vs wgsl:145 — panic at create_shader_module, exit 101).
  let nr = length((in.uv - vec2<f32>(0.5, 0.46)) * vec2<f32>(aspect2, 1.0));
  col *= mix(1.18, 0.30, smoothstep(0.05, 0.78, nr));

  // ── PAINTERLY CHROMA — the references are RICH: +12% saturation after the
  // tonemap, clamped (finish law: light quality over new features)
  let luma2 = dot(col, vec3<f32>(0.299, 0.587, 0.114));
  col = clamp(mix(vec3<f32>(luma2), col, 1.12), vec3<f32>(0.0), vec3<f32>(1.0));
  // ── FILMIC S-CURVE — shadows deepen, highlights hold: the midtone flatness
  // is the last thing separating this from a printed reference frame. Gentle
  // (35% blend) so no measured value is ever crushed out of legibility.
  let scurve = col * col * (3.0 - 2.0 * col);
  col = mix(col, scurve, 0.35);
  // ── FILM GRAIN — living dither; kills banding in the deep gradients
  let gr = fract(sin(dot(in.uv * U.res.xy
        + vec2<f32>(U.res.z * 61.0, U.res.z * 37.0), vec2<f32>(127.1, 311.7))) * 43758.5453);
  col += (gr - 0.5) * 0.005;
  return vec4<f32>(col, 1.0);
}
