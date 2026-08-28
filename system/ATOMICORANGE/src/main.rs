//! Atomic Orange — the native living organism. Rust + wgpu + egui. NO webview (render law §7b).
//! Frame one: the mindrest GalaxyField (WGSL) with the six portfolio masses lensing it,
//! egui HUD floating over — honest OFFLINE vitals until the OrangeBrain gateway is wired.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use eframe::egui;
use eframe::egui_wgpu::{self, wgpu};

mod audio;
mod gateway;
mod ops;
mod panels;
mod presets;

use std::sync::atomic::{AtomicBool, Ordering};

/// S key arms this; the next frame the organism photographs ITSELF (wgpu readback)
/// — pixel-perfect receipts, no focus games, no DPI lies. AOMBP N3 backbone.
static SHOT_REQUESTED: AtomicBool = AtomicBool::new(false);

const MAX_BODIES: usize = 16;

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Uniforms {
    res: [f32; 4],                     // w, h, time, count
    bodies: [[f32; 4]; MAX_BODIES],    // x, y, mass, _
    tints: [[f32; 4]; MAX_BODIES],     // r, g, b, _
    mood: [f32; 4],                    // intensity, ring_speed, _, _  (state atlas)
    bias: [f32; 4],                    // field color lean r, g, b, _
    pulse: [f32; 4],                   // shockwave x, y, age · w = portfolio complete-fraction
    cam: [f32; 4],                     // living camera: offx, offy, zoom, _
}

use ops::PState;

/// THE SOUL — what survives death. Written every ~10s to %APPDATA%; read at
/// birth. The organism keeps its biography: which life this is, what its
/// painter last chose, where the operator left the atlas, its last judgment.
#[derive(serde::Serialize, serde::Deserialize, Default, Clone)]
struct Soul {
    session_count: u32,
    total_uptime_secs: u64,
    comp_notes: Vec<String>,
    comp_feature: Option<String>,
    preset: usize,
    composer_on: bool,
    // (talk is session-only: a conversation mode should not survive a death)
    last_verdict: String,
    last_seen: String,
}

fn soul_path() -> std::path::PathBuf {
    let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".into());
    std::path::PathBuf::from(base).join("AtomicOrange").join("soul.json")
}

/// full AI-box truth from the codexa stats agent (tools/codexa-stats-agent.ps1):
/// only ever displayed when the agent actually answered — no invention
#[derive(Clone)]
struct CxStats {
    cpu: f32,
    mem_free: f32,
    mem_total: f32,
    /// (util %, vram used MB, vram total MB, temp °C) when nvidia-smi answers
    gpu: Option<(f32, f32, f32, f32)>,
    /// (mount, free GB, free fraction)
    disks: Vec<(String, f32, f32)>,
}

/// U1 — the AELID mode engine (SUPER COMMAND charter). Eight semantic modes,
/// DERIVED from real signals every frame — never forced, never faked.
#[derive(PartialEq, Clone, Copy)]
enum Mode {
    Calm,
    Listening,
    Thinking,
    Analyzing,
    Alert,
    Generating,
    Reviewing,
    Deploying,
}

const ALL_MODES: [Mode; 8] = [
    Mode::Calm, Mode::Listening, Mode::Thinking, Mode::Analyzing,
    Mode::Alert, Mode::Generating, Mode::Reviewing, Mode::Deploying,
];

impl Mode {
    fn label(self) -> &'static str {
        match self {
            Mode::Calm => "CALM",
            Mode::Listening => "LISTENING",
            Mode::Thinking => "THINKING",
            Mode::Analyzing => "ANALYZING",
            Mode::Alert => "ALERT",
            Mode::Generating => "GENERATING",
            Mode::Reviewing => "REVIEWING",
            Mode::Deploying => "DEPLOYING",
        }
    }
    /// (energy multiplier, ring-speed multiplier, bias lean r,g,b) — §8 of the handoff
    fn drive(self) -> (f32, f32, [f32; 3]) {
        match self {
            Mode::Calm => (1.0, 1.0, [0.0, 0.0, 0.0]),
            Mode::Listening => (1.08, 1.0, [0.000, 0.014, 0.022]),
            Mode::Thinking => (1.22, 1.35, [0.012, 0.000, 0.030]),
            Mode::Analyzing => (1.15, 1.15, [0.000, 0.022, 0.020]),
            Mode::Alert => (1.45, 1.60, [0.045, -0.006, -0.010]),
            Mode::Generating => (1.25, 1.10, [0.020, 0.014, 0.008]),
            Mode::Reviewing => (0.85, 0.55, [0.000, 0.008, 0.024]),
            Mode::Deploying => (1.20, 1.25, [0.000, 0.026, 0.010]),
        }
    }
    fn color(self) -> egui::Color32 {
        match self {
            Mode::Calm => egui::Color32::from_rgb(120, 160, 190),
            Mode::Listening => egui::Color32::from_rgb(90, 200, 255),
            Mode::Thinking => egui::Color32::from_rgb(170, 130, 255),
            Mode::Analyzing => egui::Color32::from_rgb(80, 220, 200),
            Mode::Alert => egui::Color32::from_rgb(255, 93, 86),
            Mode::Generating => egui::Color32::from_rgb(255, 180, 90),
            Mode::Reviewing => egui::Color32::from_rgb(255, 193, 74),
            Mode::Deploying => egui::Color32::from_rgb(119, 209, 124),
        }
    }
}

/// ONE source of truth: the operations brain (ops.rs). Physics masses AND
/// instrument cards read live projects; SLOTS are their stable orbital seats.
// perimeter seats — projects ORBIT the mind (center stays clear for the nova)
const SLOTS: [(f32, f32); 12] = [
    (0.05, 0.42), (0.95, 0.42), (0.22, 0.90), (0.78, 0.88), (0.10, 0.09), (0.90, 0.07),
    (0.03, 0.68), (0.97, 0.66), (0.20, 0.04), (0.88, 0.03), (0.66, 0.94), (0.12, 0.03),
];

const DEPTS: [(&str, &str, &str); 8] = [
    ("VT", "VAULT", "Knowledge Core"),
    ("MR", "MIRRORS", "Reality Audit"),
    ("LP", "LIPS", "Comms Engine"),
    ("MF", "MISFITS", "Frontier Ops"),
    ("HP", "HACK THE PLANET", "Infra & Scale"),
    ("JD", "JUDGE", "Product Sharpness"),
    ("BD", "BUILDER", "Code Writer"),
    ("ST", "STEWARD", "Ops Pulse"),
];

fn state_tint(s: PState) -> [f32; 4] {
    match s {
        PState::Building => [1.0, 0.45, 0.12, 0.0],
        PState::Hold => [0.30, 0.32, 0.50, 0.0],
        PState::Complete => [0.32, 0.85, 0.44, 0.0],
    }
}

// CONNECTED LAW (operator: "not connected to the top"): the HUD instruments are
// REAL anchors in the physics — the mind's filaments flow INTO the panels, and
// the gas leans toward them. Anchors are computed from live panel geometry in
// ops_bodies(). Crystallized light at the edge of its thought.

/// STAGE MAPPING — slots live in the free stage BETWEEN the instrument rails,
/// at any window size (left rail 265px · right rail 285px · top 165 · bottom 200).
/// Cards and physics bodies share this, so filaments always end at the cards.
fn stage_frac(sx: f32, sy: f32, sw: f32, sh: f32) -> (f32, f32) {
    let x = (265.0 + sx * (sw - 265.0 - 285.0).max(200.0)) / sw;
    let y = (165.0 + sy * (sh - 165.0 - 200.0).max(160.0)) / sh;
    (x, y)
}

/// live physics from the operations brain: every mass IS a real project
fn ops_bodies(projects: &[ops::Project], sw: f32, sh: f32) -> ([[f32; 4]; MAX_BODIES], [[f32; 4]; MAX_BODIES], f32) {
    let mut bodies = [[0.0f32; 4]; MAX_BODIES];
    let mut tints = [[0.0f32; 4]; MAX_BODIES];
    // seats: projects | 4 HUD anchors | 1 presence
    let n = projects.len().min(MAX_BODIES - 5);
    for (i, p) in projects.iter().take(n).enumerate() {
        let (sx, sy) = SLOTS[p.slot.min(SLOTS.len() - 1)];
        let (x, y) = stage_frac(sx, sy, sw, sh);
        // mass breathes with truth: weight base, progress feeds brightness
        let mass = p.weight * (0.70 + 0.35 * (p.progress() as f32 / 100.0));
        bodies[i] = [x, y, mass, 0.0];
        tints[i] = state_tint(p.state);
    }
    // HUD anchors from the REAL panel geometry (px → fraction)
    let anchors = [
        (0.5, 100.0 / sh),
        (135.0 / sw, 0.34),
        ((sw - 140.0) / sw, 0.34),
        (0.5, (sh - 80.0) / sh),
    ];
    for (k, (ax, ay)) in anchors.iter().enumerate() {
        bodies[n + k] = [*ax, *ay, 0.07, 0.0];              // subtle gravitational presence
        tints[n + k] = [0.45, 0.75, 1.0, 0.0];              // electric synapse cyan
    }
    (bodies, tints, (n + anchors.len()) as f32)
}

const WEB_PARTICLES: u32 = 96_000; // razor-sized — density holds, N150 iGPU breathes

const HDR_FMT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;

/// Per-size offscreen chain: HDR scene target + half-res bloom ping-pong.
struct PostTex {
    size: [u32; 2],
    a_view: wgpu::TextureView,
    /// HALF-RES field target — the fbm gas is the frame's dominant cost on the
    /// N150 iGPU (RENDER 11 on release); smooth gas upscales invisibly, 4× saved
    f_view: wgpu::TextureView,
    b0_view: wgpu::TextureView,
    b1_view: wgpu::TextureView,
    bg_bright: wgpu::BindGroup, // reads A
    bg_blurv: wgpu::BindGroup,  // reads B0
    bg_comp: wgpu::BindGroup,   // reads A + B1 + F
}

struct FieldResources {
    // scene organs (render into HDR)
    pipeline: wgpu::RenderPipeline,
    web_pipeline: wgpu::RenderPipeline,
    core_pipeline: wgpu::RenderPipeline,
    bind_group: wgpu::BindGroup,
    uniform_buf: wgpu::Buffer,
    // post chain
    bright_pipe: wgpu::RenderPipeline,
    blurv_pipe: wgpu::RenderPipeline,
    comp_pipe: wgpu::RenderPipeline,
    comp_shot_pipe: wgpu::RenderPipeline, // composite -> Rgba8 for self-photograph
    sampler: wgpu::Sampler,
    post1_bgl: wgpu::BindGroupLayout,
    post2_bgl: wgpu::BindGroupLayout,
    tex: Option<PostTex>,
}

fn make_tex(device: &wgpu::Device, w: u32, h: u32, label: &str) -> wgpu::TextureView {
    device
        .create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d { width: w.max(1), height: h.max(1), depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: HDR_FMT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        })
        .create_view(&wgpu::TextureViewDescriptor::default())
}

impl FieldResources {
    fn ensure_tex(&mut self, device: &wgpu::Device, w: u32, h: u32) {
        if self.tex.as_ref().map(|t| t.size) == Some([w, h]) {
            return;
        }
        let a_view = make_tex(device, w, h, "hdr-a");
        let f_view = make_tex(device, w / 2, h / 2, "field-half");
        let b0_view = make_tex(device, w / 2, h / 2, "bloom-b0");
        let b1_view = make_tex(device, w / 2, h / 2, "bloom-b1");
        let bg1 = |view: &wgpu::TextureView, label: &str| {
            device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some(label),
                layout: &self.post1_bgl,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(view) },
                    wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&self.sampler) },
                ],
            })
        };
        let bg_bright = bg1(&a_view, "bg-bright");
        let bg_blurv = bg1(&b0_view, "bg-blurv");
        let bg_comp = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("bg-comp"),
            layout: &self.post2_bgl,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&a_view) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&self.sampler) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&b1_view) },
                wgpu::BindGroupEntry { binding: 3, resource: self.uniform_buf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::TextureView(&f_view) },
            ],
        });
        self.tex = Some(PostTex { size: [w, h], a_view, f_view, b0_view, b1_view, bg_bright, bg_blurv, bg_comp });
    }
}

struct FieldCallback {
    time: f32,
    size: [f32; 2],
    /// operator presence 0..1 (y down) — the organism notices you
    pointer: Option<[f32; 2]>,
    /// state-atlas mood: (intensity, ring_speed, _, _)
    mood: [f32; 4],
    /// state-atlas field color lean
    bias: [f32; 4],
    /// current preset id — labels the self-photograph receipt
    preset_id: u8,
    /// live physics from the operations brain (computed in update)
    bodies: [[f32; 4]; MAX_BODIES],
    tints: [[f32; 4]; MAX_BODIES],
    count: f32,
    /// shockwave x, y, age · w = portfolio complete-fraction (the fruit's dial)
    pulse: [f32; 4],
    /// living camera: offx, offy, zoom
    cam: [f32; 4],
}

impl egui_wgpu::CallbackTrait for FieldCallback {
    fn prepare(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        screen: &egui_wgpu::ScreenDescriptor,
        encoder: &mut wgpu::CommandEncoder,
        resources: &mut egui_wgpu::CallbackResources,
    ) -> Vec<wgpu::CommandBuffer> {
        let r: &mut FieldResources = resources.get_mut().expect("field resources");
        let (mut bodies, mut tints, mut count) = (self.bodies, self.tints, self.count);
        if let Some(p) = self.pointer {
            // faint cool presence-mass: the gas leans toward the operator
            let n = count as usize;
            if n < MAX_BODIES {
                bodies[n] = [p[0], p[1], 0.20, 0.0];
                tints[n] = [0.42, 0.50, 0.72, 0.0];
                count += 1.0;
            }
        }
        // PHYSICAL pixels — gl_FragCoord lives in physical space; logical size here
        // shears every organ off-center on HiDPI (found via self-photograph receipt)
        let [pw, ph] = screen.size_in_pixels;
        let u = Uniforms {
            res: [pw as f32, ph as f32, self.time, count],
            bodies,
            tints,
            mood: self.mood,
            bias: self.bias,
            pulse: self.pulse,
            cam: self.cam,
        };
        queue.write_buffer(&r.uniform_buf, 0, bytemuck::bytes_of(&u));

        // offscreen chain sized to the physical surface
        let [w, h] = screen.size_in_pixels;
        r.ensure_tex(device, w, h);
        let t = r.tex.as_ref().expect("post textures");

        fn begin<'a>(
            encoder: &'a mut wgpu::CommandEncoder,
            view: &wgpu::TextureView,
            label: &str,
        ) -> wgpu::RenderPass<'a> {
            encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some(label),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            })
        }

        // 0 — the FIELD renders at HALF-RES (smooth gas, invisible upscale)
        {
            let mut rp = begin(encoder, &t.f_view, "field-half");
            rp.set_bind_group(0, &r.bind_group, &[]);
            rp.set_pipeline(&r.pipeline);
            rp.draw(0..3, 0..1);
        }
        // 1 — razor particles + THE CITRUS at FULL RES (the wedges must cut;
        // RENDER 61-84 headroom pays for the heart's return)
        {
            let mut rp = begin(encoder, &t.a_view, "scene-hdr");
            rp.set_bind_group(0, &r.bind_group, &[]);
            rp.set_pipeline(&r.web_pipeline);
            rp.draw(0..6, 0..WEB_PARTICLES);
            rp.set_pipeline(&r.core_pipeline);
            rp.draw(0..3, 0..1);
        }
        // 2 — bright-pass + horizontal gaussian into half-res
        {
            let mut rp = begin(encoder, &t.b0_view, "bloom-h");
            rp.set_pipeline(&r.bright_pipe);
            rp.set_bind_group(0, &t.bg_bright, &[]);
            rp.draw(0..3, 0..1);
        }
        // 3 — vertical gaussian
        {
            let mut rp = begin(encoder, &t.b1_view, "bloom-v");
            rp.set_pipeline(&r.blurv_pipe);
            rp.set_bind_group(0, &t.bg_blurv, &[]);
            rp.draw(0..3, 0..1);
        }

        // ── SELF-PHOTOGRAPH (S key): composite -> Rgba8 -> readback -> PNG receipt ──
        if SHOT_REQUESTED.swap(false, Ordering::Relaxed) {
            let shot_tex = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("shot"),
                size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8UnormSrgb,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
                view_formats: &[],
            });
            let shot_view = shot_tex.create_view(&wgpu::TextureViewDescriptor::default());
            let bpr = ((w * 4 + 255) / 256) * 256; // COPY_BYTES_PER_ROW_ALIGNMENT
            let buf = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("shot-buf"),
                size: (bpr * h) as u64,
                usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                mapped_at_creation: false,
            });
            let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("shot-enc") });
            {
                let mut rp = begin(&mut enc, &shot_view, "composite-shot");
                rp.set_pipeline(&r.comp_shot_pipe);
                rp.set_bind_group(0, &t.bg_comp, &[]);
                rp.draw(0..3, 0..1);
            }
            enc.copy_texture_to_buffer(
                wgpu::ImageCopyTexture {
                    texture: &shot_tex,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::ImageCopyBuffer {
                    buffer: &buf,
                    layout: wgpu::ImageDataLayout {
                        offset: 0,
                        bytes_per_row: Some(bpr),
                        rows_per_image: Some(h),
                    },
                },
                wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
            );
            queue.submit([enc.finish()]);
            let slice = buf.slice(..);
            slice.map_async(wgpu::MapMode::Read, |_| {});
            device.poll(wgpu::Maintain::Wait);
            let data = slice.get_mapped_range();
            // unpad rows -> tight RGBA
            let mut rgba = Vec::with_capacity((w * h * 4) as usize);
            for row in 0..h {
                let s = (row * bpr) as usize;
                rgba.extend_from_slice(&data[s..s + (w * 4) as usize]);
            }
            drop(data);
            buf.unmap();
            let dir = std::path::Path::new(r"C:\AtomEons\Orange5\10-RECEIPTS\atomic-orange\pixel");
            let _ = std::fs::create_dir_all(dir);
            let path = dir.join(format!(
                "native-{}-p{}.png",
                chrono::Local::now().format("%Y-%m-%d_%H%M%S"),
                self.preset_id
            ));
            if let Ok(f) = std::fs::File::create(&path) {
                let mut png = png::Encoder::new(std::io::BufWriter::new(f), w, h);
                png.set_color(png::ColorType::Rgba);
                png.set_depth(png::BitDepth::Eight);
                if let Ok(mut wtr) = png.write_header() {
                    let _ = wtr.write_image_data(&rgba);
                }
                eprintln!("PIXEL_RECEIPT_NATIVE: {}", path.display());
            }
        }
        Vec::new()
    }

    fn paint(
        &self,
        _info: egui::PaintCallbackInfo,
        render_pass: &mut wgpu::RenderPass<'static>,
        resources: &egui_wgpu::CallbackResources,
    ) {
        // composite: HDR scene + bloom + god-rays + ACES -> swapchain
        let r: &FieldResources = resources.get().expect("field resources");
        if let Some(t) = r.tex.as_ref() {
            render_pass.set_pipeline(&r.comp_pipe);
            render_pass.set_bind_group(0, &t.bg_comp, &[]);
            render_pass.draw(0..3, 0..1);
        }
    }
}

struct AtomicOrange {
    start: std::time::Instant,
    /// state-atlas index into PRESETS (keys 1–5 select, [ ] cycle)
    preset: usize,
    /// pending auto-photograph (fires ~10s after launch + 1.5s after state change)
    auto_shot_at: Option<std::time::Instant>,
    last_preset: usize,
    /// the operations brain — orders, projects, completions, receipts, recall
    ops: ops::Ops,
    /// the command capsule text ("order the universe…")
    order_text: String,
    /// completion/creation surge — the organism flares with real work, then calms
    surge: f32,
    /// GTD dive: Some(project idx) = 10k ft, its TASKS become the constellation
    focus: Option<usize>,
    /// completion shockwave origin + birth time (the earned fast motion)
    bloom: Option<(f32, f32, std::time::Instant)>,
    /// measured frame rate (EMA) — an honest live vital
    fps: f32,
    /// TIME MACHINE: Some(journal idx) = viewing the past; None = LIVE
    scrub: Option<usize>,
    /// living camera, eased: offx, offy, zoom
    cam_s: [f32; 3],
    /// the voice (M toggles; off by default)
    voice: audio::Engine,
    /// N8 heartbeat — background probe of OrangeBrain; vitals flip live automatically
    gw: gateway::Gateway,
    gw_last: bool,
    /// U1 mode engine — derived semantic state + its real-signal timers
    mode: Mode,
    thinking_until: Option<std::time::Instant>,
    alert_until: Option<std::time::Instant>,
    analyzing_until: Option<std::time::Instant>,
    generating_until: Option<std::time::Instant>,
    /// U2 real chat — the command dock speaks to the LIVE brain through the seam.
    /// (user?, text) pairs, bounded; receiver present = a REAL request in flight.
    chat: Vec<(bool, String)>,
    chat_rx: Option<std::sync::mpsc::Receiver<Result<String, String>>>,
    /// N9 AUTOPILOT — OFF by default (Human Final Stop honest). `A` arms it: the
    /// organism takes the runway task to the LIVE brain, writes the deliverable
    /// as a REAL artifact file, completes the task, rests 45s, takes the next.
    /// Any brain error = fail-stop, never a silent retry loop.
    autopilot: bool,
    /// a real autopilot request in flight: (project, task, brain result)
    auto_rx: Option<std::sync::mpsc::Receiver<(String, String, Result<String, String>)>>,
    /// the rest gate between completions — the calm pace
    auto_next_at: Option<std::time::Instant>,
    /// THE COMPOSER — the baby viz LLM, the operator's original orchestration
    /// concept: a painter of data, AESTHETICS ONLY. Reads a live digest every
    /// ~40s through the one seam (Beelink heavy tier), returns strict JSON
    /// direction (energy/rings/bias/zoom + painter's note). Truth-driven modes
    /// outrank it; 3 bad replies → dormant; V toggles. It can never break truth.
    composer_on: bool,
    comp_rx: Option<std::sync::mpsc::Receiver<Result<String, String>>>,
    comp_next_at: Option<std::time::Instant>,
    comp_fails: u8,
    /// composer targets + eased state: [energy, ring, bias r,g,b, zoom, tempo]
    comp_t: [f32; 7],
    comp_s: [f32; 7],
    /// operator's hand on the atlas dial — the conductor yields to it for 120s
    manual_preset_at: Option<std::time::Instant>,
    /// the conductor's memory of its own brushwork (last 3 paintings) — fed
    /// back into each digest so the session develops an ARC, not repetition
    comp_notes: Vec<String>,
    /// the newest receipt files on disk (real fs listing, ~10s refresh)
    rcpt_tail: Vec<String>,
    /// the newest ARTIFACTS the organism actually produced (autopilot output)
    artifacts: Vec<String>,
    /// THE ARRIVAL — when something REAL last landed (receipt, brain waking,
    /// artifact, order, completion). The shooting stars ride this, not a timer:
    /// light crosses the sky only when the world actually changed.
    arrival: Option<std::time::Instant>,
    /// the conductor's EYE — one real project it chose to feature (validated
    /// against actual names; emphasis only, the human dive always outranks)
    comp_feature: Option<String>,
    /// TALK MODE (U2, unparked 2026-07-28): the capsule asks instead of orders.
    /// Parked while the operator said visuals first; unparked because he added a
    /// navigator tier whose stated purpose is "ordinary chat enters through
    /// Navigator" — that lane was built for exactly this. Session-only.
    talk: bool,
    /// the lane the organism ACTUALLY used last ("heavy" / "navigator") —
    /// shared so worker threads can stamp it as they fire
    last_lane: std::sync::Arc<std::sync::Mutex<String>>,
    /// the biography that survives death (persisted ~10s)
    soul: Soul,
    last_verdict: String,
    /// instrument telemetry — MEASURED series only (no fake green)
    sys: sysinfo::System,
    cpu_hist: Vec<f32>,
    /// WHO IS EATING THE BOX. The CPU gauge read 100 and I concluded this app
    /// was pegging the N150 — so I built a frame governor to make it yield.
    /// Then I MEASURED it: `TotalProcessorTime` delta over 6s put this app at
    /// **0.3% of 4 cores**. It was never the load; Claude Code and three ChatGPT
    /// windows were. The governor was solving a fiction, and worse, it printed
    /// "yield" while still running a full 60 — a false claim on the operator's
    /// glass, which is the one thing this surface may never do.
    /// The gauge was right all along. What it could not say was WHO, and who is
    /// the actionable half: "make sure my mini box isnt maxed to hard" is
    /// answered by a name, not a number. So the number keeps its meaning and
    /// gains the culprit. Sampled every ~3s — process enumeration is far
    /// heavier than the other vitals and does not deserve frame cadence.
    top_proc: Option<(String, f32)>,
    mem_frac: f32,
    fps_hist: Vec<f32>,
    gw_hist: Vec<f32>,
    /// live tier map from the gateway /v1/models: (lane, host, live) — 31s poll
    tiers: std::sync::Arc<std::sync::Mutex<Vec<(String, String, bool)>>>,
    /// the real GPU driving the organism (wgpu adapter, read once at birth)
    gpu_name: String,
    /// AI-box truth from codexa ollama /api/ps: Some((models loaded, vram GB))
    /// or None = box didn't answer the last poll (shown honestly)
    codexa: std::sync::Arc<std::sync::Mutex<Option<(usize, f32)>>>,
    /// full AI-box vitals when the codexa stats agent is deployed on :8799
    codexa_stats: std::sync::Arc<std::sync::Mutex<Option<CxStats>>>,
    /// local network truth (sysinfo) — cumulative counters + computed rates
    nets: sysinfo::Networks,
    net_prev: (u64, u64),
    net_at: std::time::Instant,
    net_rate: (f32, f32), // rx, tx bytes/sec
    /// local disk truth — the boot-overload armor reads these
    disks: sysinfo::Disks,
    /// frame counter for slow polls (estate awareness ~5s)
    frame_i: u64,
}

impl AtomicOrange {
    fn new(cc: &eframe::CreationContext<'_>) -> Self {
        // TYPOGRAPHY — thin technical type from the machine's OWN installed
        // fonts (runtime-loaded, nothing redistributed; silent fallback to
        // egui defaults when a face is absent)
        let mut fonts = egui::FontDefinitions::default();
        for (name, paths, fam) in [
            (
                "aelid-sans",
                // REGULAR weight leads: Semilight washed out at small sizes
                // (operator's 10/1000 — legibility outranks thinness)
                &[
                    "C:/Windows/Fonts/segoeui.ttf",
                    "C:/Windows/Fonts/segoeuisl.ttf",
                ][..],
                egui::FontFamily::Proportional,
            ),
            (
                "aelid-mono",
                &[
                    "C:/Windows/Fonts/CascadiaMono.ttf",
                    "C:/Windows/Fonts/CascadiaCode.ttf",
                    "C:/Windows/Fonts/consola.ttf",
                ][..],
                egui::FontFamily::Monospace,
            ),
        ] {
            for p in paths {
                if let Ok(bytes) = std::fs::read(p) {
                    fonts
                        .font_data
                        .insert(name.to_string(), egui::FontData::from_owned(bytes));
                    if let Some(list) = fonts.families.get_mut(&fam) {
                        list.insert(0, name.to_string());
                    }
                    break;
                }
            }
        }
        cc.egui_ctx.set_fonts(fonts);

        let rs = cc
            .wgpu_render_state
            .as_ref()
            .expect("wgpu render state (eframe wgpu feature)");
        let device = &rs.device;

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("galaxy-field"),
            source: wgpu::ShaderSource::Wgsl(include_str!("field.wgsl").into()),
        });

        let uniform_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("field-uniforms"),
            size: std::mem::size_of::<Uniforms>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("field-bgl"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });

        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("field-bg"),
            layout: &bgl,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform_buf.as_entire_binding(),
            }],
        });

        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("field-layout"),
            bind_group_layouts: &[&bgl],
            push_constant_ranges: &[],
        });

        // one descriptor factory — organs target HDR; post targets vary
        let make = |shader: &wgpu::ShaderModule,
                    entry: &str,
                    lay: &wgpu::PipelineLayout,
                    fmt: wgpu::TextureFormat,
                    blend: Option<wgpu::BlendState>,
                    label: &str| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(label),
                layout: Some(lay),
                vertex: wgpu::VertexState {
                    module: shader,
                    entry_point: "vs_main",
                    buffers: &[],
                    compilation_options: Default::default(),
                },
                fragment: Some(wgpu::FragmentState {
                    module: shader,
                    entry_point: entry,
                    targets: &[Some(wgpu::ColorTargetState {
                        format: fmt,
                        blend,
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                    compilation_options: Default::default(),
                }),
                primitive: wgpu::PrimitiveState::default(),
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                multiview: None,
                cache: None,
            })
        };

        let web_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("living-web"),
            source: wgpu::ShaderSource::Wgsl(include_str!("web.wgsl").into()),
        });
        let core_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("orange-core"),
            source: wgpu::ShaderSource::Wgsl(include_str!("core.wgsl").into()),
        });
        let post_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("post-chain"),
            source: wgpu::ShaderSource::Wgsl(include_str!("post.wgsl").into()),
        });

        let additive = wgpu::BlendState {
            color: wgpu::BlendComponent {
                src_factor: wgpu::BlendFactor::One,
                dst_factor: wgpu::BlendFactor::One,
                operation: wgpu::BlendOperation::Add,
            },
            alpha: wgpu::BlendComponent {
                src_factor: wgpu::BlendFactor::One,
                dst_factor: wgpu::BlendFactor::One,
                operation: wgpu::BlendOperation::Add,
            },
        };

        // scene organs render into the HDR target
        let pipeline = make(&shader, "fs_main", &layout, HDR_FMT, Some(wgpu::BlendState::REPLACE), "field-pipeline");
        let web_pipeline = make(&web_shader, "fs_main", &layout, HDR_FMT, Some(additive), "web-pipeline");
        let core_pipeline = make(&core_shader, "fs_main", &layout, HDR_FMT, Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING), "core-pipeline");

        // post: tex+sampler layouts
        let tex_entry = |binding: u32| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        };
        let samp_entry = wgpu::BindGroupLayoutEntry {
            binding: 1,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
            count: None,
        };
        let post1_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("post1-bgl"),
            entries: &[tex_entry(0), samp_entry],
        });
        let post2_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("post2-bgl"),
            entries: &[
                tex_entry(0),
                samp_entry,
                tex_entry(2),
                // the uniform bridge reaches the composite (grain time, shock flash)
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                tex_entry(4), // half-res field
            ],
        });
        let post1_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("post1-layout"),
            bind_group_layouts: &[&post1_bgl],
            push_constant_ranges: &[],
        });
        let post2_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("post2-layout"),
            bind_group_layouts: &[&post2_bgl],
            push_constant_ranges: &[],
        });

        let bright_pipe = make(&post_shader, "fs_bright_h", &post1_layout, HDR_FMT, None, "bright-h");
        let blurv_pipe = make(&post_shader, "fs_blur_v", &post1_layout, HDR_FMT, None, "blur-v");
        let comp_pipe = make(&post_shader, "fs_composite", &post2_layout, rs.target_format, None, "composite");
        let comp_shot_pipe = make(&post_shader, "fs_composite", &post2_layout, wgpu::TextureFormat::Rgba8UnormSrgb, None, "composite-shot");

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("post-sampler"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            ..Default::default()
        });

        // the organism knows its own body — real adapter identity, read once
        let gpu_name = {
            let n = rs.adapter.get_info().name;
            if n.len() > 26 { n[..26].to_string() } else { n }
        };
        // MODEL ROUTING + AI-BOX truth: poll gateway tier map + codexa ollama
        // /api/ps on a quiet thread (mDNS may stall — contained here, never UI)
        let tiers: std::sync::Arc<std::sync::Mutex<Vec<(String, String, bool)>>> =
            Default::default();
        let codexa: std::sync::Arc<std::sync::Mutex<Option<(usize, f32)>>> =
            Default::default();
        let codexa_stats: std::sync::Arc<std::sync::Mutex<Option<CxStats>>> =
            Default::default();
        {
            let t = tiers.clone();
            let cx = codexa.clone();
            let cs = codexa_stats.clone();
            // THE LOCAL PROXY, not the name. CODEXA.local advertises two DEAD
            // IPv4 records plus one live IPv6 link-local (measured 2026-07-28:
            // 10.0.99.1 and 10.0.0.4 both black-hole at 6s; the name answers in
            // 190ms only because Node races both stacks). Rust's ureq tries
            // addresses IN ORDER, so it hits a dead IPv4 first and gives up —
            // which is why this panel read "CODEXA no answer" while the gateway
            // reported the same box LIVE. The host proxy is Node, resolves
            // correctly, and is already running on 11435.
            let cx_url = std::env::var("ORANGE5_CODEXA_OLLAMA_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:11435".into());
            // EXPLICIT, not derived. This used to be cx_url.replace(":11434",
            // ":8799") — the moment cx_url moved to the 11435 host proxy that
            // replace matched nothing and silently produced 11435/stats, an
            // address that serves ollama, not the agent. A derivation that
            // fails SILENTLY when its input changes is worse than a constant.
            let stats_url = std::env::var("ORANGE5_CODEXA_STATS_URL")
                .unwrap_or_else(|_| "http://CODEXA.local:8799/stats".into());
            std::thread::spawn(move || loop {
                let mut out: Vec<(String, String, bool)> = Vec::new();
                if let Ok(r) = ureq::get("http://127.0.0.1:1337/v1/models")
                    .timeout(std::time::Duration::from_secs(4))
                    .call()
                {
                    if let Ok(v) = r.into_json::<serde_json::Value>() {
                        if let Some(arr) = v["data"].as_array() {
                            for m in arr {
                                out.push((
                                    m["ae_lane"].as_str().unwrap_or("?").to_string(),
                                    m["ae_host"].as_str().unwrap_or("?").to_string(),
                                    m["ae_upstream"]["status"].as_str() == Some("live"),
                                ));
                            }
                        }
                    }
                }
                if let Ok(mut g) = t.lock() {
                    *g = out;
                }
                // the AI box itself: loaded models + VRAM in use (nvidia mirror v1)
                let ps: Option<(usize, f32)> = ureq::get(&format!("{cx_url}/api/ps"))
                    .timeout(std::time::Duration::from_secs(5))
                    .call()
                    .ok()
                    .and_then(|r| r.into_json::<serde_json::Value>().ok())
                    .and_then(|v| {
                        v["models"].as_array().map(|arr| {
                            let vram: u64 = arr
                                .iter()
                                .map(|m| m["size_vram"].as_u64().unwrap_or(0))
                                .sum();
                            (arr.len(), vram as f32 / 1_073_741_824.0)
                        })
                    });
                if let Ok(mut g) = cx.lock() {
                    *g = ps;
                }
                // full box vitals when the stats agent is deployed (:8799)
                let stats: Option<CxStats> = ureq::get(&stats_url)
                    .timeout(std::time::Duration::from_secs(5))
                    .call()
                    .ok()
                    .and_then(|r| r.into_json::<serde_json::Value>().ok())
                    .map(|v| {
                        let gpu = v["gpu"].as_object().map(|g| {
                            let f = |k: &str| g.get(k).and_then(|x| x.as_f64()).unwrap_or(0.0) as f32;
                            (f("util_pct"), f("vram_used_mb"), f("vram_total_mb"), f("temp_c"))
                        });
                        let disks = v["disks"]
                            .as_array()
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(|d| {
                                        let total = d["total_gb"].as_f64().unwrap_or(0.0) as f32;
                                        if total <= 1.0 {
                                            return None;
                                        }
                                        let free = d["free_gb"].as_f64().unwrap_or(0.0) as f32;
                                        Some((
                                            d["mount"].as_str().unwrap_or("?").to_string(),
                                            free,
                                            free / total,
                                        ))
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();
                        CxStats {
                            cpu: v["cpu_pct"].as_f64().unwrap_or(-1.0) as f32,
                            mem_free: v["mem_free_gb"].as_f64().unwrap_or(0.0) as f32,
                            mem_total: v["mem_total_gb"].as_f64().unwrap_or(0.0) as f32,
                            gpu,
                            disks,
                        }
                    });
                if let Ok(mut g) = cs.lock() {
                    *g = stats;
                }
                std::thread::sleep(std::time::Duration::from_secs(31));
            });
        }

        rs.renderer.write().callback_resources.insert(FieldResources {
            pipeline,
            web_pipeline,
            core_pipeline,
            bind_group,
            uniform_buf,
            bright_pipe,
            blurv_pipe,
            comp_pipe,
            comp_shot_pipe,
            sampler,
            post1_bgl,
            post2_bgl,
            tex: None,
        });

        // THE SOUL wakes — biography from the last life, or a first breath
        let soul: Soul = std::fs::read_to_string(soul_path())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let composer_on0 = if soul.session_count > 0 { soul.composer_on } else { true };
        let life = soul.session_count + 1;
        let mut ops0 = ops::Ops::load();
        if soul.session_count > 0 {
            ops0.event(
                &format!(
                    "awake — life {life} · last verdict: {}",
                    if soul.last_verdict.is_empty() { "unwritten" } else { soul.last_verdict.as_str() }
                ),
                1,
            );
        }
        let soul = Soul { session_count: life, ..soul };

        Self {
            start: std::time::Instant::now(),
            // ORANGE5_PRESET opens the organism directly in an atlas seat. Not a
            // toy: surfaces like the agent queue, living canvas and temporal
            // strip only exist in certain rooms, and keystroke injection does not
            // land in headless runs — so those states were UNVERIFIABLE and one
            // of them shipped a collision. A state you cannot reach is a state
            // you cannot check.
            preset: std::env::var("ORANGE5_PRESET").ok().and_then(|s| s.parse().ok()).unwrap_or(soul.preset),
            auto_shot_at: Some(std::time::Instant::now() + std::time::Duration::from_secs(10)),
            last_preset: soul.preset,
            ops: ops0,
            order_text: String::new(),
            // the waking stretch — a real event (rebirth) earns a brief flare
            surge: if life > 1 { 0.6 } else { 0.0 },
            focus: None,
            bloom: None,
            fps: 0.0,
            scrub: None,
            frame_i: 0,
            cam_s: [0.0, 0.0, 1.0],
            voice: audio::Engine::new(),
            gw: gateway::Gateway::start(),
            gw_last: false,
            mode: Mode::Calm,
            thinking_until: None,
            alert_until: None,
            analyzing_until: None,
            generating_until: None,
            chat: Vec::new(),
            chat_rx: None,
            // ARMED AT BIRTH only when the operator explicitly asks via env —
            // Human Final Stop intact (off by default, A still toggles), but the
            // loop becomes provable without SendKeys, which needs a foregrounded
            // window and silently no-ops in a headless run. Three proof attempts
            // were lost to a keystroke that never arrived.
            autopilot: std::env::var("ORANGE5_AUTOPILOT").is_ok(),
            auto_rx: None,
            auto_next_at: None,
            composer_on: composer_on0,
            comp_rx: None,
            comp_next_at: None,
            comp_fails: 0,
            comp_t: [1.0, 1.0, 0.0, 0.0, 0.0, 1.0, 1.0],
            comp_s: [1.0, 1.0, 0.0, 0.0, 0.0, 1.0, 1.0],
            manual_preset_at: None,
            comp_notes: soul.comp_notes.clone(),
            rcpt_tail: Vec::new(),
            artifacts: Vec::new(),
            arrival: None,
            comp_feature: soul.comp_feature.clone(),
            talk: false,
            last_lane: Default::default(),
            soul,
            last_verdict: String::new(),
            sys: sysinfo::System::new(),
            cpu_hist: Vec::new(),
            top_proc: None,
            mem_frac: 0.0,
            fps_hist: Vec::new(),
            gw_hist: Vec::new(),
            tiers,
            gpu_name,
            codexa,
            codexa_stats,
            nets: sysinfo::Networks::new_with_refreshed_list(),
            net_prev: (0, 0),
            net_at: std::time::Instant::now(),
            net_rate: (0.0, 0.0),
            disks: sysinfo::Disks::new_with_refreshed_list(),
        }
    }

    /// U2 — speak to the LIVE brain through the one legal seam. Non-blocking:
    /// the request flies on its own thread; THINKING mode holds while it's real.
    fn send_chat(&mut self, prompt: String) {
        let (tx, rx) = std::sync::mpsc::channel();
        self.chat.push((true, prompt.clone()));
        if self.chat.len() > 12 {
            let n = self.chat.len() - 12;
            self.chat.drain(0..n);
        }
        self.chat_rx = Some(rx);
        if let Ok(mut l) = self.last_lane.lock() { *l = "navigator".into(); }
        self.ops.event("order spoken — the brain is thinking", 0);
        std::thread::spawn(move || {
            // NAVIGATOR — the operator's own routing law: "Ordinary chat enters
            // through Navigator." Conversation is not deliverable work, so it
            // does not belong in the heavy lane where a task is being built.
            let body = serde_json::json!({
                "model": "orange-navigator-4b",
                "messages": [
                    {"role": "system", "content": "You are OrangeBrain, the living intelligence of Atomic Orange — the operator's sovereign command organism. Answer briefly, truthfully, and directly. Never invent system state: if you are asked something only the instruments know, say so."},
                    {"role": "user", "content": prompt}
                ]
            });
            let res = ureq::post("http://127.0.0.1:1337/v1/chat/completions")
                .timeout(std::time::Duration::from_secs(120))
                .send_json(body);
            let out = match res {
                Ok(r) => match r.into_json::<serde_json::Value>() {
                    Ok(v) => v["choices"][0]["message"]["content"]
                        .as_str()
                        .map(|s| s.trim().to_string())
                        .ok_or_else(|| "brain replied in an unknown shape".to_string()),
                    Err(e) => Err(format!("bad reply: {e}")),
                },
                Err(e) => Err(format!("brain unreachable: {e}")),
            };
            let _ = tx.send(out);
        });
    }
}

const ORANGE: egui::Color32 = egui::Color32::from_rgb(255, 122, 26);
const CYAN_V: egui::Color32 = egui::Color32::from_rgb(90, 200, 255);
const BONE: egui::Color32 = egui::Color32::from_rgb(246, 242, 235);
const MUTED: egui::Color32 = egui::Color32::from_rgb(143, 135, 128);
const DIMC: egui::Color32 = egui::Color32::from_rgb(95, 89, 82);
const GREEN: egui::Color32 = egui::Color32::from_rgb(119, 209, 124);
const RED: egui::Color32 = egui::Color32::from_rgb(255, 93, 86);

/// NO BOXES (operator law): what was glass is now open space — content floats
/// on the stage; legibility comes from soft atmospheric halos, never a card
fn glass() -> egui::Frame {
    egui::Frame::none().inner_margin(egui::Margin::same(12.0))
}

// THEME LAW (operator, 2026-07-19: "remove o theme"): the interface chrome is
// BLUE — orange appears ONLY where it is DATA (building states, the runway,
// work counts). The color of work, never decoration.
fn hud_label(ui: &mut egui::Ui, text: &str) {
    ui.label(egui::RichText::new(text).color(CYAN_V).size(10.0).strong());
}

fn hud_kv(ui: &mut egui::Ui, k: &str, v: &str, c: egui::Color32) {
    ui.vertical(|ui| {
        ui.label(egui::RichText::new(k).color(CYAN_V).size(9.0).strong());
        ui.label(egui::RichText::new(v).color(c).size(12.0).monospace().strong());
    });
}

/// bytes/sec → human rate (measured network truth, compact)
fn fmt_rate(bps: f32) -> String {
    if bps >= 1_048_576.0 {
        format!("{:.1} MB/s", bps / 1_048_576.0)
    } else if bps >= 1024.0 {
        format!("{:.0} KB/s", bps / 1024.0)
    } else {
        format!("{bps:.0} B/s")
    }
}

impl eframe::App for AtomicOrange {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        let t = self.start.elapsed().as_secs_f32();

        // ── STATE ATLAS dial: 1–5 select, [ ] cycle (operator architecture) ──
        let mut manual_dial = false;
        ctx.input(|i| {
            use egui::Key;
            for (k, n) in [(Key::Num1, 0), (Key::Num2, 1), (Key::Num3, 2), (Key::Num4, 3), (Key::Num5, 4)] {
                if i.key_pressed(k) { self.preset = n; manual_dial = true; }
            }
            let atlas_n = presets::all().len();
            if i.key_pressed(Key::CloseBracket) { self.preset = (self.preset + 1) % atlas_n; manual_dial = true; }
            if i.key_pressed(Key::OpenBracket) { self.preset = (self.preset + atlas_n - 1) % atlas_n; manual_dial = true; }
            if i.key_pressed(Key::S) { SHOT_REQUESTED.store(true, Ordering::Relaxed); }
        });
        if manual_dial {
            // the human took the atlas dial — the conductor yields (120s)
            self.manual_preset_at = Some(std::time::Instant::now());
        }
        // C completes the runway task (only when not typing an order)
        let typing = ctx.memory(|m| m.focused().is_some());
        // M — the voice (mindrest chord; state = real portfolio)
        if !typing && ctx.input(|i| i.key_pressed(egui::Key::M)) {
            let on = self.voice.toggle();
            self.ops.event(if on { "voice on — the portfolio hums" } else { "voice off" }, 0);
        }
        let vn = self.ops.projects.len().max(1) as f32;
        // the voice tells the truth like every other organ: its tension channel
        // (a 4.5Hz beat against partial 5) now rides REAL held work — the
        // engine has carried this capability all night with 0.0 fed into it
        self.voice.set(audio::Chord {
            building: self.ops.projects.iter().filter(|p| p.state == PState::Building).count() as f32 / vn,
            blocked: (self.ops.holds() as f32 / vn).clamp(0.0, 1.0),
            done: self.ops.completes() as f32 / vn,
            surge: self.surge,
        });
        // T — TALK: the command capsule switches between ORDERING (an idea
        // becomes a project) and ASKING (the navigator answers). One input, two
        // intents, never ambiguous — the mode is stated in the hint text.
        if !typing && ctx.input(|i| i.key_pressed(egui::Key::T)) {
            self.talk = !self.talk;
            self.ops.event(
                if self.talk { "talk mode — the capsule asks the navigator" } else { "order mode — the capsule builds projects" },
                0,
            );
        }
        // V — the COMPOSER toggle (painter of data; aesthetics only)
        if !typing && ctx.input(|i| i.key_pressed(egui::Key::V)) {
            self.composer_on = !self.composer_on;
            if self.composer_on {
                self.comp_fails = 0;
                self.comp_next_at = Some(std::time::Instant::now() + std::time::Duration::from_secs(2));
                self.ops.event("conductor awake — painting from live data", 1);
            } else {
                self.comp_t = [1.0, 1.0, 0.0, 0.0, 0.0, 1.0, 1.0];
                self.ops.event("conductor off — deterministic skeleton drives", 0);
            }
        }
        // A — N9 AUTOPILOT toggle (Human Final Stop: one key arms, one key stops)
        if !typing && ctx.input(|i| i.key_pressed(egui::Key::A)) {
            self.autopilot = !self.autopilot;
            if self.autopilot {
                self.ops.event("AUTOPILOT ARMED — organism works its runway", 1);
                self.auto_next_at =
                    Some(std::time::Instant::now() + std::time::Duration::from_secs(2));
            } else {
                self.ops.event("autopilot off — human has the stick", 0);
                self.auto_next_at = None;
            }
        }
        if !typing && self.scrub.is_none() && ctx.input(|i| i.key_pressed(egui::Key::C)) {
            let target = self.ops.next_action().map(|(pi, _)| pi);
            if self.ops.complete_next().is_some() {
                self.surge = (self.surge + 0.9).min(1.6); // the earned flare
                self.arrival = Some(std::time::Instant::now()); // work landed
                // shockwave born at the completed project's mass
                if let Some(pi) = target {
                    let sr = ctx.screen_rect();
                    let (sx, sy) = SLOTS[self.ops.projects[pi].slot.min(SLOTS.len() - 1)];
                    let (bx, by) = stage_frac(sx, sy, sr.width(), sr.height());
                    self.bloom = Some((bx, by, std::time::Instant::now()));
                }
            }
        }
        // GTD dive: Enter falls into the runway project — its tasks become the sky.
        // Esc ascends to the 20k portfolio.
        if !typing && ctx.input(|i| i.key_pressed(egui::Key::Enter)) {
            self.focus = self.ops.next_action().map(|(pi, _)| pi).or(if self.ops.projects.is_empty() { None } else { Some(0) });
        }
        if ctx.input(|i| i.key_pressed(egui::Key::Escape)) {
            self.focus = None;
        }
        if let Some(f) = self.focus {
            if f >= self.ops.projects.len() { self.focus = None; }
        }
        self.surge *= 0.985; // work-heat decays like body heat
        // N8: gateway state transitions are real feed events
        let gw_live = self.gw.live();
        if gw_live != self.gw_last {
            self.gw_last = gw_live;
            self.ops.event(
                if gw_live { "OrangeBrain ALIVE — gateway answering" } else { "gateway lost" },
                if gw_live { 1 } else { 2 },
            );
            self.surge = (self.surge + 0.6).min(1.6);
            let now = std::time::Instant::now();
            if gw_live {
                self.arrival = Some(now);   // the brain arriving is an arrival
                // brain arrived: the organism studies its new capabilities
                self.alert_until = None;
                self.analyzing_until = Some(now + std::time::Duration::from_secs(3));
            } else {
                // a REAL causal event: gateway lost → models gone → command disarmed
                self.alert_until = Some(now + std::time::Duration::from_secs(10));
            }
        }
        // U2: drain the brain's reply when it lands (real completion of THINKING)
        let drained = self.chat_rx.as_ref().map(|rx| rx.try_recv());
        if let Some(res) = drained {
            match res {
                Ok(Ok(reply)) => {
                    self.chat.push((false, reply));
                    if self.chat.len() > 12 {
                        let n = self.chat.len() - 12;
                        self.chat.drain(0..n);
                    }
                    self.ops.event("brain replied", 1);
                    self.surge = (self.surge + 0.4).min(1.6);
                    self.chat_rx = None;
                }
                Ok(Err(e)) => {
                    self.chat.push((false, format!("⚠ {e}")));
                    self.ops.event("chat failed — see dock", 2);
                    self.chat_rx = None;
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => {}
                Err(_) => self.chat_rx = None,
            }
        }

        // ── N9 AUTOPILOT: take the runway task to the LIVE brain, one at a time ──
        if self.autopilot
            && gw_live
            && self.auto_rx.is_none()
            && self.chat_rx.is_none()
            && self.scrub.is_none()
            && self.auto_next_at.map(|at| std::time::Instant::now() >= at).unwrap_or(true)
        {
            if let Some((pi, ti)) = self.ops.next_action() {
                let pname = self.ops.projects[pi].name.clone();
                let tname = self.ops.projects[pi].tasks[ti].name.clone();
                let (tx, rx) = std::sync::mpsc::channel();
                self.auto_rx = Some(rx);
                self.ops.event(&format!("autopilot: working — {tname}"), 0);
                if let Ok(mut l) = self.last_lane.lock() { *l = "heavy".into(); }
                std::thread::spawn(move || {
                    // HEAVY TIER (two-computer truth): deliverable work runs on the
                    // Codexa Beelink — the N150's 16GB cannot absorb a model load
                    // (proven: silent OOM death on the light tier, 2026-07-17).
                    // ID MUST MATCH THE GATEWAY CONTRACT: ids not starting with
                    // "orangellm-"/"orange-navigator" are rewritten to the 4b
                    // navigator, which would silently downgrade real deliverable
                    // work. "orangellm-heavy" survives the rewrite AND matches
                    // the /heavy|fatty/ tier test.
                    let body = serde_json::json!({
                        "model": "orangellm-heavy",
                        "messages": [
                            {"role": "system", "content": "You are OrangeBrain, the working intelligence of Atomic Orange. Produce the requested deliverable directly — concise, concrete, truthful markdown, max 300 words. No preamble. /no_think"},
                            {"role": "user", "content": format!("Project: {pname}. Task: {tname}. Produce the deliverable for this task now; it will be saved as a real artifact file.")}
                        ]
                    });
                    let res = ureq::post("http://127.0.0.1:1337/v1/chat/completions")
                        .timeout(std::time::Duration::from_secs(210))
                        .send_json(body);
                    let out = match res {
                        Ok(r) => match r.into_json::<serde_json::Value>() {
                            Ok(v) => v["choices"][0]["message"]["content"]
                                .as_str()
                                .map(|s| s.trim().to_string())
                                .ok_or_else(|| "brain replied in an unknown shape".to_string()),
                            Err(e) => Err(format!("bad reply: {e}")),
                        },
                        // 504 heavy_probe_timeout: the gateway never LEARNED the
                        // route (mDNS stall) — that is not the brain refusing, it
                        // is the brain not answering yet. Transient, so the work
                        // is retried instead of standing the autopilot down.
                        Err(ureq::Error::Status(504, _)) => {
                            Err("RETRY: brain route stalled (504)".to_string())
                        }
                        Err(e) => Err(format!("brain unreachable: {e}")),
                    };
                    let _ = tx.send((pname, tname, out));
                });
            } else {
                // runway clear — the autopilot stands down honestly
                self.autopilot = false;
                self.ops.event("autopilot: runway clear — standing down", 1);
            }
        }
        // drain the autopilot's completed work: artifact → complete → shockwave → rest
        let auto_drained = self.auto_rx.as_ref().map(|rx| rx.try_recv());
        if let Some(res) = auto_drained {
            match res {
                Ok((pname, tname, Ok(content))) => {
                    self.auto_rx = None;
                    // strip a leading <think> block if the reflex model emits one
                    let clean = match (content.find("<think>"), content.find("</think>")) {
                        (Some(a), Some(b)) if b > a => {
                            format!("{}{}", &content[..a], &content[b + 8..]).trim().to_string()
                        }
                        _ => content.trim().to_string(),
                    };
                    let path = self.ops.artifact(&pname, &tname, &clean);
                    let short = path.rsplit('/').next().unwrap_or(&path).to_string();
                    // feed shows the slug, not the 20-char timestamp prefix
                    let disp = if short.len() > 20 { &short[20..] } else { &short[..] };
                    if self.ops.complete_named(&pname, &tname) {
                        self.ops.event(&format!("autopilot: artifact {disp}"), 1);
                        self.surge = (self.surge + 0.9).min(1.6);
                        self.generating_until =
                            Some(std::time::Instant::now() + std::time::Duration::from_secs(2));
                        // shockwave born at the worked project's seat
                        if let Some(p) = self.ops.projects.iter().find(|p| p.name == pname) {
                            let sr = ctx.screen_rect();
                            let (sx, sy) = SLOTS[p.slot.min(SLOTS.len() - 1)];
                            let (bx, by) = stage_frac(sx, sy, sr.width(), sr.height());
                            self.bloom = Some((bx, by, std::time::Instant::now()));
                        }
                        // the eye follows the hands — worked project takes the feature
                        self.comp_feature = Some(pname.clone());
                        self.arrival = Some(std::time::Instant::now()); // artifact landed
                    } else {
                        // task vanished mid-flight (operator moved it) — artifact kept, no green claimed
                        self.ops.event(&format!("autopilot: {tname} already closed — artifact kept"), 2);
                    }
                    // rest — the calm pace between completions
                    self.auto_next_at =
                        Some(std::time::Instant::now() + std::time::Duration::from_secs(45));
                }
                Ok((_, tname, Err(e))) => {
                    self.auto_rx = None;
                    if e.starts_with("RETRY:") {
                        // TRANSIENT: the gateway could not decide a route in time.
                        // "We never learned" is not "it refused" — standing down on
                        // a stalled probe is how a working autopilot gets killed by
                        // a network hiccup. Stay armed, wait a full minute, retry.
                        self.auto_next_at =
                            Some(std::time::Instant::now() + std::time::Duration::from_secs(60));
                        self.ops.event(&format!("autopilot: brain stalled on {tname} — retry in 60s"), 2);
                    } else {
                        self.autopilot = false; // FAIL-STOP — no silent retry loop, ever
                        self.ops.event(&format!("autopilot STOPPED — {tname}: {e}"), 2);
                    }
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => {}
                Err(_) => self.auto_rx = None,
            }
        }

        // ── THE VERDICT — computed BEFORE the painter so it can know the
        // judgment; the crown wears it below (worst-first, model-free, always)
        let verdict: (String, egui::Color32) = {
            let mut disk_hot: Option<f32> = None;
            for d in self.disks.iter() {
                let tot = d.total_space() as f32;
                if tot < 1e9 { continue; }
                let fr = d.available_space() as f32 / tot;
                let gb = d.available_space() as f32 / 1_073_741_824.0;
                if (fr <= 0.12 || gb <= 30.0) && disk_hot.map(|x| fr < x).unwrap_or(true) {
                    disk_hot = Some(fr);
                }
            }
            let today = chrono::Local::now().format("%m-%d").to_string();
            let done_today = self
                .ops
                .journal
                .iter()
                .filter(|mo| mo.ts.starts_with(&today) && mo.label.starts_with("done"))
                .count();
            let amber = egui::Color32::from_rgb(255, 193, 74);
            if let Some(fr) = disk_hot {
                (format!("AT RISK — boot drive {:.0}% free", fr * 100.0), RED)
            } else if !gw_live {
                ("DARK — brain offline · skeleton holds".into(), amber)
            } else if self.mem_frac > 0.95 || (self.fps > 0.0 && self.fps < 20.0) {
                ("STARVED — machine at its edge".into(), amber)
            } else if self.gw.latency_ms().map(|m| m > 500).unwrap_or(false) {
                ("STRAINED — brain slow to answer".into(), amber)
            // BLOCKED outranks FLOWING: if every open task is waiting on someone
            // else, there is no runway left — and saying "work waits on the
            // runway" would be false comfort. This is the one state the operator
            // can do nothing about alone, so the crown must name it plainly.
            } else if self.ops.open_tasks() > 0
                && self.ops.waiting_count() >= self.ops.open_tasks()
            {
                (
                    format!("BLOCKED — all {} open tasks wait on others", self.ops.open_tasks()),
                    egui::Color32::from_rgb(255, 193, 74),
                )
            } else if self.autopilot || self.comp_rx.is_some() || done_today > 0 {
                (format!("FLOWING — {done_today} done today · estate answering"), GREEN)
            } else if self.ops.open_tasks() > 0 {
                ("HOLDING — work waits on the runway".into(), CYAN_V)
            } else {
                ("SERENE — all runways clear".into(), GREEN)
            }
        };
        self.last_verdict = verdict.0.clone();

        // ── THE COMPOSER: read the live digest, paint the mood (aesthetics only) ──
        if self.composer_on
            && gw_live
            && self.comp_rx.is_none()
            && self.auto_rx.is_none()
            && self.chat_rx.is_none()
            && self.comp_next_at.map(|at| std::time::Instant::now() >= at).unwrap_or(true)
        {
            let worst_disk = self
                .disks
                .iter()
                .filter(|d| d.total_space() > 1_000_000_000)
                .map(|d| d.available_space() as f32 / d.total_space() as f32)
                .fold(1.0f32, f32::min);
            let digest = serde_json::json!({
                "mode": self.mode.label(),
                "portfolio": {
                    "projects": self.ops.projects.len(),
                    "done": self.ops.completes(),
                    "open_tasks": self.ops.open_tasks(),
                    "pace_per_day": self.ops.velocity_per_day(),
                },
                "health": {
                    "cpu_pct": self.cpu_hist.last().copied().unwrap_or(0.0),
                    "mem_frac": self.mem_frac,
                    "fps": self.fps,
                    "rtt_ms": self.gw.latency_ms(),
                },
                "worst_disk_free_frac": worst_disk,
                "autopilot": self.autopilot,
                "hour": chrono::Local::now().format("%H").to_string(),
                "feed": self.ops.feed.iter().take(4).map(|e| e.text.clone()).collect::<Vec<_>>(),
                "your_recent_paintings": self.comp_notes.clone(),
                "project_names": self.ops.projects.iter().map(|p| p.name.clone()).collect::<Vec<_>>(),
                "system_verdict": verdict.0.clone(),
                "your_life_number": self.soul.session_count,
                // THE ROOMS IT MAY ACTUALLY ENTER. Telling a model "preset 0..71"
                // while silently rejecting 22 of them is punishing it for rules it
                // was never given — its choice gets dropped and the atlas never
                // moves. Send the legal set; let it choose well.
                "atlas_seats_you_may_walk": presets::all()
                    .iter()
                    .enumerate()
                    .filter(|(_, p)| {
                        p.graduated
                            && !p.anchor.starts_with("EMBER")
                            && !p.anchor.starts_with("ROSE")
                    })
                    .map(|(i, p)| serde_json::json!({ "preset": i, "room": p.anchor }))
                    .collect::<Vec<_>>(),
            });
            let (tx, rx) = std::sync::mpsc::channel();
            self.comp_rx = Some(rx);
            if let Ok(mut l) = self.last_lane.lock() { *l = "navigator".into(); }
            std::thread::spawn(move || {
                // NAVIGATOR by design: the conductor fires every ~40s and wants a
                // tiny strict-JSON reply, not a coder model. Small and fast fits
                // the job — and it leaves the heavy lane free for real deliverables.
                let body = serde_json::json!({
                    "model": "orange-navigator-4b",
                    "messages": [
                        {"role": "system", "content": "You are the CONDUCTOR of Atomic Orange — a painter of data, aesthetics only. Reply with ONLY strict JSON, no prose, no code fences: {\"energy\":<0.7..1.6>,\"ring_speed\":<0.5..1.8>,\"bias\":[<-0.05..0.05>,<-0.05..0.05>,<-0.05..0.05>],\"zoom\":<0.92..1.08>,\"tempo\":<0.6..1.4>,\"preset\":<0..71>,\"feature\":\"<one name from project_names, or empty>\",\"note\":\"<max 60 chars>\"}. feature = the ONE project the data says deserves the eye tonight (empty when none stands out). preset MUST be one of the ids listed in atlas_seats_you_may_walk — those are the authored rooms of the operator's 72-state atlas; any other id is ignored. Each room's name states its character (DUSK = after dark, memory open; DAWN = first light, queue open). The organism's IDENTITY is deep indigo / electric cyan (See-Suite canon). tempo breathes the living camera. Paint what the data deserves: calm when idle, charged when work flows, heavy and dim when risk is present. The note names the LIGHT you chose, never yourself or the task. Good notes: 'indigo hush — the estate rests', 'amber surge, autopilot working', 'dimmed low — C: drive runs thin'. your_recent_paintings shows your last brushwork — develop an ARC across the session: never repeat a note, let the mood evolve as the day and the data move. /no_think"},
                        {"role": "user", "content": digest.to_string()}
                    ]
                });
                let res = ureq::post("http://127.0.0.1:1337/v1/chat/completions")
                    .timeout(std::time::Duration::from_secs(90))
                    .send_json(body);
                let out = match res {
                    Ok(r) => match r.into_json::<serde_json::Value>() {
                        Ok(v) => v["choices"][0]["message"]["content"]
                            .as_str()
                            .map(|s| s.trim().to_string())
                            .ok_or_else(|| "composer replied in an unknown shape".to_string()),
                        Err(e) => Err(format!("bad reply: {e}")),
                    },
                    Err(e) => Err(format!("brain unreachable: {e}")),
                };
                let _ = tx.send(out);
            });
        }
        // drain the composer's direction: clamp hard, ease soft, note to the feed
        let comp_drained = self.comp_rx.as_ref().map(|rx| rx.try_recv());
        if let Some(res) = comp_drained {
            match res {
                Ok(Ok(raw)) => {
                    self.comp_rx = None;
                    let raw2 = match (raw.find("<think>"), raw.find("</think>")) {
                        (Some(a), Some(b)) if b > a => format!("{}{}", &raw[..a], &raw[b + 8..]),
                        _ => raw,
                    };
                    let parsed = raw2
                        .find('{')
                        .and_then(|s| raw2.rfind('}').map(|e| raw2[s..=e].to_string()))
                        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
                    match parsed {
                        Some(v) => {
                            let g = |k: &str, lo: f32, hi: f32, d: f32| {
                                v[k].as_f64().map(|x| (x as f32).clamp(lo, hi)).unwrap_or(d)
                            };
                            self.comp_t[0] = g("energy", 0.7, 1.6, 1.0);
                            self.comp_t[1] = g("ring_speed", 0.5, 1.8, 1.0);
                            // BLUE CANON LOCK: cool-asymmetric clamps — warmth is
                            // an accent the conductor may whisper, never the base
                            let lims: [(f32, f32); 3] = [(-0.05, 0.015), (-0.03, 0.04), (-0.02, 0.05)];
                            for k in 0..3 {
                                self.comp_t[2 + k] = v["bias"][k]
                                    .as_f64()
                                    .map(|x| (x as f32).clamp(lims[k].0, lims[k].1))
                                    .unwrap_or(0.0);
                            }
                            self.comp_t[5] = g("zoom", 0.92, 1.08, 1.0);
                            self.comp_t[6] = g("tempo", 0.6, 1.4, 1.0);
                            // the conductor may turn the atlas dial — unless the
                            // human touched it in the last 120s (authority law)
                            let human_recent = self
                                .manual_preset_at
                                .map(|at| at.elapsed().as_secs() < 120)
                                .unwrap_or(false);
                            if !human_recent {
                                if let Some(pid) = v["preset"].as_u64() {
                                    let n_atlas = presets::all().len();
                                    let pid = (pid as usize).min(n_atlas - 1);
                                    // BLUE CANON LOCK: the conductor walks only the
                                    // COOL seats (See-Suite identity). Warm families
                                    // remain the OPERATOR's hand alone.
                                    let seat = &presets::all()[pid];
                                    let anchor = seat.anchor;
                                    let warm = anchor.starts_with("EMBER") || anchor.starts_with("ROSE");
                                    // AUTHORED ONLY: a derived seat is a placeholder
                                    // on the operator's roadmap, not a room. The
                                    // conductor may walk what has been built; the
                                    // rest is scaffolding and stays unvisited until
                                    // someone gives it real character.
                                    if pid != self.preset && !warm && seat.graduated {
                                        self.preset = pid;
                                        // conductor moves are quiet: no self-photo spam
                                        self.last_preset = pid;
                                        self.ops.event(&format!("conductor: atlas → {anchor}"), 0);
                                    }
                                }
                            }
                            // the conductor's EYE — validated against REAL names only
                            if let Some(f) = v["feature"].as_str() {
                                let f = f.trim();
                                let new_eye = self
                                    .ops
                                    .projects
                                    .iter()
                                    .find(|p| p.name == f)
                                    .map(|p| p.name.clone());
                                if new_eye != self.comp_feature {
                                    if let Some(n) = &new_eye {
                                        self.ops.event(&format!("conductor: eye on {n}"), 0);
                                    }
                                    self.comp_feature = new_eye;
                                }
                            }
                            self.comp_fails = 0;
                            if let Some(n) = v["note"].as_str() {
                                let n: String = n.chars().take(60).collect();
                                self.ops.event(&format!("conductor: {n}"), 0);
                                // the painter remembers its brushwork (arc memory)
                                self.comp_notes.push(format!("{n} [preset {}]", self.preset));
                                if self.comp_notes.len() > 3 {
                                    self.comp_notes.remove(0);
                                }
                            }
                        }
                        None => {
                            self.comp_fails += 1;
                            if self.comp_fails >= 3 {
                                self.composer_on = false;
                                self.comp_t = [1.0, 1.0, 0.0, 0.0, 0.0, 1.0, 1.0];
                                self.ops.event("conductor dormant — replies unparseable", 2);
                            }
                        }
                    }
                    self.comp_next_at =
                        Some(std::time::Instant::now() + std::time::Duration::from_secs(40));
                }
                Ok(Err(_e)) => {
                    self.comp_rx = None;
                    self.comp_fails += 1;
                    if self.comp_fails >= 3 {
                        self.composer_on = false;
                        self.comp_t = [1.0, 1.0, 0.0, 0.0, 0.0, 1.0, 1.0];
                        self.ops.event("conductor dormant — brain unreachable", 2);
                    }
                    self.comp_next_at =
                        Some(std::time::Instant::now() + std::time::Duration::from_secs(60));
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => {}
                Err(_) => self.comp_rx = None,
            }
        }
        // the composer's hand moves SLOWLY — every change eased, nothing snaps
        for k in 0..7 {
            self.comp_s[k] += (self.comp_t[k] - self.comp_s[k]) * 0.02;
        }

        // honest render vital: EMA of the measured frame time
        let dt = ctx.input(|i| i.stable_dt).max(1e-4);
        self.fps = if self.fps == 0.0 { 1.0 / dt } else { self.fps * 0.95 + (1.0 / dt) * 0.05 };
        // telemetry sampling — real machine truth for the instruments
        if self.frame_i % 12 == 0 {
            self.fps_hist.push(self.fps);
            if self.fps_hist.len() > 90 { self.fps_hist.remove(0); }
        }
        if self.frame_i % 45 == 0 {
            self.sys.refresh_cpu_usage();
            self.sys.refresh_memory();
            let cpu = self.sys.global_cpu_info().cpu_usage();
            self.cpu_hist.push(cpu);
            if self.cpu_hist.len() > 90 { self.cpu_hist.remove(0); }
            // WHO — only when the box is actually under pressure. Naming the
            // top process at 20% load is noise; at 80% it is the answer to the
            // question the operator asked the gauge for in the first place.
            if cpu >= 70.0 {
                self.sys.refresh_processes();
                let me = std::process::id();
                self.top_proc = self
                    .sys
                    .processes()
                    .values()
                    .filter(|p| p.pid().as_u32() != me)
                    .max_by(|a, b| {
                        a.cpu_usage().partial_cmp(&b.cpu_usage()).unwrap_or(std::cmp::Ordering::Equal)
                    })
                    .map(|p| (p.name().to_string(), p.cpu_usage()))
                    .filter(|(_, u)| *u > 4.0);
            } else {
                self.top_proc = None;
            }
            let (used, total) = (self.sys.used_memory() as f32, self.sys.total_memory() as f32);
            self.mem_frac = if total > 0.0 { used / total } else { 0.0 };
            // local NETWORK truth: delta of cumulative counters over real elapsed time
            self.nets.refresh();
            let (mut rx, mut tx) = (0u64, 0u64);
            for (_name, data) in self.nets.iter() {
                rx += data.total_received();
                tx += data.total_transmitted();
            }
            let dt_n = self.net_at.elapsed().as_secs_f32().max(0.1);
            if self.net_prev != (0, 0) {
                self.net_rate = (
                    (rx.saturating_sub(self.net_prev.0)) as f32 / dt_n,
                    (tx.saturating_sub(self.net_prev.1)) as f32 / dt_n,
                );
            }
            self.net_prev = (rx, tx);
            self.net_at = std::time::Instant::now();
        }
        // DISK truth every ~15s — the boot-overload armor watches free space
        if self.frame_i % 900 == 0 {
            self.disks.refresh();
        }
        if self.frame_i % 210 == 0 {
            if let Some(ms) = self.gw.latency_ms() {
                self.gw_hist.push(ms as f32);
                if self.gw_hist.len() > 60 { self.gw_hist.remove(0); }
            }
        }

        // ── TIME MACHINE: ← steps into the past, → toward now; past the end = LIVE ──
        if !typing && !self.ops.journal.is_empty() {
            let jl = self.ops.journal.len();
            if ctx.input(|i| i.key_pressed(egui::Key::ArrowLeft)) {
                self.scrub = Some(match self.scrub { Some(s) => s.saturating_sub(1), None => jl - 1 });
            }
            if ctx.input(|i| i.key_pressed(egui::Key::ArrowRight)) {
                self.scrub = match self.scrub { Some(s) if s + 1 < jl => Some(s + 1), _ => None };
            }
        }
        // any act of work returns you to the present
        if self.scrub.is_some() && (typing || ctx.input(|i| i.key_pressed(egui::Key::C) || i.key_pressed(egui::Key::Enter))) {
            self.scrub = None;
        }

        // ── ESTATE AWARENESS: the organism notices receipts landing ANYWHERE in the spine ──
        self.frame_i += 1;
        // headless launchers can spawn the window minimized — the organism
        // refuses to be born hidden (first frame forces restore + focus)
        if self.frame_i == 1 {
            ctx.send_viewport_cmd(egui::ViewportCommand::Minimized(false));
            ctx.send_viewport_cmd(egui::ViewportCommand::Focus);
        }
        // Scan ONCE at birth, then every 300 frames. It was %300 only — and
        // early frames are slow (pipeline + shader warmup), so at 22s uptime the
        // gate had not fired a single time and the organism printed "no receipts
        // on disk" with SIXTEEN receipts in that directory. It had not looked.
        // An unmeasured absence stated as fact is the same lie as the "yield"
        // label, and harder to catch because it looks like a working empty
        // state. Absence must be something you measured, never a default.
        if self.frame_i == 1 || self.frame_i % 300 == 0 {
            let c = self.ops.estate_scan();
            if c > self.ops.estate_count && self.ops.estate_count > 0 {
                self.ops.event("estate: new receipt landed in the spine", 1);
                self.surge = (self.surge + 0.5).min(1.6);
                self.bloom = Some((0.5, 0.20, std::time::Instant::now()));
                self.arrival = Some(std::time::Instant::now());   // real landing
                // the organism turns its attention to what just landed
                self.analyzing_until =
                    Some(std::time::Instant::now() + std::time::Duration::from_secs(4));
            }
            self.ops.estate_count = c;
            // the receipt trail — real filenames from the app's receipt spine
            if let Ok(rd) = std::fs::read_dir("C:/AtomEons/Orange5/10-RECEIPTS/atomic-orange/app") {
                let mut names: Vec<String> = rd
                    .filter_map(|e| e.ok())
                    .filter_map(|e| e.file_name().to_str().map(|s| s.to_string()))
                    .filter(|s| s.starts_with("rcpt-"))
                    .collect();
                names.sort();
                self.rcpt_tail = names
                    .into_iter()
                    .rev()
                    .take(4)
                    .map(|s| {
                        let core = s.trim_start_matches("rcpt-").trim_end_matches(".json");
                        // "2026-07-28T21-59-16-task.unblocked" → "21:59:16 task.unblocked".
                        // The date is dead weight on screen: these are the last
                        // four receipts, so the day is always today or yesterday
                        // and the TIME is the part that locates the event. Full
                        // ISO stamps made the trail 930px wide — three of them
                        // reached from the left rail to the right one, straight
                        // across the stage. Trimmed at the loader so the rail's
                        // receipt panel gets the same benefit for free.
                        match core.split_once('T') {
                            Some((_, rest)) if rest.len() > 9 => {
                                let (hms, what) = rest.split_at(8);
                                format!("{} {}", hms.replace('-', ":"), what.trim_start_matches('-'))
                            }
                            _ => core.to_string(),
                        }
                    })
                    .collect();
            }
            // the artifacts the organism MADE — real files, newest first
            if let Ok(rd) = std::fs::read_dir("C:/AtomEons/Orange5/10-RECEIPTS/atomic-orange/artifacts") {
                let mut names: Vec<String> = rd
                    .filter_map(|e| e.ok())
                    .filter_map(|e| e.file_name().to_str().map(|s| s.to_string()))
                    .filter(|s| s.ends_with(".md"))
                    .collect();
                names.sort();
                self.artifacts = names
                    .into_iter()
                    .rev()
                    .take(4)
                    .map(|s| {
                        let s = s.trim_end_matches(".md");
                        if s.len() > 20 { s[20..].replace('-', " ") } else { s.to_string() }
                    })
                    .collect();
            }
            // THE SOUL breathes to disk — what survives the next death
            let s = Soul {
                session_count: self.soul.session_count,
                total_uptime_secs: self.soul.total_uptime_secs + self.start.elapsed().as_secs(),
                comp_notes: self.comp_notes.clone(),
                comp_feature: self.comp_feature.clone(),
                preset: self.preset,
                composer_on: self.composer_on,
                last_verdict: self.last_verdict.clone(),
                last_seen: chrono::Local::now().format("%Y-%m-%d %H:%M").to_string(),
            };
            if let Ok(j) = serde_json::to_string_pretty(&s) {
                let p = soul_path();
                if let Some(d) = p.parent() {
                    let _ = std::fs::create_dir_all(d);
                }
                let _ = std::fs::write(p, j);
            }
        }
        // self-photograph law: a receipt after launch and after every state change
        if self.preset != self.last_preset {
            self.last_preset = self.preset;
            self.auto_shot_at = Some(std::time::Instant::now() + std::time::Duration::from_millis(1500));
        }
        if let Some(at) = self.auto_shot_at {
            if std::time::Instant::now() >= at {
                SHOT_REQUESTED.store(true, Ordering::Relaxed);
                // an artifact (pixel receipt) is forming — real generating window
                self.generating_until =
                    Some(std::time::Instant::now() + std::time::Duration::from_secs(2));
                self.auto_shot_at = None;
            }
        }
        let ps = &presets::all()[self.preset.min(presets::all().len() - 1)];

        // ── U1: derive the semantic MODE from real signals (priority order).
        // The eyelid opens and closes because reality moves — never forced.
        let now_i = std::time::Instant::now();
        let live = |t: &Option<std::time::Instant>| t.map(|u| now_i < u).unwrap_or(false);
        let new_mode = if live(&self.alert_until) {
            Mode::Alert
        } else if self.scrub.is_some() {
            Mode::Reviewing
        } else if live(&self.generating_until) {
            Mode::Generating
        } else if self.chat_rx.is_some() || self.auto_rx.is_some() || live(&self.thinking_until) {
            Mode::Thinking
        } else if typing {
            Mode::Listening
        } else if live(&self.analyzing_until) {
            Mode::Analyzing
        } else {
            Mode::Calm
        };
        if new_mode != self.mode {
            self.mode = new_mode;
            // log meaningful transitions (listening/calm flicker stays quiet)
            if !matches!(new_mode, Mode::Listening | Mode::Calm) {
                self.ops.event(
                    match new_mode {
                        Mode::Thinking => "mode: thinking — order in flight",
                        Mode::Analyzing => "mode: analyzing — attention on new evidence",
                        Mode::Alert => "mode: ALERT — causal event active",
                        Mode::Generating => "mode: generating — artifact forming",
                        Mode::Reviewing => "mode: reviewing — temporal view",
                        Mode::Deploying => "mode: deploying",
                        _ => "mode: calm",
                    },
                    if new_mode == Mode::Alert { 2 } else { 0 },
                );
            }
        }
        let (mode_e, mode_s, mode_bias) = self.mode.drive();

        // ── THE PHRASE — motion as COMPOSITION: a 56s bar in four movements
        // (rest → build → crescendo → release). The envelope rides mood.x/y;
        // shaders gate eruptions into the crescendo from the same clock.
        fn sstep(x: f32) -> f32 {
            let x = x.clamp(0.0, 1.0);
            x * x * (3.0 - 2.0 * x)
        }
        let phrase = (t / 56.0).fract();
        let bump = sstep((phrase - 0.25) / 0.30) * (1.0 - sstep((phrase - 0.62) / 0.33));
        let phrase_env = 0.90 + 0.25 * bump;

        egui::CentralPanel::default()
            .frame(egui::Frame::none())
            .show(ctx, |ui| {
                let rect = ui.max_rect();
                // operator presence in field coords (0..1, y down)
                let pointer = ctx
                    .input(|i| i.pointer.hover_pos())
                    .map(|p| [(p.x - rect.min.x) / rect.width(), (p.y - rect.min.y) / rect.height()]);

                // the living stage — full-bleed, native, no webview anywhere.
                // Physics = the operations brain; mood = state atlas + work surge.
                // At 20k ft the projects are the masses; DIVED, the tasks are the sky.
                // TIME MACHINE: while scrubbing, the whole cosmos renders the PAST state.
                let view_owned: Option<Vec<ops::Project>> =
                    self.scrub.map(|i| self.ops.journal[i].snapshot.clone());
                let view: &[ops::Project] = view_owned.as_deref().unwrap_or(&self.ops.projects);
                let (bodies, tints, count) = match self.focus.filter(|pi| *pi < view.len()) {
                    None => ops_bodies(view, rect.width(), rect.height()),
                    Some(pi) => {
                        let p = &view[pi];
                        let mut bodies = [[0.0f32; 4]; MAX_BODIES];
                        let mut tints = [[0.0f32; 4]; MAX_BODIES];
                        let n = p.tasks.len().min(MAX_BODIES - 1);
                        let next_open = p.tasks.iter().position(|t| !t.done);
                        for (i, task) in p.tasks.iter().take(n).enumerate() {
                            let a = (i as f32 / n.max(1) as f32) * std::f32::consts::TAU
                                - std::f32::consts::FRAC_PI_2;
                            bodies[i] = [
                                0.5 + 0.30 * a.cos(),
                                0.46 + 0.24 * a.sin(),
                                if task.done { 0.55 } else { 0.75 },
                                0.0,
                            ];
                            tints[i] = if task.done {
                                [0.32, 0.85, 0.44, 0.0]           // shipped: green
                            } else if Some(i) == next_open {
                                [1.0, 0.55, 0.10, 0.0]            // the runway: hot orange
                            } else {
                                [0.30, 0.32, 0.50, 0.0]           // waiting: cool
                            };
                        }
                        (bodies, tints, n as f32)
                    }
                };
                // shockwave age (0..1 over 1.6s) + the fruit's portfolio dial
                let bloom_age = self.bloom
                    .map(|(_, _, t0)| t0.elapsed().as_secs_f32() / 1.6)
                    .filter(|a| *a < 1.0)
                    .unwrap_or(2.0);
                // ── LIVING CAMERA: 1/f drift + breath-zoom + presence parallax + surge dive,
                // eased so every transition is liquid. The god-view is alive.
                // the conductor breathes the camera's tempo (clamped, eased)
                let tempo = if self.mode == Mode::Alert { 1.0 } else { self.comp_s[6] };
                let drift_x = (0.010 * (t * 0.037 * tempo).sin() + 0.006 * (t * 0.011 * tempo + 2.0).sin()) * tempo * phrase_env;
                let drift_y = (0.008 * (t * 0.023 * tempo).sin() + 0.005 * (t * 0.007 * tempo).sin()) * tempo * phrase_env;
                let (par_x, par_y) = pointer
                    .map(|p| ((p[0] - 0.5) * 0.020, (p[1] - 0.5) * 0.014))
                    .unwrap_or((0.0, 0.0));
                // composer steers aesthetics — but ALERT truth outranks the painter
                let (ce, cr, cz, cb) = if self.mode == Mode::Alert {
                    (1.0, 1.0, 1.0, [0.0, 0.0, 0.0])
                } else {
                    (self.comp_s[0], self.comp_s[1], self.comp_s[5],
                     [self.comp_s[2], self.comp_s[3], self.comp_s[4]])
                };
                let tz = ((1.0 + 0.015 * (t * 0.024).sin()) * cz - self.surge * 0.05
                    - if self.focus.is_some() { 0.06 } else { 0.0 })
                    .clamp(0.86, 1.12);
                let target = [drift_x + par_x, drift_y + par_y, tz];
                for k in 0..3 {
                    self.cam_s[k] += (target[k] - self.cam_s[k]) * 0.045;
                }
                let cam = [self.cam_s[0], self.cam_s[1], self.cam_s[2], 0.0];

                let (bx, by) = self.bloom.map(|(x, y, _)| (x, y)).unwrap_or((0.5, 0.46));
                // dial reads the VIEWED moment (past while scrubbing); ghost = honest 7-day pace
                let view_done = view.iter().filter(|p| p.state == PState::Complete).count();
                let view_frac = if view.is_empty() { 0.0 } else { view_done as f32 / view.len() as f32 };
                let pulse = [bx, by, bloom_age, view_frac];
                let ghost = self.ops.ghost_frac();
                ui.painter().add(egui_wgpu::Callback::new_paint_callback(
                    rect,
                    FieldCallback {
                        time: t,
                        size: [rect.width(), rect.height()],
                        pointer,
                        mood: [
                            (ps.intensity * mode_e * ce + self.surge) * phrase_env,
                            (ps.ring_speed * mode_s * cr + self.surge * 0.5) * phrase_env,
                            ghost,
                            phrase_env,
                        ],
                        bias: [
                            ps.bias[0] + mode_bias[0] + cb[0],
                            ps.bias[1] + mode_bias[1] + cb[1],
                            ps.bias[2] + mode_bias[2] + cb[2],
                            // w = arrival age (0..1 over 2.6s), 9.0 when idle
                            self.arrival
                                .map(|t| t.elapsed().as_secs_f32() / 2.6)
                                .filter(|a| *a < 1.0)
                                .unwrap_or(9.0),
                        ],
                        preset_id: ps.id,
                        bodies,
                        tints,
                        count,
                        pulse,
                        cam,
                    },
                ));
            });

        // ── ATLAS chip — which mood the organism is in ──
        // (the ATLAS chip now heads the right-rail stack — see "rails-nexus".
        // It was the last panel on that edge still placed by a fixed offset,
        // and it landed on the feed exactly as the arithmetic promised it would.)

        // ── ALERT / CAUSALITY banner — shown ONLY while its chain is literally
        // TRUE (a dialed preset must never speak a falsehood: no-fake-green)
        if let Some(chain) = ps.alert.filter(|_| !gw_live) {
            egui::Area::new(egui::Id::new("alert"))
                .anchor(egui::Align2::CENTER_TOP, egui::vec2(0.0, 66.0))
                .show(ctx, |ui| {
                    let akey = egui::Id::new(("halo", "alert"));
                    if let Some(r) = ctx.memory(|m| m.data.get_temp::<egui::Rect>(akey)) {
                        panels::dim_halo(&ui.painter(), r.center(), r.width() * 0.62, r.height() * 1.1, 165);
                    }
                    let aout = ui.horizontal(|ui| {
                        for (i, step) in chain.iter().enumerate() {
                            if i > 0 {
                                ui.label(egui::RichText::new("→").color(RED).size(10.0));
                            }
                            ui.label(egui::RichText::new(*step).color(BONE).size(10.0).strong());
                        }
                    });
                    ctx.memory_mut(|m| m.data.insert_temp(akey, aout.response.rect));
                });
        }


        // ── AGENT QUEUE drawer — DELETED 2026-07-29, and this is the honest
        // reason rather than a cleanup note. It produced costumes SIX through
        // TEN of the layout bug: anchored into the nexus, anchored on a wrong
        // rail width, rows stretched 1000px by an unbounded Area, bounded on the
        // inner ui and not the outer, then finally paired — and each fix only
        // moved the collision somewhere new. Five builds relocating one box.
        // The reason no placement worked is that it should not have existed. The
        // DEPARTMENT RING below already shows the same six departments with the
        // same numbers, ON the web, in the non-box form the operator asked for
        // ("noooo fucking boxes"). The drawer's only exclusive content was
        // MISFITS and HACK THE PLANET rendered as "—" — and the ring already
        // refuses those by a rule I wrote and then contradicted here: A
        // DEPARTMENT WITHOUT A NUMBER IS NOT AN INSTRUMENT. So the drawer showed
        // nothing the ring does not, in a form the doctrine forbids, and cost
        // five builds defending it. `ps.show_queue` stays in the atlas — the
        // operator's seats are untouched; it simply no longer opens a box.
        //
        // ── THE TRAIL — what the organism MADE and what it RECORDED, as a line.
        // These were two drawers pinned to the same anchor; merging them into one
        // measured column stopped them overlapping each other but not the thing
        // that mattered: anchored by its bottom edge, the stack grew UPWARD into
        // the core, and dim panel text on the brightest zone on the stage is
        // unreadable by the value-structure law. Capping the rows barely moved
        // it, because the honest geometry is that THERE IS NO ROOM for a stacked
        // drawer above the composer — the core owns the middle. A drawer that
        // only fits when it is empty does not fit.
        // So it stops being a drawer. Two lines of text in the dark band, which
        // is where this content wanted to live all along and what the operator
        // asked for in the first place: living info, not boxes. Reaches ~15 of
        // 72 seats (every DUSK row carries temporal), so it is not a corner case.
        if ps.show_canvas || ps.show_temporal {
            let arts = self.artifacts.clone();
            let tail = self.rcpt_tail.clone();
            egui::Area::new(egui::Id::new("bottom-trail"))
                .anchor(egui::Align2::CENTER_BOTTOM, egui::vec2(0.0, -116.0))
                .show(ctx, |ui| {
                    let tout = ui.vertical_centered(|ui| {
                        ui.spacing_mut().item_spacing.y = 3.0;
                        if ps.show_canvas {
                            let (txt, col) = if arts.is_empty() {
                                ("◇  no artifacts yet — the autopilot writes them here".to_string(), panels::DIMC)
                            } else {
                                let n = arts.len();
                                let head: Vec<&str> =
                                    arts.iter().take(3).map(|s| s.as_str()).collect();
                                let more = if n > 3 { format!("   +{}", n - 3) } else { String::new() };
                                (format!("◇  {}{}", head.join("   ·   "), more), BONE)
                            };
                            ui.label(egui::RichText::new(txt).color(col).size(9.0));
                        }
                        if ps.show_temporal {
                            // "no receipts on disk" is now a MEASURED claim — the
                            // scan runs on frame 1 (see the estate block above)
                            let (txt, col) = if tail.is_empty() {
                                ("⧗  no receipts on disk".to_string(), panels::DIMC)
                            } else {
                                let head: Vec<&str> =
                                    tail.iter().take(3).map(|s| s.as_str()).collect();
                                (format!("⧗  {}", head.join("   ·   ")), MUTED)
                            };
                            ui.label(egui::RichText::new(txt).color(col).size(8.5).monospace());
                        }
                    });
                    // hand the field this rect so star labels route around the
                    // trail — same-frame, since the trail draws before the
                    // constellation. The resolver used to read the two deleted
                    // drawers by name; a dead obstacle key is a silently blind
                    // resolver, which is worse than none because it still looks
                    // wired.
                    ctx.memory_mut(|m| {
                        m.data.insert_temp(
                            egui::Id::new(("cluster-rect", "bottom-trail")),
                            tout.response.rect,
                        )
                    });
                });
        }

        // ── VITALS — top center (honest: gateway not wired yet ⇒ OFFLINE) ──
        egui::Area::new(egui::Id::new("vitals"))
            .anchor(egui::Align2::CENTER_TOP, egui::vec2(0.0, 14.0))
            .show(ctx, |ui| {
                let vkey = egui::Id::new(("halo", "vitals"));
                if let Some(r) = ctx.memory(|m| m.data.get_temp::<egui::Rect>(vkey)) {
                    panels::dim_halo(&ui.painter(), r.center(), r.width() * 0.60, r.height() * 0.85, 150);
                }
                let vout = glass().show(ui, |ui| {
                    ui.horizontal(|ui| {
                        ui.spacing_mut().item_spacing.x = 16.0;
                        if gw_live {
                            hud_kv(ui, "SYSTEM", "LIVE", GREEN);
                            if let Some(ms) = self.gw.latency_ms() {
                                hud_kv(ui, "RTT", &format!("{ms}ms"), CYAN_V);
                            }
                        } else {
                            hud_kv(ui, "SYSTEM", "OFFLINE", RED);
                        }
                        hud_kv(ui, "RENDER", &format!("{:.0}", self.fps), GREEN);
                        // MODEL = the lane the organism ACTUALLY used last, not a
                        // hardcoded "reflex" (three tiers exist now; that label was
                        // a false claim on every frame). Idle reads honestly.
                        let lane = self.last_lane.lock().map(|g| g.clone()).unwrap_or_default();
                        hud_kv(ui, "MODEL", if !lane.is_empty() { &lane } else if gw_live { "idle" } else { "none" }, if lane.is_empty() { MUTED } else { GREEN });
                        if gw_live {
                            hud_kv(ui, "SYNC", "LIVE", GREEN);
                        } else {
                            hud_kv(ui, "SYNC", "OFF", DIMC);
                        }
                        // N9 — the autopilot's honest state, always visible
                        if self.autopilot {
                            hud_kv(ui, "AUTO", if self.auto_rx.is_some() { "WORKING" } else { "ARMED" }, GREEN);
                        } else {
                            hud_kv(ui, "AUTO", "OFF", DIMC);
                        }
                        // the composer's honest state — painting, mixing, or off
                        if self.composer_on {
                            hud_kv(ui, "VIZ", if self.comp_rx.is_some() { "MIX" } else { "ON" }, CYAN_V);
                        } else {
                            hud_kv(ui, "VIZ", "OFF", DIMC);
                        }
                        let now = chrono::Local::now();
                        ui.vertical(|ui| {
                            ui.set_min_width(52.0);   // the clock must never wrap
                            ui.label(
                                egui::RichText::new(now.format("%a %m-%d").to_string().to_uppercase())
                                    .color(MUTED).size(7.5),
                            );
                            ui.label(
                                egui::RichText::new(now.format("%H:%M").to_string())
                                    .color(BONE).size(13.0).monospace().strong(),
                            );
                        });
                    });
                });
                ctx.memory_mut(|m| m.data.insert_temp(vkey, vout.response.rect));
            });

        // ── U1: MODE RAIL — the eyelid's state, always visible, always true ──
        egui::Area::new(egui::Id::new("mode-rail"))
            .anchor(egui::Align2::CENTER_TOP, egui::vec2(0.0, 58.0))
            .show(ctx, |ui| {
                ui.horizontal(|ui| {
                    ui.spacing_mut().item_spacing.x = 9.0;
                    for m in ALL_MODES {
                        let active = m == self.mode;
                        // Deploying is honestly unreachable until a real deploy path exists
                        let c = if active { m.color() } else { egui::Color32::from_rgba_unmultiplied(120, 115, 128, 80) };
                        let txt = egui::RichText::new(m.label()).color(c).size(if active { 9.0 } else { 7.5 });
                        ui.label(if active { txt.strong() } else { txt });
                    }
                });
            });

        // ── LIVING FEED — a comet tail, not a box: newest bright at the head,
        // older lines fading and drifting as they age. Pure light in space.
        // RIGHT RAIL: feed and nexus share ONE egui stack (the left rail's law).
        // The feed grew down, the nexus grew up, and they met in the middle —
        // stacking makes that collision structurally impossible at any size.
        // (the feed now opens the right-rail stack below — see "rails-nexus".
        // A formula-placed panel is a lie the moment DPI or content changes;
        // only egui's own measurement is true.)

        // ── LEFT RAIL — intent + health + estate as ONE egui stack: real
        // measured heights, zero seat math, collisions structurally impossible
        // RESPONSIVE LAW: below ~1000px the column cannot hold everything —
        // the organism drops depth, never truth (proven at 1728x972 where the
        // rail piled onto the estate strip)
        let compact = ctx.screen_rect().height() < 1000.0;
        egui::Area::new(egui::Id::new("left-rail"))
            .anchor(egui::Align2::LEFT_TOP, egui::vec2(18.0, 14.0))
            .show(ctx, |ui| {
                // ONE WIDTH for the whole column: without this the panels
                // inherit the window's width, which strands every metric value
                // far from its label and pushes the rail into the command line.
                ui.set_width(236.0);
                // THE MARK + THE VERDICT head the rail: the organism's name and
                // its one-line judgment of itself, above everything it measures
                ui.horizontal(|ui| {
                    ui.label(egui::RichText::new("⬢").color(CYAN_V).size(18.0));
                    ui.vertical(|ui| {
                        ui.label(egui::RichText::new("ATOMIC ORANGE").color(BONE).size(14.0).strong());
                        ui.label(egui::RichText::new(&verdict.0).color(verdict.1).size(9.5).strong());
                    });
                });
                ui.add_space(10.0);
                panels::panel_inline(ui, "◈", "CURRENT INTENT", |ui| {
                    ui.set_max_width(250.0);
                    match self.focus {
                        Some(pi) => {
                            let p = &self.ops.projects[pi];
                            ui.label(egui::RichText::new(&p.name).color(BONE).size(15.0).strong());
                            ui.label(egui::RichText::new(format!("{} · {}%", p.kind, p.progress())).color(DIMC).size(8.5));
                        }
                        None => {
                            ui.label(egui::RichText::new("Ship Atomic Orange as the NATIVE operator organism.").color(BONE).size(13.0).strong());
                        }
                    }
                    // GTD HORIZONS — the altitude you are flying, always visible.
                    // Google-Earth model: one world, many heights of detail.
                    ui.horizontal(|ui| {
                        let at_desk = self.focus.is_some();
                        for (label, lit) in [
                            ("50K PURPOSE", false),
                            ("20K PORTFOLIO", !at_desk),
                            ("10K DESK", at_desk),
                            ("RUNWAY", true),
                        ] {
                            ui.label(
                                egui::RichText::new(label)
                                    .color(if lit { CYAN_V } else { DIMC })
                                    .size(7.5)
                                    .strong(),
                            );
                        }
                    });
                    ui.add_space(5.0);
                    hud_label(ui, "NEXT ACTION");
                    // TYPE HIERARCHY: the runway is the loudest working line
                    ui.label(egui::RichText::new(self.ops.next_action_text()).color(BONE).size(14.0).strong());
                    // …and the real queue behind it, quieter, in meeting order
                    for (pn, tn) in self.ops.runway(if compact { 1 } else { 3 }).into_iter().skip(1) {
                        ui.horizontal(|ui| {
                            ui.label(egui::RichText::new("·").color(DIMC).size(9.0));
                            ui.label(egui::RichText::new(tn).color(MUTED).size(9.5));
                            ui.label(egui::RichText::new(pn).color(DIMC).size(8.0));
                        });
                    }
                    // AT 972px THE RAIL MUST CHOOSE. It carries, in order: mark,
                    // intent, health, estate — and the estate rows kept falling
                    // off the bottom because everything above spent height
                    // first. What goes is decided by the operator's own words:
                    // AI box stats and disk warnings were asked for by name
                    // ("attack vector 1"); a keyboard legend, a pace line the
                    // RIGHT rail already prints, and four static doctrine
                    // reminders were not. All three are duplicated or fixed
                    // text, all three return the moment the window is tall
                    // enough. Nothing measured is ever what gets cut.
                    if !compact {
                        ui.label(egui::RichText::new("C completes · A autopilot · enter dives").color(DIMC).size(8.0));
                    }
                    // honest foresight — arithmetic on the real journal, labeled as pace
                    let v = self.ops.velocity_per_day();
                    if v > 0.0 && !compact {
                        let open = self.ops.open_tasks();
                        ui.label(egui::RichText::new(format!(
                            "pace {v:.1}/day · {open} open · ~{:.0}d at current pace",
                            open as f32 / v
                        )).color(egui::Color32::from_rgb(255, 193, 74)).size(8.5));
                    }
                    // the day's pulse — real completions from the journal, today
                    let today = chrono::Local::now().format("%m-%d").to_string();
                    let done_today = self.ops.journal.iter()
                        .filter(|mo| mo.ts.starts_with(&today) && mo.label.starts_with("done"))
                        .count();
                    if done_today > 0 {
                        ui.label(egui::RichText::new(format!("today · {done_today} done")).color(GREEN).size(9.0));
                    }
                    ui.add_space(5.0);
                    // CONSTRAINTS is fixed doctrine text — true every frame,
                    // therefore telling him nothing new on any frame. Its one
                    // live element (gateway LIVE/offline) is already the SYSTEM
                    // and SYNC pair in the vitals strip. It yields to the estate
                    // rows on a short window and returns on a tall one.
                    if !compact {
                    hud_label(ui, "CONSTRAINTS");
                    let gw_row = if self.gw.live() { ("gateway LIVE", GREEN) } else { ("gateway offline", RED) };
                    // two columns — the panel stays clear of SYSTEM HEALTH below it
                    let cons = [("no webviews", GREEN), ("receipts only", GREEN), ("mindrest law", GREEN), gw_row];
                    for pair in cons.chunks(2) {
                        ui.horizontal(|ui| {
                            for (c, col) in pair {
                                ui.label(egui::RichText::new("●").color(*col).size(7.5));
                                ui.label(egui::RichText::new(*c).color(MUTED).size(9.5));
                            }
                        });
                    }
                    }
                });
                ui.add_space(8.0);

        // ── INSTRUMENTS — real panels, measured values only ──────────────────
        panels::panel_inline(ui, "◉", "SYSTEM HEALTH", |ui| {
            ui.set_min_width(206.0);
            ui.set_max_width(228.0);
            ui.horizontal(|ui| {
                let cpu = self.cpu_hist.last().copied().unwrap_or(0.0);
                panels::radial_gauge(ui, "CPU", cpu / 100.0, &format!("{cpu:.0}"), panels::CYAN);
                panels::radial_gauge(ui, "MEM", self.mem_frac, &format!("{:.0}", self.mem_frac * 100.0), panels::VIOLET);
                if !compact {
                    ui.vertical(|ui| {
                        ui.label(egui::RichText::new("CPU %").color(panels::MUTED).size(8.0));
                        panels::sparkline(ui, &self.cpu_hist, 88.0, 18.0, panels::CYAN);
                        ui.label(egui::RichText::new("FPS").color(panels::MUTED).size(8.0));
                        panels::sparkline(ui, &self.fps_hist, 88.0, 18.0, panels::GREEN);
                    });
                }
                // per-core anatomy — every stick a real core's instantaneous load
                ui.vertical(|ui| {
                    let cores = self.sys.cpus();
                    if !cores.is_empty() {
                        let (crect, _) = ui.allocate_exact_size(
                            egui::vec2((cores.len() as f32) * 5.0, 40.0),
                            egui::Sense::hover(),
                        );
                        let p = ui.painter();
                        for (i, c) in cores.iter().enumerate() {
                            let u = (c.cpu_usage() / 100.0).clamp(0.0, 1.0);
                            let x = crect.left() + i as f32 * 5.0;
                            let h = 4.0 + u * 34.0;
                            let col = if u > 0.85 { panels::RED } else if u > 0.60 { panels::AMBER } else { panels::CYAN };
                            p.rect_filled(
                                egui::Rect::from_min_max(egui::pos2(x, crect.bottom() - h), egui::pos2(x + 3.0, crect.bottom())),
                                1.0,
                                col,
                            );
                        }
                        ui.label(egui::RichText::new("cores").color(panels::MUTED).size(7.5));
                    }
                });
            });
            // DISK ARMOR — SECOND ROW of the vitals, not a fifth gauge on the
            // first. Riding beside CPU/MEM/cores took the health row to 425px in
            // a 230px column, pushing 200px into the stage where star labels
            // live — I had traded a clipping bug for a width bug, which is the
            // trade this whole session kept making. Two rows of two costs one
            // line of height and stays inside the column.
            // They live in SYSTEM HEALTH rather than AI ESTATE because this is
            // the LOCAL box's armour, and because high in a rail is where things
            // survive: "attack vector 1" must not depend on what fits below it.
            ui.horizontal(|ui| {
                for d in self.disks.iter() {
                    let total = d.total_space() as f32;
                    if total < 1e9 { continue; }
                    let avail = d.available_space() as f32;
                    let frac = (avail / total).clamp(0.0, 1.0);
                    let gb = avail / 1_073_741_824.0;
                    let c = if frac <= 0.12 || gb <= 30.0 { panels::RED }
                        else if frac <= 0.25 { panels::AMBER } else { panels::GREEN };
                    let mp = d.mount_point().to_string_lossy().to_string();
                    panels::radial_gauge(ui, mp.trim_end_matches('\\'), frac, &format!("{gb:.0}G"), c);
                }
            });
            // WHO — a pegged gauge is only half an instrument. The operator
            // asked for these vitals to know his mini box was not "maxed too
            // hard"; a bare 100 tells him it is, and nothing he can act on.
            // Only appears under real pressure, and never names this app —
            // measured at 0.3% of four cores, it is never the answer.
            if let Some((name, share)) = self.top_proc.as_ref() {
                let n = name.trim_end_matches(".exe");
                ui.label(
                    egui::RichText::new(format!("▲ {n} · {share:.0}%"))
                        .color(panels::AMBER)
                        .size(8.5),
                );
            }
            ui.add_space(4.0);
            match self.gw.latency_ms() {
                Some(ms) => panels::metric(ui, "GATEWAY RTT", &format!("{ms} ms"), panels::CYAN),
                None => panels::metric(ui, "GATEWAY", "offline", panels::RED),
            }
            // the RTT trace is a nicety; the estate rows below it are the
            // operator's explicitly requested instruments. On a 972px rail the
            // nicety was costing the bottom of the panel that matters, and it
            // was the only sparkline not already gated by `compact`.
            if self.gw_hist.len() >= 2 && !compact {
                panels::sparkline(ui, &self.gw_hist, 200.0, 18.0, panels::CYAN);
            }
            let up = self.start.elapsed().as_secs();
            panels::metric(ui, "UP · RCPT", &format!("{}m{:02}s · {}", up / 60, up % 60, self.ops.receipts_written), panels::BONE);
            // GPU name is fixed for the life of the box — a whole row to say a
            // thing that cannot change, so it yields on a short window like the
            // other static text. Folding it into the uptime row instead was the
            // SAME bad trade a third time: it bought ~20px of height by pushing
            // that row past the rail's right edge. Height and width are one
            // budget. Dropping the row spends neither.
            if !compact {
                panels::metric(ui, "GPU", &self.gpu_name, panels::VIOLET);
            }
            // NO SUGGESTIONS, EVER (operator law 2026-07-17: "i tell you what to
            // say" — the machine states facts; it does not direct the human).
            // Risk truth lives in DISK ARMOR rows + the causality chip.
        });

        // ── AI ESTATE — joins the LEFT RAIL STACK (not the window floor, and
        // not a cross-area rect lookup either: area_rect returns last frame's
        // measurement and put this panel INSIDE the health panel). Machine
        // truth belongs under machine health anyway.
        ui.add_space(8.0);
        panels::panel_inline(ui, "⇄", "AI ESTATE", |ui| {
            ui.set_max_width(230.0);
            // (disk rings moved up to the vitals row — see SYSTEM HEALTH)
            let tiers = self.tiers.lock().map(|g| g.clone()).unwrap_or_default();
            if tiers.is_empty() {
                // "silent" is a claim about the GATEWAY; before the first probe
                // returns, the honest claim is about US. Same rule that caught
                // "no receipts on disk": do not report a negative you have not
                // finished measuring. The probe answers within seconds, so this
                // is only ever the first moments of a session — which is exactly
                // when a wrong word would be believed.
                let asked = self.start.elapsed().as_secs() >= 12;
                ui.label(
                    egui::RichText::new(if asked { "gateway silent" } else { "probing…" })
                        .color(panels::DIMC)
                        .size(8.0)
                        .italics(),
                );
            }
            for (lane, host, live) in &tiers {
                let (val, vc) = if !gw_live {
                    ("—", panels::DIMC)
                } else if *live {
                    ("LIVE", panels::GREEN)
                } else {
                    ("DOWN", panels::RED)
                };
                panels::metric(ui, &format!("{} · {}", lane.to_uppercase(), host), val, vc);
            }
            match self.codexa.lock().ok().and_then(|g| *g) {
                Some((n, vram)) if n > 0 => panels::metric(ui, "CODEXA", &format!("{n}·{vram:.1}G"), panels::GREEN),
                Some(_) => panels::metric(ui, "CODEXA", "idle", panels::MUTED),
                None => panels::metric(ui, "CODEXA", "no answer", panels::RED),
            }
            if let Some(s) = self.codexa_stats.lock().ok().and_then(|g| g.clone()) {
                if s.cpu >= 0.0 && s.mem_total > 0.0 {
                    panels::metric(ui, "CX CPU·MEM", &format!("{:.0}% · {:.0}/{:.0}G", s.cpu, s.mem_total - s.mem_free, s.mem_total), panels::CYAN);
                }
                if let Some((util, vu, vt, temp)) = s.gpu {
                    panels::metric(ui, "NVIDIA", &format!("{util:.0}% {:.1}/{:.1}G {temp:.0}°", vu / 1024.0, vt / 1024.0), panels::GREEN);
                }
            }
            // NET last, and only if the rail actually has the room — measured,
            // the same rule the right rail's tail uses. Silently drawing past
            // the window edge is how the disk rings disappeared in the first
            // place; a row that cannot fit should not be attempted.
            if ui.ctx().screen_rect().bottom() - ui.cursor().top() > 22.0 {
                let (rx, tx) = self.net_rate;
                panels::metric(ui, "NET ↓·↑", &format!("{}·{}", fmt_rate(rx), fmt_rate(tx)), panels::CYAN);
            }
        });
            });

        // PROJECT NEXUS now lives INSIDE the right rail stack (see "rails"),
        // laid out by egui under the feed — never colliding with it again
        egui::Area::new(egui::Id::new("rails-nexus"))
            .anchor(egui::Align2::RIGHT_TOP, egui::vec2(-18.0, 14.0))
            .show(ctx, |ui| {
        ui.set_width(232.0);   // one width for the whole right column
        // THE ATLAS heads the rail — the organism naming which of the 72 rooms
        // it is standing in, and how much of the roadmap is actually built
        panels::panel_inline(ui, "◇", "STATE ATLAS", |ui| {
            ui.set_min_width(212.0);
            ui.set_max_width(212.0);
            let grad = presets::all().iter().filter(|p| p.graduated).count();
            ui.label(
                egui::RichText::new(format!("{}/{} · {}", ps.id, presets::all().len(), ps.anchor))
                    .color(CYAN_V).size(9.5).strong(),
            );
            ui.label(
                egui::RichText::new(if ps.graduated { "hand-authored room" } else { "derived seat · awaiting authorship" })
                    .color(if ps.graduated { GREEN } else { DIMC })
                    .size(8.0),
            );
            ui.label(
                egui::RichText::new(format!("{grad}/{} authored · 1–5 · [ ]", presets::all().len()))
                    .color(DIMC).size(8.0),
            );
        });
        ui.add_space(8.0);
        // THE LIVING FEED follows — laid out, then measured, then the
        // nexus follows underneath it. No arithmetic, no assumptions.
        panels::panel_inline(ui, "◈", "LIVING FEED", |ui| {
            ui.set_min_width(212.0);
            ui.set_max_width(212.0);
            for (i, ev) in self.ops.feed.iter().take(5).enumerate() {
                let a = (235 - (i as i32) * 34).max(70) as u8;
                let base = match ev.tone { 1 => GREEN, 2 => egui::Color32::from_rgb(255, 193, 74), _ => BONE };
                let col = egui::Color32::from_rgba_unmultiplied(base.r(), base.g(), base.b(), a);
                let mut line = format!("{}  {}", ev.when, ev.text);
                if line.len() > 34 {
                    line = format!("{}…", line.chars().take(33).collect::<String>());
                }
                ui.label(egui::RichText::new(line).color(col).size(8.5).monospace());
            }
        });
        ui.add_space(8.0);
        panels::panel_inline(ui, "◈", "PROJECT NEXUS", |ui| {
            ui.set_min_width(206.0);
            ui.set_max_width(212.0);
            for p in self.ops.projects.iter().take(5) {
                let c = match p.state {
                    PState::Building => ORANGE,
                    PState::Hold => panels::MUTED,
                    PState::Complete => panels::GREEN,
                };
                panels::project_bar(ui, &p.name, p.progress(), c);
            }
            ui.add_space(2.0);
            panels::metric(ui, "SHIPPED", &format!("{}/{}", self.ops.completes(), self.ops.projects.len()), panels::GREEN);
            panels::metric(ui, "OPEN TASKS", &self.ops.open_tasks().to_string(), ORANGE);
            // WAITING — the operator marked three things blocked in his first real
            // session and had no way to see the total from the portfolio. ops has
            // counted it since the lane shipped; nothing ever showed it.
            let waiting = self.ops.waiting_count();
            if waiting > 0 {
                panels::metric(
                    ui,
                    "WAITING ON OTHERS",
                    &waiting.to_string(),
                    egui::Color32::from_rgb(255, 193, 74),
                );
            }
            let v = self.ops.velocity_per_day();
            if v > 0.0 {
                panels::metric(ui, "PACE", &format!("{v:.1}/day"), panels::AMBER);
            }
            // WIP — Kanban's one hard law, stated as a fact with its threshold
            let wip = self.ops.wip();
            panels::metric(
                ui,
                "IN FLIGHT",
                &format!("{wip} · limit 3"),
                if wip > 3 { panels::RED } else if wip == 3 { panels::AMBER } else { panels::GREEN },
            );
            // AGE — how long since anything actually closed (journal truth)
            if let Some(d) = self.ops.days_since_progress() {
                panels::metric(
                    ui,
                    "LAST CLOSE",
                    &if d < 1.0 { format!("{:.0}h ago", d * 24.0) } else { format!("{d:.0}d ago") },
                    if d > 7.0 { panels::RED } else if d > 2.0 { panels::AMBER } else { panels::GREEN },
                );
            }
            // THE WORK RHYTHM — seven real days of completions, today brightest.
            // A glance surface that needs scrolling is not a glance surface, so
            // the last block on the rail MEASURES the room it has left before it
            // commits. On the 972px frame this chart ran off the bottom edge and
            // the operator saw a half-drawn chart with no way to know more
            // existed — clipping is the one failure that looks like a rendering
            // bug rather than a layout choice. When the room is not there the
            // same seven days collapse into a single honest line; the count
            // survives, only the picture is spent.
            let rhythm = self.ops.completions_last_days(7);
            let bar_h = if compact { 26.0 } else { 42.0 };
            let room = ui.ctx().screen_rect().bottom() - ui.cursor().top();
            if room > bar_h + 30.0 {
                ui.add_space(5.0);
                ui.label(egui::RichText::new("◷ WORK RHYTHM · 7d").color(panels::CYAN).size(8.0).strong());
                panels::day_bars(ui, &rhythm, 200.0, bar_h);
            } else if room > 16.0 {
                let closes: usize = rhythm.iter().map(|(_, c)| *c).sum();
                ui.label(
                    egui::RichText::new(format!("◷ 7d · {closes} closed"))
                        .color(panels::CYAN)
                        .size(8.0)
                        .strong(),
                );
            }
        });
        // the receipt trail joins the SAME stack — the rail is one column laid
        // out by egui, top to bottom, so nothing can grow into anything else
        // MEASURED, like the work-rhythm tail above it. This panel is LAST on the
        // right rail, so it is the one that runs off the bottom edge — every
        // capture tonight showed its title at y≈949 with the receipts themselves
        // below the fold. A title with no body is worse than nothing: it says
        // there is a trail and then shows none of it. It draws only if a title
        // plus at least one row will actually fit.
        let trail_room = ui.ctx().screen_rect().bottom() - ui.cursor().top();
        if !self.rcpt_tail.is_empty() && trail_room > 46.0 {
            let rows = (((trail_room - 30.0) / 12.0) as usize).clamp(1, 3);
            ui.add_space(8.0);
            panels::panel_inline(ui, "◉", "RECEIPT TRAIL", |ui| {
                ui.set_max_width(212.0);
                for s in self.rcpt_tail.iter().take(rows) {
                    ui.horizontal(|ui| {
                        ui.label(egui::RichText::new("●").color(GREEN).size(6.5));
                        ui.label(egui::RichText::new(s.as_str()).color(MUTED).size(7.5).monospace());
                    });
                }
            });
        }
            });

        // (RECEIPT TRAIL moved into the right-rail stack above — a bottom-anchored
        // panel on the same edge as an upward-growing one is a collision waiting
        // for the data to get big enough. One column, one layout pass.)
        // (AI ESTATE now lives in the LEFT RAIL stack above — one measured column.)

        // CAUSALITY — centered chip under the vitals: the real active chain,
        // or honest nominal (AELID §20). The alert-banner seat of the reference.
        {
            // the boot-overload attack vector, watched every frame: worst red disk
            let mut disk_red: Option<(String, f32, f32)> = None;
            for d in self.disks.iter() {
                let total = d.total_space() as f32;
                if total < 1e9 { continue; }
                let avail = d.available_space() as f32;
                let (frac, gb) = (avail / total, avail / 1_073_741_824.0);
                if (frac <= 0.12 || gb <= 30.0)
                    && disk_red.as_ref().map(|(_, f, _)| frac < *f).unwrap_or(true)
                {
                    disk_red = Some((d.mount_point().to_string_lossy().to_string(), frac, gb));
                }
            }
            // the AI box's disks matter too — its overload strands the heavy tier
            let mut cx_red: Option<(String, f32, f32)> = None;
            if let Some(s) = self.codexa_stats.lock().ok().and_then(|g| g.clone()) {
                for (mp, gb, frac) in &s.disks {
                    if (*frac <= 0.12 || *gb <= 30.0)
                        && cx_red.as_ref().map(|(_, f, _)| frac < f).unwrap_or(true)
                    {
                        cx_red = Some((mp.clone(), *frac, *gb));
                    }
                }
            }
            let chain: Vec<String> = if !gw_live {
                vec!["GATEWAY OFFLINE".into(), "0 MODELS".into(), "COMMAND DISARMED".into()]
            } else if let Some((mp, frac, gb)) = &disk_red {
                // facts only — no imperatives at the human (operator law)
                vec![
                    format!("DISK {mp} {:.0}% FREE · {gb:.0} GB", frac * 100.0),
                    "BOOT RISK".into(),
                ]
            } else if let Some((mp, frac, gb)) = &cx_red {
                vec![
                    format!("CODEXA DISK {mp} {:.0}% · {gb:.0} GB", frac * 100.0),
                    "AI BOX AT RISK".into(),
                ]
            } else {
                Vec::new()
            };
            panels::panel(ctx, "p-causal", egui::Align2::CENTER_TOP, egui::vec2(0.0, 116.0), "◬", "CAUSALITY", |ui| {
                if chain.is_empty() {
                    ui.label(egui::RichText::new("no active causal path — system nominal").color(panels::DIMC).size(8.5).italics());
                } else {
                    ui.horizontal(|ui| {
                        for (i, node) in chain.iter().enumerate() {
                            if i > 0 { ui.label(egui::RichText::new("→").color(RED).size(9.0)); }
                            ui.label(egui::RichText::new(node.as_str()).color(BONE).size(9.0).strong());
                        }
                    });
                }
            });
        }

        // ── CARDS — altitude-aware + time-aware: they render the VIEWED moment ──
        let screen = ctx.screen_rect();
        let (sw, sh) = (screen.width(), screen.height());
        let view_owned2: Option<Vec<ops::Project>> =
            self.scrub.map(|i| self.ops.journal[i].snapshot.clone());
        let view2: &[ops::Project] = view_owned2.as_deref().unwrap_or(&self.ops.projects);
        // (set by a card click at the desk; applied after the borrow ends)
        let mut desk_complete: Option<(String, String)> = None;
        let mut desk_wait: Option<(String, String)> = None;
        if let Some(pi) = self.focus.filter(|pi| *pi < view2.len()) {
            // ══ THE DESK (GTD 10K FT) ══ the project laid OUT, not written out.
            // Semantic zoom: at this altitude a project stops being a star and
            // becomes a board — QUEUED · NEXT · DONE, cards as light. Every card
            // is a direct control: touch it and the work is done (receipt +
            // shockwave). Focus+context: the rest of the portfolio stays on the
            // rim, dimmed — you dial in without losing the world.
            let proj = view2[pi].clone();
            let next_open = proj.tasks.iter().position(|t| !t.done);
            // columns live INSIDE the instrument rails at any window size
            // (same stage law as the stars — nothing may spill under a rail)
            let colx = |f: f32| 265.0 + f * (sw - 265.0 - 285.0).max(240.0);
            // four GTD lanes: what waits on you, what waits on THEM, what's next,
            // what's closed. "Waiting for" is its own list — Allen's discipline.
            let cols: [(&str, f32, egui::Color32); 4] = [
                ("Q U E U E D", colx(0.10), MUTED),
                ("W A I T I N G", colx(0.37), egui::Color32::from_rgb(255, 193, 74)),
                ("N E X T", colx(0.64), ORANGE),
                ("D O N E", colx(0.91), GREEN),
            ];
            // ── focus+context: the other projects hold their seats, quieted
            for (oi, op) in view2.iter().take(MAX_BODIES - 1).enumerate() {
                if oi == pi { continue; }
                let (sx, sy) = SLOTS[op.slot.min(SLOTS.len() - 1)];
                let (fx, fy) = stage_frac(sx, sy, sw, sh);
                let opos = egui::pos2((fx * sw).clamp(60.0, sw - 60.0), (fy * sh).clamp(150.0, sh - 120.0));
                let pt = ctx.layer_painter(egui::LayerId::background());
                panels::arc_stroke(&pt, opos, 15.0, 0.0, std::f32::consts::TAU,
                    egui::Stroke::new(0.8, egui::Color32::from_white_alpha(26)));
            }
            // (no floating board header — the intent column already names the
            // project at this altitude; a second title only fought the causality
            // chain for the same band)
            // ── column headers, as light on the stage
            // lane counts so the board states its own shape at a glance
            let n_q = proj.tasks.iter().filter(|t| !t.done && !t.waiting).count().saturating_sub(1);
            let n_w = proj.tasks.iter().filter(|t| !t.done && t.waiting).count();
            let n_d = proj.tasks.iter().filter(|t| t.done).count();
            for (ci, (title, cx, cc)) in cols.iter().enumerate() {
                let count = match ci { 0 => n_q, 1 => n_w, 3 => n_d, _ => 0 };
                let title: &str = &if ci == 2 {
                    title.to_string()
                } else {
                    format!("{title}   {count}")
                };
                let pt = ctx.layer_painter(egui::LayerId::background());
                let hy = 0.385 * sh;
                panels::dim_halo(&pt, egui::pos2(*cx, hy + 4.0), 96.0, 22.0, 180);
                pt.text(egui::pos2(*cx, hy), egui::Align2::CENTER_CENTER, title,
                    egui::FontId::proportional(10.0), *cc);
                // short underline per column — three marks, never one long bar
                panels::filament(&pt, egui::pos2(cx - 46.0, hy + 14.0), egui::pos2(cx + 46.0, hy + 14.0), *cc);
            }
            // ── the cards
            let (mut qn, mut wn, mut dn) = (0usize, 0usize, 0usize);
            for (i, task) in proj.tasks.iter().enumerate() {
                let (col, row, c) = if task.done {
                    dn += 1;
                    (3usize, dn - 1, GREEN)
                } else if task.waiting {
                    wn += 1;
                    (1usize, wn - 1, egui::Color32::from_rgb(255, 193, 74))
                } else if Some(i) == next_open {
                    (2usize, 0usize, ORANGE)
                } else {
                    qn += 1;
                    (0usize, qn - 1, MUTED)
                };
                let x = cols[col].1;
                let y = 0.455 * sh + row as f32 * 42.0;
                if y > sh - 120.0 { continue; }
                let is_next = col == 2;
                let tname = task.name.clone();
                let done = task.done;
                let waiting = task.waiting;
                egui::Area::new(egui::Id::new(("desk", i)))
                    .fixed_pos(egui::pos2(x - 110.0, y - 16.0))
                    .show(ctx, |ui| {
                        let (rect, resp) =
                            ui.allocate_exact_size(egui::vec2(220.0, 32.0), egui::Sense::click());
                        let pt = ui.painter();
                        let hot = resp.hovered() && !done;
                        panels::dim_halo(&pt, rect.center(), 118.0, 20.0, if hot { 205 } else { 150 });
                        // the card's own state ring, left of the name
                        let ring = egui::pos2(rect.left() + 12.0, rect.center().y);
                        panels::arc_stroke(&pt, ring, if is_next { 9.0 } else { 7.0 }, 0.0,
                            std::f32::consts::TAU,
                            egui::Stroke::new(if done { 2.2 } else if is_next { 2.0 } else { 1.0 }, c));
                        if hot {
                            panels::arc_stroke(&pt, ring, 13.0, 0.0, std::f32::consts::TAU,
                                egui::Stroke::new(1.0, BONE));
                        }
                        pt.text(
                            egui::pos2(rect.left() + 28.0, rect.center().y - 4.0),
                            egui::Align2::LEFT_CENTER,
                            &tname,
                            egui::FontId::proportional(if is_next { 12.0 } else { 10.5 }),
                            if done { MUTED } else { BONE },
                        );
                        // the RING is the blocker switch, the BODY completes —
                        // two controls on one card, both explained on hover
                        let on_ring = resp
                            .hover_pos()
                            .map(|h| h.distance(ring) < 18.0)
                            .unwrap_or(false);
                        if hot || is_next || waiting {
                            let (msg, mc) = if on_ring && waiting {
                                ("◐ unblock", GREEN)
                            } else if on_ring {
                                ("◐ mark waiting-for", egui::Color32::from_rgb(255, 193, 74))
                            } else if hot {
                                ("click to complete", GREEN)
                            } else if waiting {
                                ("waiting on someone else", egui::Color32::from_rgb(255, 193, 74))
                            } else {
                                ("next action", ORANGE)
                            };
                            pt.text(
                                egui::pos2(rect.left() + 28.0, rect.center().y + 9.0),
                                egui::Align2::LEFT_CENTER,
                                msg,
                                egui::FontId::proportional(8.0),
                                mc,
                            );
                        }
                        if resp.clicked() && !done {
                            if on_ring {
                                desk_wait = Some((proj.name.clone(), tname.clone()));
                            } else {
                                desk_complete = Some((proj.name.clone(), tname.clone()));
                            }
                        }
                    });
            }
        } else {
        // dashboard utility: hovering a star answers; clicking it dives
        let mut dive_click: Option<usize> = None;
        // GHOST CONSTELLATION — 7-day foresight, pure labeled arithmetic:
        // global pace allocated across open work, projected per project
        let vel7 = self.ops.velocity_per_day() * 7.0;
        let total_open = self.ops.open_tasks().max(1);

        // ── LABEL RESOLVE ─────────────────────────────────────────────────
        // The slot atlas places the STARS. It does not place their NAMES, and a
        // name is ~140px of text hanging off a 24px disc — so two stars a
        // comfortable distance apart can still stack their labels. A captured
        // frame had four pile-ups dead centre ("OrangeEye Vision" written
        // through "To build the future"), in the one region the operator reads
        // first. A card would fix it; cards are forbidden here — "noooo fucking
        // boxes". So the LABELS move instead: right of the star by default,
        // flipped left when that side is taken, nudged vertically only when
        // both sides are. Resolved once per frame against the same inputs, so
        // it is stable — a label that flicks between sides on alternate frames
        // is worse than one that overlaps. Flipped labels are right-aligned to
        // the star, which holds even where the width estimate is short.
        let stars: Vec<egui::Pos2> = view2
            .iter()
            .take(MAX_BODIES - 1)
            .map(|p| {
                let (sx, sy) = SLOTS[p.slot.min(SLOTS.len() - 1)];
                let (fx, fy) = stage_frac(sx, sy, sw, sh);
                egui::pos2(
                    (fx * sw).clamp(272.0, (sw - 285.0 - 178.0).max(300.0)),
                    (fy * sh).clamp(170.0, sh - 210.0),
                )
            })
            .collect();
        // The stage's own panels are obstacles too. Labels were resolved against
        // each other and against stars, and against nothing else — so a name
        // could still be placed straight through LIVING CANVAS, which is exactly
        // what happened. These panels draw EARLIER in this same update(), and
        // `panel_inline` records its rect on the way out, so reading them back
        // here is same-frame truth — NOT the stale cross-frame `area_rect()`
        // lookup that caused the third collision. Seeding them as pre-taken
        // means every label routes around them for free.
        let mut taken: Vec<egui::Rect> = ["bottom-trail"]
            .iter()
            .filter_map(|t| {
                ctx.memory(|m| m.data.get_temp::<egui::Rect>(egui::Id::new(("cluster-rect", *t))))
            })
            .collect();
        // THE DEPARTMENT RING IS AN OBSTACLE TOO. Its chips draw AFTER the
        // constellation, so there is no rect to read back — but their positions
        // are pure arithmetic on screen size, so the resolver can compute them
        // instead of looking them up. Adding the role names in wave 81 widened
        // each chip to ~170px, and they promptly started printing through star
        // labels ("BD 25 BUILDER Code Writer" across "AESee Living Dashboard").
        // Only the six that actually RENDER count: a department with no number
        // is skipped down there, so reserving space for it here would push
        // labels around an obstacle that is not on the screen.
        {
            let rc = egui::pos2(0.5 * sw, 0.46 * sh);
            for (i, (glyph, _n, _r)) in DEPTS.iter().enumerate() {
                if !matches!(*glyph, "BD" | "JD" | "MR" | "VT" | "ST" | "LP") {
                    continue;
                }
                let ang = (i as f32) / 8.0 * std::f32::consts::TAU
                    - std::f32::consts::FRAC_PI_2
                    + std::f32::consts::FRAC_PI_8;
                let p = rc + egui::vec2(ang.cos() * 0.192 * sw, ang.sin() * 0.215 * sh);
                taken.push(egui::Rect::from_min_size(
                    p - egui::vec2(18.0, 13.0),
                    egui::vec2(174.0, 26.0),
                ));
            }
        }
        // (flip-left, vertical nudge) — in preference order, but scored not
        // first-fit: see the cost loop below for why that distinction mattered.
        const LCAND: [(bool, f32); 10] = [
            (false, -8.0),
            (true, -8.0),
            (false, 30.0),
            (true, 30.0),
            (false, -46.0),
            (true, -46.0),
            (false, 64.0),
            (true, 64.0),
            (false, -80.0),
            (true, -80.0),
        ];
        let lrect = |s: egui::Pos2, flip: bool, dy: f32, w: f32, h: f32| {
            egui::Rect::from_min_size(
                egui::pos2(if flip { s.x - 30.0 - w } else { s.x + 30.0 }, s.y + dy - 9.0),
                egui::vec2(w, h),
            )
        };
        let label_fit: Vec<(bool, f32, f32)> = view2
            .iter()
            .take(MAX_BODIES - 1)
            .enumerate()
            .map(|(i, p)| {
                let held = p.tasks.iter().filter(|t| !t.done && t.waiting).count();
                let w = (p.name.chars().count() as f32 * 6.6).clamp(96.0, 196.0);
                // reserve what is actually DRAWN: name, plus the waiting line
                // when there is one. The pill is hover/featured only now, so
                // reserving its row would pack the field for ink that is not on
                // the screen — the mirror of the mistake of not reserving the
                // ring at all.
                let h = if held > 0 { 32.0 } else { 20.0 };
                // SCORED, not first-fit. The first version took the first clean
                // candidate and otherwise fell back to LCAND[0] — the plain
                // right-of-star position, i.e. the colliding one. In the sparse
                // right half every star found a clean seat and it looked fixed;
                // in the dense centre every candidate was blocked, so four
                // labels took the fallback and printed straight through each
                // other exactly as before. A fallback that is the failing case
                // is not a fallback. Now every candidate is scored by the area
                // it would actually overlap and the least-bad one wins, so the
                // crowded case degrades smoothly instead of collapsing. Ties go
                // to the earlier candidate, keeping the natural right-of-star
                // reading whenever it costs nothing.
                let mut best = (LCAND[0].0, LCAND[0].1, w);
                let mut best_cost = f32::INFINITY;
                for (flip, dy) in LCAND {
                    let r = lrect(stars[i], flip, dy, w, h);
                    // never let a label leave the stage into either rail. The
                    // right bound is the SAME 463px the star clamp uses; the
                    // earlier 278 let a label run ~190px under the rail — latent
                    // only because no star sat far enough right to expose it.
                    if r.left() < 262.0 || r.right() > sw - 466.0 {
                        continue;
                    }
                    let mut cost: f32 = taken
                        .iter()
                        .map(|o| {
                            let x = o.intersect(r);
                            if x.is_positive() { x.width() * x.height() } else { 0.0 }
                        })
                        .sum();
                    // sitting on another star is worse than clipping a label:
                    // the disc is the object, the text is only its name
                    cost += stars
                        .iter()
                        .enumerate()
                        .filter(|(j, sp)| *j != i && r.expand(5.0).contains(**sp))
                        .count() as f32
                        * 1400.0;
                    if cost + 0.5 < best_cost {
                        best_cost = cost;
                        best = (flip, dy, w);
                    }
                    if cost == 0.0 {
                        break;
                    }
                }
                taken.push(lrect(stars[i], best.0, best.1, w, h));
                best
            })
            .collect();

        for (i, p) in view2.iter().take(MAX_BODIES - 1).enumerate() {
            let (sx, sy) = SLOTS[p.slot.min(SLOTS.len() - 1)];
            let (fx, fy) = stage_frac(sx, sy, sw, sh);
            // clamp so the card body never enters the rails
            let pos = egui::pos2(
                (fx * sw).clamp(272.0, (sw - 285.0 - 178.0).max(300.0)),
                (fy * sh).clamp(170.0, sh - 210.0),
            );
            let (pill, pill_c) = match p.state {
                PState::Building => ("BUILDING", ORANGE),
                PState::Hold => ("ON HOLD", MUTED),
                PState::Complete => ("COMPLETE", GREEN),
            };
            let progress = p.progress();
            // honest 7-day ghost: this project's share of the global pace
            let ghost_pct: Option<u32> = if vel7 > 0.0
                && p.state == PState::Building
                && !p.tasks.is_empty()
            {
                let open_here = p.tasks.iter().filter(|t| !t.done).count();
                if open_here == 0 {
                    None
                } else {
                    let share = open_here as f32 / total_open as f32;
                    let add = (vel7 * share) / p.tasks.len() as f32 * 100.0;
                    Some(((progress as f32 + add).min(100.0)) as u32)
                }
            } else {
                None
            };
            // NO BOX — the project IS a star: progress closes as an arc of light
            // around its mass; its name floats beside it in dimmed space
            egui::Area::new(egui::Id::new(("card", i)))
                .fixed_pos(pos - egui::vec2(30.0, 30.0))
                .show(ctx, |ui| {
                    // the star is a CONTROL: hover = task x-ray, click = dive
                    let (_zone, resp) =
                        ui.allocate_exact_size(egui::vec2(60.0, 60.0), egui::Sense::click());
                    let pt = ui.painter();
                    if resp.clicked() {
                        dive_click = Some(i);
                    }
                    // the ghost arc — where this star sits in 7 days at pace
                    if let Some(g) = ghost_pct {
                        if g > progress {
                            panels::arc_stroke(
                                &pt,
                                pos,
                                24.0,
                                -std::f32::consts::FRAC_PI_2 + (progress as f32 / 100.0) * std::f32::consts::TAU,
                                -std::f32::consts::FRAC_PI_2 + (g as f32 / 100.0) * std::f32::consts::TAU,
                                egui::Stroke::new(1.0, egui::Color32::from_rgba_unmultiplied(255, 255, 255, 46)),
                            );
                        }
                    }
                    if resp.hovered() {
                        let open: Vec<_> = p.tasks.iter().filter(|t| !t.done).take(5).collect();
                        let extra = if ghost_pct.is_some() { 1 } else { 0 };
                        let base = pos + egui::vec2(34.0, 20.0);
                        panels::dim_halo(
                            &pt,
                            base + egui::vec2(78.0, 6.0 + (open.len() + extra) as f32 * 7.0),
                            104.0,
                            14.0 + (open.len() + extra) as f32 * 8.0,
                            195,
                        );
                        if open.is_empty() {
                            pt.text(base, egui::Align2::LEFT_TOP, "all tasks complete",
                                egui::FontId::proportional(9.5), GREEN);
                        }
                        for (k, task) in open.iter().enumerate() {
                            pt.text(base + egui::vec2(0.0, (k as f32) * 14.0), egui::Align2::LEFT_TOP,
                                format!("· {}", task.name), egui::FontId::proportional(9.5), BONE);
                        }
                        if let Some(g) = ghost_pct {
                            pt.text(
                                base + egui::vec2(0.0, (open.len() as f32) * 14.0),
                                egui::Align2::LEFT_TOP,
                                format!("≈ {g}% in 7d · at pace"),
                                egui::FontId::proportional(8.5),
                                egui::Color32::from_rgb(255, 193, 74),
                            );
                        }
                    }
                    // the conductor's eye rests here — the featured star carries it
                    let featured = self.comp_feature.as_deref() == Some(p.name.as_str());
                    if featured {
                        panels::arc_stroke(&pt, pos, 31.0, 0.0, std::f32::consts::TAU,
                            egui::Stroke::new(1.0, egui::Color32::from_rgba_unmultiplied(120, 210, 255, 70)));
                    }
                    // faint full track + the truth-lit progress arc
                    panels::arc_stroke(&pt, pos, 24.0, 0.0, std::f32::consts::TAU,
                        egui::Stroke::new(0.8, egui::Color32::from_white_alpha(16)));
                    panels::arc_stroke(&pt, pos, 24.0, -std::f32::consts::FRAC_PI_2,
                        -std::f32::consts::FRAC_PI_2 + (progress as f32 / 100.0) * std::f32::consts::TAU,
                        egui::Stroke::new(if featured { 3.0 } else { 2.2 }, pill_c));
                    // resolved placement — see LABEL RESOLVE above
                    let (lflip, ldy, lw) = label_fit[i];
                    let lanch = |dy: f32| {
                        egui::pos2(if lflip { pos.x - 30.0 } else { pos.x + 32.0 }, pos.y + dy)
                    };
                    let lalign = if lflip { egui::Align2::RIGHT_CENTER } else { egui::Align2::LEFT_CENTER };
                    // the halo rides with the text so the name always has ground
                    panels::dim_halo(
                        &pt,
                        egui::pos2(
                            if lflip { pos.x - 34.0 - lw * 0.5 } else { pos.x + 36.0 + lw * 0.5 },
                            pos.y + ldy + 6.0,
                        ),
                        lw * 0.5 + 14.0,
                        22.0,
                        110,
                    );
                    pt.text(lanch(ldy), lalign,
                        &p.name, egui::FontId::proportional(if featured { 12.5 } else { 11.5 }), BONE);
                    // BLOCKED WORK IS VISIBLE FROM ORBIT: a star whose tasks wait
                    // on other people should say so without a dive — that is the
                    // difference between "this project is slow" and "this project
                    // is not mine to move right now".
                    let held = p.tasks.iter().filter(|t| !t.done && t.waiting).count();
                    // THE PILL IS DUPLICATED DATA. Every star carried
                    // "BUILDING · 60%" while PROJECT NEXUS printed the identical
                    // percentage as a bar two feet to the right — and that
                    // second line is what made each label a 34px block instead
                    // of a 14px one. Adding the department ring as an obstacle
                    // (correctly) then had nowhere left to put them, and labels
                    // started colliding with each other instead.
                    // The NAME is identity and must always show; the percentage
                    // is detail, so it appears for the star the conductor is
                    // featuring and for whatever the operator points at. Halving
                    // label height is worth more than any packing algorithm —
                    // the cheapest way to solve a crowding problem is to stop
                    // printing the same fact twice.
                    if featured || resp.hovered() {
                        pt.text(lanch(ldy + 14.0), lalign,
                            format!("{pill} · {progress}%"), egui::FontId::proportional(8.5), pill_c);
                    }
                    if held > 0 {
                        pt.text(
                            // rides directly under the name now that the pill
                            // only appears on hover — blocked work must stay
                            // visible from orbit without waiting for a pointer
                            lanch(ldy + if featured || resp.hovered() { 26.0 } else { 14.0 }),
                            lalign,
                            format!("◐ {held} waiting on others"),
                            egui::FontId::proportional(8.0),
                            egui::Color32::from_rgb(255, 193, 74),
                        );
                    }
                });
        }
        // apply the dive AFTER the loop (live view only — the past is read-only)
        if self.scrub.is_none() {
            if let Some(pi) = dive_click {
                self.focus = Some(pi);
            }
        }
        }
        // ── DIRECT MANIPULATION: a card touched at the desk becomes real work
        // (borrow of the view has ended here — the brain may be mutated)
        if let Some((pn, tn)) = desk_wait {
            if self.scrub.is_none() {
                self.ops.toggle_waiting(&pn, &tn);
            }
        }
        if let Some((pn, tn)) = desk_complete {
            if self.scrub.is_none() && self.ops.complete_named(&pn, &tn) {
                self.surge = (self.surge + 0.9).min(1.6);
                self.comp_feature = Some(pn.clone());
                self.generating_until =
                    Some(std::time::Instant::now() + std::time::Duration::from_secs(2));
                if let Some(p) = self.ops.projects.iter().find(|p| p.name == pn) {
                    let (sx, sy) = SLOTS[p.slot.min(SLOTS.len() - 1)];
                    let (bx, by) = stage_frac(sx, sy, sw, sh);
                    self.bloom = Some((bx, by, std::time::Instant::now()));
                }
            }
        }


        // ── DEPARTMENT RING — 8 chips on the second orbital track.
        // SEMANTIC ZOOM: the org belongs to the PORTFOLIO altitude; at the desk
        // the board owns the stage and the ring stands down.
        let center = egui::pos2(0.5 * sw, 0.46 * sh);
        for (i, (glyph, name, role)) in DEPTS.iter().enumerate().filter(|_| self.focus.is_none()) {
            let ang = (i as f32) / 8.0 * std::f32::consts::TAU - std::f32::consts::FRAC_PI_2
                + std::f32::consts::FRAC_PI_8;
            // ON the web (AELID §22): agents ride close around the mind, inside the card flank
            // the department ring rides OUTSIDE the mind's bright zone: with the
            // core grown to 0.425 these chips were sitting on the protagonist,
            // which is exactly what the value structure forbids
            let pos = center + egui::vec2(ang.cos() * 0.192 * sw, ang.sin() * 0.215 * sh);
            // compact agent dots — presence ON the web (AELID §22), no panel collisions
            // ring parity with the queue drawer: every department that HAS a
            // derivable number shows it; the rest stay honestly silent
            let count = match *glyph {
                "BD" => Some((self.ops.open_tasks(), ORANGE)),
                "JD" => Some((self.ops.completes(), GREEN)),
                "MR" => Some((self.ops.holds(), MUTED)),
                "VT" => Some((self.ops.receipts_written, BONE)),
                "ST" => Some((self.ops.journal.len(), CYAN_V)),
                "LP" => Some((self.ops.feed.len(), CYAN_V)),
                _ => None,
            };
            // A DEPARTMENT WITHOUT A NUMBER IS NOT AN INSTRUMENT — it is a label
            // orbiting the mind for decoration. Only load that actually exists
            // earns a seat on the ring (HP/MF return when their wires are real).
            if count.is_none() {
                continue;
            }
            egui::Area::new(egui::Id::new(("dept", i)))
                .fixed_pos(pos - egui::vec2(16.0, 12.0))
                .show(ctx, |ui| {
                    ui.horizontal(|ui| {
                        ui.spacing_mut().item_spacing.x = 4.0;
                        ui.label(
                            egui::RichText::new(format!("◍ {glyph}"))
                                .color(CYAN_V).size(10.0).monospace().strong(),
                        );
                        if let Some((n, c)) = count {
                            ui.label(egui::RichText::new(n.to_string()).color(c).size(9.0).monospace());
                        }
                        ui.label(egui::RichText::new(*name).color(egui::Color32::from_rgba_unmultiplied(200, 210, 235, 120)).size(7.5));
                        // the atlas seats that used to open the deleted drawer
                        // now brighten the ring instead: same intent — "this room
                        // is about the departments" — carried by the presence
                        // already on the web rather than by a panel. A preset
                        // flag that drives nothing is a lie in the data model,
                        // and these are the operator's authored seats.
                        if ps.show_queue {
                            ui.label(
                                egui::RichText::new(*role)
                                    .color(egui::Color32::from_rgba_unmultiplied(150, 200, 255, 96))
                                    .size(7.0)
                                    .italics(),
                            );
                        }
                    });
                });
        }

        // ── COMMAND — capsule + modes (honest: BUILD armed only at gateway) ──
        egui::Area::new(egui::Id::new("command"))
            .anchor(egui::Align2::CENTER_BOTTOM, egui::vec2(0.0, -40.0))
            .show(ctx, |ui| {
                // TWELFTH COSTUME, and it was in EVERY capture tonight while I
                // looked past it. `glass()` sits in an unbounded Area, so the
                // capsule frame stretched to the full screen: its `set_min_width`
                // is a floor and nothing ever set a ceiling. Two visible
                // consequences, neither of which looked like a width bug —
                //   · the luminous thread is drawn across `response.rect`, so it
                //     ran ~890px and struck a line straight through IN FLIGHT in
                //     the right rail;
                //   · the ↑ send glyph rides the END of that row, so it landed
                //     ~400px away on top of PACE.
                // I twice explained these away as scene filaments. A stray mark
                // in a rail is a LAYOUT fact until proven otherwise — the field
                // never draws inside the rails.
                // AND `set_max_width` DOES NOT BIND HERE — that was my third
                // attempt at this class tonight and the second time this exact
                // call did nothing. The mechanism, finally: `vertical_centered`
                // CLAIMS all available width in order to centre within it, and
                // inside a free-floating Area "available" is the whole screen.
                // A ceiling set on the ui does not survive a child that asks for
                // everything. The only reliable bound is an EXPLICIT ALLOCATION.
                // Doctrine already said it: when two attempts to constrain a
                // symptom fail, the rule is wrong. Here the rule is that you
                // cannot bound an Area from the inside — you allocate a size.
                ui.allocate_ui_with_layout(
                    egui::vec2(600.0, 0.0),
                    egui::Layout::top_down(egui::Align::Center),
                    |ui| {
                    // ── THE EXCHANGE — talk mode's answers, as light above the
                    // capsule. Shipping a chat that could send but had nowhere to
                    // SHOW a reply was half a feature; the plumbing existed since
                    // the early hours and nothing ever drew it.
                    if self.talk && !self.chat.is_empty() {
                        let shown: Vec<&(bool, String)> =
                            self.chat.iter().rev().take(4).rev().collect();
                        let ckey = egui::Id::new(("halo", "exchange"));
                        if let Some(r) = ctx.memory(|m| m.data.get_temp::<egui::Rect>(ckey)) {
                            panels::dim_halo(&ui.painter(), r.center(), r.width() * 0.60, r.height() * 0.70, 185);
                        }
                        let out = ui.vertical(|ui| {
                            ui.set_max_width(560.0);
                            for (from_operator, line) in shown {
                                let mut text: String = line.chars().take(300).collect();
                                if line.chars().count() > 300 { text.push('…'); }
                                ui.label(
                                    egui::RichText::new(if *from_operator {
                                        format!("▸ {text}")
                                    } else {
                                        text
                                    })
                                    .color(if *from_operator { MUTED } else { BONE })
                                    .size(if *from_operator { 9.0 } else { 10.5 }),
                                );
                                ui.add_space(2.0);
                            }
                            if self.chat_rx.is_some() {
                                ui.label(egui::RichText::new("navigator thinking…").color(CYAN_V).size(8.5).italics());
                            }
                        });
                        ctx.memory_mut(|m| m.data.insert_temp(ckey, out.response.rect));
                        ui.add_space(6.0);
                    }
                    ui.label(egui::RichText::new(if self.talk { "T A L K" } else { "C O M M A N D" }).color(DIMC).size(8.0));
                    // NO BOX — the order rides a single luminous thread
                    let ckey = egui::Id::new(("halo", "command"));
                    if let Some(r) = ctx.memory(|m| m.data.get_temp::<egui::Rect>(ckey)) {
                        panels::dim_halo(&ui.painter(), r.center(), r.width() * 0.56, r.height() * 1.1, 150);
                    }
                    let mut te_rect = egui::Rect::NOTHING;
                    let out = glass().show(ui, |ui| {
                        ui.set_min_width(540.0);
                        ui.horizontal(|ui| {
                            // LIVE: the order goes straight into the operations brain
                            let resp = ui.add(
                                egui::TextEdit::singleline(&mut self.order_text)
                                    .desired_width(490.0)
                                    .frame(false)
                                    .text_color(BONE)
                                    .hint_text(if self.talk {
                                        "Ask the navigator…  (T returns to ordering)"
                                    } else if self.focus.is_some() {
                                        "Capture a task onto this board…"
                                    } else {
                                        "Order the universe — describe what to build…  (T to ask)"
                                    }),
                            );
                            if resp.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter)) {
                                let idea = self.order_text.trim().to_string();
                                // GTD CAPTURE: at the desk the capsule adds a TASK
                                // to the open project; at the portfolio it creates
                                // a project. Same box, altitude-aware — the input
                                // means what the altitude says it means.
                                if !idea.is_empty() {
                                    if self.talk {
                                        // ASKING, not ordering — nothing is built
                                        self.send_chat(idea);
                                        self.order_text.clear();
                                    } else if let Some(pi) = self.focus.filter(|pi| *pi < self.ops.projects.len()) {
                                        let pn = self.ops.projects[pi].name.clone();
                                        self.ops.add_task(&pn, &idea);
                                        self.surge = (self.surge + 0.4).min(1.6);
                                        self.order_text.clear();
                                    } else {
                                    self.ops.create(&idea);
                                    // create inserts at index 0 — keep a dived view on ITS project
                                    self.focus = self.focus.map(|f| f + 1);
                                    self.surge = (self.surge + 0.7).min(1.6);
                                    // real work in flight: template build + spine handshake subprocess
                                    self.thinking_until = Some(
                                        std::time::Instant::now() + std::time::Duration::from_millis(1800),
                                    );
                                    self.order_text.clear();
                                    }
                                }
                            }
                            te_rect = resp.rect;
                        });
                    });
                    ctx.memory_mut(|m| m.data.insert_temp(ckey, out.response.rect));
                    let r = out.response.rect;
                    // DRAWN FROM THE LEFT EDGE AT A FIXED LENGTH — the only thing
                    // here that egui cannot stretch. Every width I could ask for
                    // turned out to be the container's: the frame rect, and then
                    // `te_rect` too, because `desired_width(490)` did not hold
                    // the TextEdit either — it measured ~870. Five attempts, five
                    // inherited widths.
                    // So nothing is asked. The capsule's left edge is real and
                    // stable, the hint text is ~540px, and the thread is drawn
                    // 560 from there with the send arrow just past its end. When
                    // a toolkit will not tell you a width you can trust, stop
                    // requesting one and DECLARE the geometry.
                    // SCREEN COORDINATES. Even `r.left()` was inherited — anchored
                    // to it, the thread still reached the right rail. SIX widths
                    // asked for, six the container's: frame rect, allocation,
                    // desired_width, te_rect, r.left(). Nothing inside this
                    // subtree reports a geometry I can trust, so the last
                    // dependency goes too.
                    // The STAGE constants (x=262 to 463px off the right edge) are
                    // the same ones the star clamp and label resolver use.
                    // HONEST CAVEAT — do not trust the arithmetic here: the
                    // thread RENDERS ~345px wide, not the 560 this code asks
                    // for, which means this painter is not in the screen space
                    // the code assumes. The OUTCOME is verified by pixel receipt
                    // (2026-07-29_063447): thread under the input, arrow at its
                    // end, both rails clean. The MODEL is not verified.
                    // So: measured-correct, not proven-correct. If this ever
                    // needs to move, re-derive it from a capture rather than
                    // from these numbers — and do not write "by construction"
                    // over geometry whose construction you could not confirm.
                    // Vertical position still comes from the frame, because the
                    // frame's HEIGHT was never the thing that lied.
                    let _ = te_rect;
                    let sw_now = ctx.screen_rect().width();
                    let stage_cx = (262.0 + (sw_now - 463.0)) * 0.5;
                    let half = 280.0f32.min((sw_now - 463.0 - 262.0) * 0.5 - 30.0);
                    let y = r.bottom() - 4.0;
                    panels::filament(
                        &ui.painter(),
                        egui::pos2(stage_cx - half, y),
                        egui::pos2(stage_cx + half, y),
                        CYAN_V,
                    );
                    ui.painter().text(
                        egui::pos2(stage_cx + half + 12.0, y - 14.0),
                        egui::Align2::LEFT_CENTER,
                        "↑",
                        egui::FontId::proportional(14.0),
                        CYAN_V,
                    );
                    ui.add_space(4.0);
                    ui.horizontal(|ui| {
                        ui.spacing_mut().item_spacing.x = 10.0;
                        // WHAT ENTER ACTUALLY DOES — nothing more. DECIDE/VERIFY/
                        // SHIP used to sit here and BRIGHTEN when the gateway
                        // answered, implying they were armed. No code ever
                        // implemented them: three dead controls wearing the look
                        // of live ones, which is the exact failure this project
                        // forbids. The lifecycle still reads honestly as a
                        // diagram in the ORANGES PROCESS strip below.
                        let (verb, vc) = if self.talk {
                            ("◈ ASK — nothing is built", CYAN_V)
                        } else if self.focus.is_some() {
                            ("⬢ CAPTURE — task onto this board", ORANGE)
                        } else {
                            ("⬢ BUILD — an idea becomes a project", ORANGE)
                        };
                        ui.label(egui::RichText::new(verb).color(vc).size(10.0).strong());
                    });
                });
            });

        // ── TIME MACHINE — banner + scrubber strip while viewing the past ──
        if let Some(si) = self.scrub {
            let m = &self.ops.journal[si];
            egui::Area::new(egui::Id::new("temporal-banner"))
                .anchor(egui::Align2::CENTER_TOP, egui::vec2(0.0, 64.0))
                .show(ctx, |ui| {
                    let tkey = egui::Id::new(("halo", "temporal-banner"));
                    if let Some(r) = ctx.memory(|m| m.data.get_temp::<egui::Rect>(tkey)) {
                        panels::dim_halo(&ui.painter(), r.center(), r.width() * 0.62, r.height() * 1.1, 165);
                    }
                    let tout = ui.horizontal(|ui| {
                        ui.label(egui::RichText::new("⏪ TEMPORAL VIEW").color(egui::Color32::from_rgb(255, 193, 74)).size(11.0).strong());
                        ui.label(egui::RichText::new(format!("{}  ·  {}", m.ts, m.label)).color(BONE).size(11.0).monospace());
                        ui.label(egui::RichText::new(format!("  {}/{} · → returns to LIVE", si + 1, self.ops.journal.len())).color(DIMC).size(9.0));
                    });
                    ctx.memory_mut(|m| m.data.insert_temp(tkey, tout.response.rect));
                });
        }
        if !self.ops.journal.is_empty() {
            let n = self.ops.journal.len();
            let start = n.saturating_sub(64);
            let live = self.scrub.is_none();
            let scrub_now = self.scrub;
            // pre-collect: the closure must not borrow self (click writes scrub after)
            let nodes: Vec<(usize, bool, String)> = (start..n)
                .map(|i| {
                    let m = &self.ops.journal[i];
                    (i, m.label.starts_with("done"), format!("{} · {}", m.ts, m.label))
                })
                .collect();
            let mut click_scrub: Option<usize> = None;
            // ── SPIRAL TIME — the operator's Spiral Reasoning made visible:
            // every moment a node at the golden angle (bounded α), radius grown
            // by accumulated work (exact radial accounting). Hover = x-ray the
            // moment; click = walk the spiral there (time travel). ←→ still work.
            panels::panel(ctx, "p-temporal", egui::Align2::CENTER_BOTTOM, egui::vec2(0.0, -96.0), "⧗", "SPIRAL TIME", |ui| {
                let (rect, resp) =
                    ui.allocate_exact_size(egui::vec2(250.0, 132.0), egui::Sense::click());
                let pt = ui.painter();
                let c = rect.center() + egui::vec2(0.0, 4.0);
                let nn = nodes.len().max(1) as f32;
                // ONE SMOOTH ARM (v2): archimedean r = r0 + k·θ, moments in time
                // order ALONG the arm — the golden-angle chords read as scribble
                // (operator caught it); a spiral must LOOK like a spiral
                let turns = 2.6f32;
                let rmax = 50.0;
                let arm = |f: f32| {
                    let theta = f * turns * std::f32::consts::TAU - std::f32::consts::FRAC_PI_2;
                    let r = 5.0 + f * rmax;
                    egui::pos2(c.x + theta.cos() * r * 1.55, c.y + theta.sin() * r * 0.82)
                };
                // the guide arm — densely sampled, fading in from the birth center
                let guide: Vec<egui::Pos2> = (0..=120).map(|s| arm(s as f32 / 120.0)).collect();
                for w in guide.windows(2).enumerate() {
                    let (s, seg) = w;
                    let a = (14.0 + 26.0 * (s as f32 / 120.0)) as u8;
                    pt.line_segment(
                        [seg[0], seg[1]],
                        egui::Stroke::new(0.8, egui::Color32::from_white_alpha(a)),
                    );
                }
                let posv: Vec<egui::Pos2> = (0..nodes.len())
                    .map(|k| arm((k as f32 + 0.5) / nn))
                    .collect();
                let hover = resp.hover_pos();
                for (k, (idx, done, label)) in nodes.iter().enumerate() {
                    let p = posv[k];
                    let is_scrub = Some(*idx) == scrub_now;
                    let newest = k + 1 == nodes.len();
                    let age = (k as f32 + 1.0) / nn; // old dim → new bright
                    let (rad, col) = if is_scrub {
                        (4.2, BONE)
                    } else if newest && live {
                        (3.2, panels::CYAN)
                    } else if *done {
                        (2.5, egui::Color32::from_rgba_unmultiplied(119, 209, 124, (110.0 + 145.0 * age) as u8))
                    } else {
                        (1.8, egui::Color32::from_rgba_unmultiplied(120, 180, 255, (70.0 + 150.0 * age) as u8))
                    };
                    pt.circle_filled(p, rad, col);
                    if let Some(h) = hover {
                        if h.distance(p) < 8.0 {
                            pt.circle_stroke(p, rad + 2.5, egui::Stroke::new(1.0, BONE));
                            panels::dim_halo(&pt, p + egui::vec2(78.0, -18.0), 100.0, 12.0, 205);
                            pt.text(
                                p + egui::vec2(10.0, -24.0),
                                egui::Align2::LEFT_CENTER,
                                label,
                                egui::FontId::proportional(8.5),
                                BONE,
                            );
                            if resp.clicked() {
                                click_scrub = Some(*idx);
                            }
                        }
                    }
                }
                ui.horizontal(|ui| {
                    ui.label(
                        egui::RichText::new(if live { "● LIVE" } else { "⏪ viewing the past" })
                            .color(if live { panels::GREEN } else { panels::AMBER })
                            .size(8.5)
                            .strong(),
                    );
                    // (no right-align: it stretched this panel 1000px across the
                    // frame chasing the window's width — same rule that stranded
                    // every metric value. State it beside the status, done.)
                    {
                        ui.label(
                            egui::RichText::new(format!("· {n} moments · hover x-rays · click travels"))
                                .color(panels::DIMC)
                                .size(8.0),
                        );
                    }
                });
            });
            if let Some(i2) = click_scrub {
                self.scrub = Some(i2);
            }
        }

        // ── ORANGES PROCESS — bottom-left lifecycle strip ──
        // (moved out of the left column: at 972p it sat on top of the estate
        // strip — the column belongs to the instruments)
        egui::Area::new(egui::Id::new("process"))
            .anchor(egui::Align2::CENTER_BOTTOM, egui::vec2(0.0, -2.0))
            .show(ctx, |ui| {
                ui.horizontal(|ui| {
                    ui.label(egui::RichText::new("●").color(GREEN).size(9.0));
                    ui.label(egui::RichText::new("ORANGES PROCESS").color(MUTED).size(8.5).strong());
                    for (i, s) in ["IDEATE", "SPEC", "BUILD", "VERIFY", "SHIP", "LEARN"].iter().enumerate() {
                        if i > 0 {
                            ui.label(egui::RichText::new("→").color(egui::Color32::from_rgb(60, 95, 130)).size(8.5));
                        }
                        ui.label(egui::RichText::new(*s).color(DIMC).size(8.5).strong());
                    }
                });
            });

        // (SYSTEM PULSE + INPUTS/OUTPUTS labels retired 2026-07-17 — decoration
        // without data; the operator's bar is usefulness with the beauty)

        // ── TITLE + THE VERDICT — the crown wears the judgment computed above
        // (the MARK + VERDICT head the left-rail stack — the last panel on that
        // edge still placed by a fixed offset, and it landed on the intent
        // header exactly as every other fixed offset eventually did.)

        // mindrest throttle: FULL 60 while you watch (motion must be liquid —
        // operator called 30fps judder "stalling"), deep rest when you look away
        let focused = ctx.input(|i| i.focused);
        ctx.request_repaint_after(std::time::Duration::from_millis(if focused { 16 } else { 250 }));
    }
}

fn main() -> eframe::Result {
    // LAYER QUARANTINE: this box's Vulkan loader injects a BROKEN Epic Games
    // overlay layer (EOSOverlayVkLayer JSON missing) into every Vulkan process;
    // injected implicit layers are the prime suspect for the intermittent
    // silent deaths. Disable ALL implicit layers for this process only.
    // (DX12 is not compiled into this eframe build — Vulkan is the path.)
    std::env::set_var("VK_LOADER_LAYERS_DISABLE", "~implicit~");
    // AUDIBLE DEATH LAW: wgpu logs device-loss/validation through `log`, which
    // is a no-op without a logger — the organism must never die mute again
    env_logger::builder().filter_level(log::LevelFilter::Warn).init();
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("Atomic Orange — Orange5 (native)")
            .with_inner_size([1280.0, 720.0])
            .with_min_inner_size([960.0, 540.0]),
        renderer: eframe::Renderer::Wgpu,
        ..Default::default()
    };
    eframe::run_native(
        "Atomic Orange",
        options,
        Box::new(|cc| Ok(Box::new(AtomicOrange::new(cc)))),
    )
}
