//! StatePreset atlas — the operator's proven architecture (React See-Suite, May 2026),
//! adopted native: presets mutate the ONE living shell; the same organism renders
//! differently per state. Not pages. Not routes. Moods.
//!
//! First five presets = the AELID anchor language (shared vocabulary across AELID,
//! the design lab, and native): Calm · Alert/Causality · Temporal Memory ·
//! Agent Queue · Living Canvas. Keys 1–5 dial them; [ and ] cycle.
//!
//! Honesty law: preset content is either REAL (the gateway-offline causality chain,
//! the repo receipts) or visibly labeled a preset sample. No fake metrics.

pub struct StatePreset {
    pub id: u8,
    pub name: &'static str,
    pub anchor: &'static str,
    /// organism arousal — scales accretion, rays, web brightness
    pub intensity: f32,
    /// field color lean (state weather): alert leans red, temporal leans cool
    pub bias: [f32; 3],
    /// orbital comet + ring-rider speed multiplier
    pub ring_speed: f32,
    /// Alert/Causality banner: a REAL chain when shown (gateway truth)
    pub alert: Option<&'static [&'static str]>,
    pub show_queue: bool,
    pub show_canvas: bool,
    pub show_temporal: bool,
    /// HAND-AUTHORED (a real room, tuned) vs still grid-derived. The operator's
    /// 72-state roadmap made visible: the app reports its own build-out honestly.
    pub graduated: bool,
}

pub const PRESETS: [StatePreset; 5] = [
    StatePreset {
        id: 1,
        name: "Calm Overview",
        anchor: "CALM",
        intensity: 1.0,
        bias: [0.0, 0.0, 0.0],
        ring_speed: 1.0,
        alert: None,
        show_queue: false,
        show_canvas: false,
        show_temporal: false,
        graduated: true,
    },
    StatePreset {
        id: 2,
        name: "Alert / Causality",
        anchor: "ALERT · CAUSALITY",
        intensity: 1.55,
        bias: [0.055, -0.004, -0.018],
        ring_speed: 1.7,
        // real chain — this is literally true while OrangeBrain is down
        alert: Some(&["GATEWAY OFFLINE", "0 MODELS SERVED", "COMMAND DISARMED", "ACTION: start OrangeLLM"]),
        show_queue: false,
        show_canvas: false,
        show_temporal: false,
        graduated: true,
    },
    StatePreset {
        id: 3,
        name: "Temporal Memory",
        anchor: "TEMPORAL MEMORY",
        intensity: 0.9,
        bias: [-0.012, -0.002, 0.030],
        ring_speed: 0.7,
        alert: None,
        show_queue: false,
        show_canvas: false,
        show_temporal: true,
        graduated: true,
    },
    StatePreset {
        id: 4,
        name: "Agent Queue",
        anchor: "AGENT QUEUE",
        intensity: 1.15,
        bias: [0.012, 0.006, 0.0],
        ring_speed: 1.25,
        alert: None,
        show_queue: true,
        show_canvas: false,
        show_temporal: false,
        graduated: true,
    },
    StatePreset {
        id: 5,
        name: "Living Canvas",
        anchor: "LIVING CANVAS",
        intensity: 1.05,
        bias: [0.020, 0.010, -0.006],
        ring_speed: 0.9,
        alert: None,
        show_queue: false,
        show_canvas: true,
        show_temporal: false,
        graduated: true,
    },
];

// (TEMPORAL_RECEIPTS deleted 2026-07-25 — sample receipt names were the last
// static content in the app. The temporal strip now reads REAL receipt files
// off the spine. No future wiring should reintroduce sample data.)

/// N4 — THE 72-STATE ATLAS (operator's See-Suite architecture). The 5 hand-tuned
/// AELID anchors + 67 systematic states. These are the BUILD-OUT ROADMAP: each is a
/// real seat to develop into its own distinct mood + content + wired data — NOT
/// filler. The procedural hue×energy grid is the scaffold; states graduate from
/// generated → hand-authored as they are built out (like the 5 anchors already are).
pub fn all() -> &'static Vec<StatePreset> {
    static ATLAS: std::sync::OnceLock<Vec<StatePreset>> = std::sync::OnceLock::new();
    ATLAS.get_or_init(|| {
        let mut v: Vec<StatePreset> = PRESETS.into_iter().collect();
        let hues: [(&str, [f32; 3]); 5] = [
            ("EMBER", [0.030, 0.008, -0.006]),
            ("VIOLET", [0.018, -0.004, 0.030]),
            ("TEAL", [-0.012, 0.020, 0.026]),
            ("ROSE", [0.030, -0.002, 0.016]),
            ("ICE", [-0.008, 0.010, 0.034]),
        ];
        let energies: [(&str, f32, f32); 5] = [
            ("REST", 0.72, 0.55),
            ("CALM", 0.90, 0.80),
            ("WORK", 1.10, 1.05),
            ("DRIVE", 1.35, 1.40),
            ("STORM", 1.60, 1.85),
        ];
        let mut id = 6u8;
        'outer: for depth in 0..3u8 {
            for (hn, hb) in hues.iter() {
                for (en, ei, er) in energies.iter() {
                    if v.len() >= 72 { break 'outer; }
                    // depth families give each seat real character:
                    // pure · DUSK (deeper color, slower orbit) · DAWN (lighter, quicker)
                    let (suffix, imul, rmul, bmul) = match depth {
                        0 => ("", 1.0, 1.0, 1.0),
                        1 => (" · DUSK", 0.88, 0.82, 1.45),
                        _ => (" · DAWN", 1.10, 1.18, 0.70),
                    };
                    let name: &'static str = Box::leak(format!("{hn} {en}{suffix}").into_boxed_str());
                    v.push(StatePreset {
                        id,
                        name,
                        anchor: Box::leak(format!("{hn} · {en}{suffix}").into_boxed_str()),
                        intensity: ei * imul,
                        bias: [hb[0] * bmul, hb[1] * bmul, hb[2] * bmul],
                        ring_speed: er * rmul,
                        alert: None,
                        // content surfaces mapped by ENERGY family (real surfaces,
                        // never fake data): resting states reflect, working marshal
                        show_queue: (*en == "WORK" || *en == "DRIVE") && depth == 0,
                        show_canvas: *en == "STORM" && depth == 2,
                        show_temporal: *en == "REST",
                        graduated: false, // grid-derived until hand-authored below
                    });
                    id += 1;
                }
            }
        }
        // ── SEAT GRADUATION (the operator's roadmap: generated seats become
        // hand-authored as they are built out). The ICE family graduates first
        // — it is the most canon-aligned (See-Suite blue) and the family the
        // conductor may walk. These five are TUNED, not derived: each is a
        // distinct room of the same organism.
        for p in v.iter_mut() {
            // every seat the table below tunes is a REAL room from here on
            p.graduated = matches!(
                p.anchor,
                "ICE · REST" | "ICE · CALM" | "ICE · WORK" | "ICE · DRIVE" | "ICE · STORM"
                    | "VIOLET · REST" | "VIOLET · CALM" | "VIOLET · WORK" | "VIOLET · DRIVE" | "VIOLET · STORM"
                    | "TEAL · REST" | "TEAL · CALM" | "TEAL · WORK" | "TEAL · DRIVE" | "TEAL · STORM"
            ) || p.graduated;
            match p.anchor {
                // ICE REST — the 4am room: almost still, breath only, memory open
                "ICE · REST" => {
                    p.intensity = 0.66; p.ring_speed = 0.38;
                    p.bias = [-0.014, 0.004, 0.030];
                    p.show_temporal = true; p.show_queue = false; p.show_canvas = false;
                }
                // ICE CALM — the reading room: quiet, wide, nothing demanded
                "ICE · CALM" => {
                    p.intensity = 0.88; p.ring_speed = 0.72;
                    p.bias = [-0.010, 0.008, 0.034];
                    p.show_temporal = false; p.show_queue = false; p.show_canvas = false;
                }
                // ICE WORK — the bench: rings quicken, the queue is present
                "ICE · WORK" => {
                    p.intensity = 1.12; p.ring_speed = 1.18;
                    p.bias = [-0.006, 0.014, 0.036];
                    p.show_queue = true; p.show_temporal = false; p.show_canvas = false;
                }
                // ICE DRIVE — the push: cold fire, everything moving, output shown
                "ICE · DRIVE" => {
                    p.intensity = 1.38; p.ring_speed = 1.52;
                    p.bias = [-0.002, 0.020, 0.042];
                    p.show_queue = true; p.show_canvas = true; p.show_temporal = false;
                }
                // ICE STORM — the surge: maximum cold energy, artifacts on stage
                "ICE · STORM" => {
                    p.intensity = 1.58; p.ring_speed = 1.86;
                    p.bias = [0.004, 0.026, 0.048];
                    p.show_canvas = true; p.show_queue = true; p.show_temporal = false;
                }

                // ── VIOLET family: the THINKING rooms. Where ICE is clarity,
                // violet is depth — the color of a mind turned inward. Slower
                // rings than ICE at equal energy: thought, not execution.
                // VIOLET REST — the dream: deepest indigo, rings nearly stopped
                "VIOLET · REST" => {
                    p.intensity = 0.62; p.ring_speed = 0.30;
                    p.bias = [0.010, -0.006, 0.038];
                    p.show_temporal = true; p.show_queue = false; p.show_canvas = false;
                }
                // VIOLET CALM — the study: warm-violet hush, memory within reach
                "VIOLET · CALM" => {
                    p.intensity = 0.84; p.ring_speed = 0.58;
                    p.bias = [0.014, -0.004, 0.036];
                    p.show_temporal = true; p.show_queue = false; p.show_canvas = false;
                }
                // VIOLET WORK — the long problem: steady, absorbed, queue near
                "VIOLET · WORK" => {
                    p.intensity = 1.08; p.ring_speed = 0.92;
                    p.bias = [0.018, -0.002, 0.034];
                    p.show_queue = true; p.show_temporal = false; p.show_canvas = false;
                }
                // VIOLET DRIVE — the breakthrough: violet fire, output emerging
                "VIOLET · DRIVE" => {
                    p.intensity = 1.34; p.ring_speed = 1.26;
                    p.bias = [0.024, 0.000, 0.040];
                    p.show_queue = true; p.show_canvas = true; p.show_temporal = false;
                }
                // VIOLET STORM — the vision: everything at once, artifacts shown
                "VIOLET · STORM" => {
                    p.intensity = 1.56; p.ring_speed = 1.58;
                    p.bias = [0.030, 0.002, 0.046];
                    p.show_canvas = true; p.show_queue = true; p.show_temporal = true;
                }

                // ── TEAL family: the VERIFYING rooms. The color of instruments
                // and proof — cool green-blue, the tone of a system checking
                // itself. Rings run FAST at low energy: scanning, not straining.
                // TEAL REST — the quiet audit: still, but the record is open
                "TEAL · REST" => {
                    p.intensity = 0.70; p.ring_speed = 0.66;
                    p.bias = [-0.016, 0.018, 0.026];
                    p.show_temporal = true; p.show_queue = false; p.show_canvas = false;
                }
                // TEAL CALM — the clean board: nothing wrong, nothing hidden
                "TEAL · CALM" => {
                    p.intensity = 0.90; p.ring_speed = 0.96;
                    p.bias = [-0.018, 0.024, 0.024];
                    p.show_temporal = false; p.show_queue = false; p.show_canvas = false;
                }
                // TEAL WORK — the checking: instruments lit, queue under review
                "TEAL · WORK" => {
                    p.intensity = 1.06; p.ring_speed = 1.34;
                    p.bias = [-0.020, 0.028, 0.022];
                    p.show_queue = true; p.show_temporal = true; p.show_canvas = false;
                }
                // TEAL DRIVE — the proving run: fast scan, evidence on stage
                "TEAL · DRIVE" => {
                    p.intensity = 1.28; p.ring_speed = 1.66;
                    p.bias = [-0.022, 0.034, 0.020];
                    p.show_queue = true; p.show_canvas = true; p.show_temporal = true;
                }
                // TEAL STORM — the full gauntlet: every surface up, all of it lit
                "TEAL · STORM" => {
                    p.intensity = 1.48; p.ring_speed = 1.92;
                    p.bias = [-0.024, 0.040, 0.018];
                    p.show_canvas = true; p.show_queue = true; p.show_temporal = true;
                }
                _ => {}
            }
        }

        // ── SECOND GRADUATION WAVE: the DUSK and DAWN hours of the three cool
        // families (2026-07-28). These are AUTHORED, not derived — the depth
        // suffix means something specific and the table states it seat by seat:
        //
        //   DUSK = the same room after dark. Energy falls, orbits slow, colour
        //          deepens toward indigo, and MEMORY opens — at dusk a system
        //          looks back at what it did.
        //   DAWN = the same room at first light. Energy lifts, orbits quicken,
        //          colour pales toward ice, and the QUEUE opens — at dawn a
        //          system looks forward at what it must do.
        //
        // Warm families (EMBER, ROSE) are deliberately NOT graduated: they stay
        // the operator's hand alone under the canon lock.
        const DUSK_DAWN: &[(&str, f32, f32, [f32; 3], bool, bool, bool)] = &[
            // anchor,                    intensity, rings, bias,                    queue, canvas, temporal
            ("ICE · REST · DUSK",         0.58, 0.30, [-0.018, 0.002, 0.040], false, false, true),
            ("ICE · CALM · DUSK",         0.76, 0.58, [-0.014, 0.006, 0.044], false, false, true),
            ("ICE · WORK · DUSK",         0.96, 0.94, [-0.010, 0.012, 0.046], true,  false, true),
            ("ICE · DRIVE · DUSK",        1.18, 1.22, [-0.006, 0.018, 0.050], true,  false, true),
            ("ICE · STORM · DUSK",        1.36, 1.50, [-0.002, 0.024, 0.054], true,  true,  true),
            ("ICE · REST · DAWN",         0.78, 0.52, [-0.010, 0.010, 0.022], true,  false, false),
            ("ICE · CALM · DAWN",         1.00, 0.92, [-0.008, 0.014, 0.026], true,  false, false),
            ("ICE · WORK · DAWN",         1.24, 1.40, [-0.004, 0.020, 0.028], true,  false, false),
            ("ICE · DRIVE · DAWN",        1.48, 1.74, [ 0.000, 0.026, 0.032], true,  true,  false),
            ("ICE · STORM · DAWN",        1.62, 2.02, [ 0.004, 0.032, 0.036], true,  true,  false),
            ("VIOLET · REST · DUSK",      0.54, 0.24, [ 0.014, -0.008, 0.048], false, false, true),
            ("VIOLET · CALM · DUSK",      0.72, 0.46, [ 0.018, -0.006, 0.046], false, false, true),
            ("VIOLET · WORK · DUSK",      0.92, 0.74, [ 0.022, -0.004, 0.044], true,  false, true),
            ("VIOLET · DRIVE · DUSK",     1.14, 1.00, [ 0.028, -0.002, 0.048], true,  false, true),
            ("VIOLET · STORM · DUSK",     1.34, 1.26, [ 0.034,  0.000, 0.052], true,  true,  true),
            ("VIOLET · REST · DAWN",      0.74, 0.44, [ 0.008, -0.002, 0.030], true,  false, false),
            ("VIOLET · CALM · DAWN",      0.96, 0.72, [ 0.010,  0.000, 0.028], true,  false, false),
            ("VIOLET · WORK · DAWN",      1.20, 1.10, [ 0.014,  0.002, 0.026], true,  false, false),
            ("VIOLET · DRIVE · DAWN",     1.44, 1.46, [ 0.020,  0.004, 0.030], true,  true,  false),
            ("VIOLET · STORM · DAWN",     1.58, 1.78, [ 0.026,  0.006, 0.034], true,  true,  false),
            ("TEAL · REST · DUSK",        0.60, 0.52, [-0.020, 0.014, 0.034], false, false, true),
            ("TEAL · CALM · DUSK",        0.78, 0.78, [-0.022, 0.018, 0.032], false, false, true),
            ("TEAL · WORK · DUSK",        0.94, 1.08, [-0.024, 0.022, 0.030], true,  false, true),
            ("TEAL · DRIVE · DUSK",       1.12, 1.34, [-0.026, 0.028, 0.028], true,  false, true),
            ("TEAL · STORM · DUSK",       1.28, 1.58, [-0.028, 0.034, 0.026], true,  true,  true),
            ("TEAL · REST · DAWN",        0.82, 0.82, [-0.012, 0.022, 0.018], true,  false, false),
            ("TEAL · CALM · DAWN",        1.02, 1.14, [-0.014, 0.028, 0.016], true,  false, false),
            ("TEAL · WORK · DAWN",        1.22, 1.56, [-0.016, 0.034, 0.014], true,  false, false),
            ("TEAL · DRIVE · DAWN",       1.42, 1.86, [-0.018, 0.040, 0.012], true,  true,  false),
            ("TEAL · STORM · DAWN",       1.56, 2.10, [-0.020, 0.046, 0.010], true,  true,  false),
        ];
        for p in v.iter_mut() {
            if let Some(row) = DUSK_DAWN.iter().find(|r| r.0 == p.anchor) {
                p.intensity = row.1;
                p.ring_speed = row.2;
                p.bias = row.3;
                p.show_queue = row.4;
                p.show_canvas = row.5;
                p.show_temporal = row.6;
                p.graduated = true;
            }
        }
        v
    })
}
