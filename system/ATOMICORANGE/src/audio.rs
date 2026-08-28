//! mindrest audio, native — the organism's voice. Harmonic-series drone (C2):
//! building work brightens upper partials, a blocked project beats at ~4.5Hz,
//! shipped work shimmers, completions swell. 1/f breathing. No transients, ever.
//! OFF by default; M toggles. Honest: the chord IS portfolio state.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::{Arc, Mutex};

#[derive(Clone, Copy, Default)]
pub struct Chord {
    pub building: f32, // 0..1 share of building projects
    pub blocked: f32,  // 0/1 any blocked
    pub done: f32,     // 0..1 shipped share
    pub surge: f32,    // work-heat (completion swell)
}

pub struct Engine {
    state: Arc<Mutex<Chord>>,
    stream: Option<cpal::Stream>,
    pub on: bool,
}

const ROOT: f32 = 65.41;
const PARTIALS: [f32; 7] = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 8.0];

impl Engine {
    pub fn new() -> Self {
        Engine { state: Arc::new(Mutex::new(Chord::default())), stream: None, on: false }
    }

    pub fn set(&self, c: Chord) {
        if let Ok(mut s) = self.state.lock() { *s = c; }
    }

    pub fn toggle(&mut self) -> bool {
        if self.on {
            self.stream = None; // drop = stop
            self.on = false;
        } else if let Some(st) = self.build_stream() {
            let _ = st.play();
            self.stream = Some(st);
            self.on = true;
        }
        self.on
    }

    fn build_stream(&self) -> Option<cpal::Stream> {
        let device = cpal::default_host().default_output_device()?;
        let cfg = device.default_output_config().ok()?;
        let rate = cfg.sample_rate().0 as f32;
        let ch = cfg.channels() as usize;
        let state = self.state.clone();
        let mut t: f64 = 0.0;
        let mut fade = 0.0f32; // 3s fade-in, no transient
        let stream = device
            .build_output_stream(
                &cfg.into(),
                move |out: &mut [f32], _| {
                    let c = state.lock().map(|g| *g).unwrap_or_default();
                    for frame in out.chunks_mut(ch) {
                        let tf = t as f32;
                        // 1/f master breathing
                        let pink = 0.5 * (tf * 0.05).sin() + 0.25 * (tf * 0.1).sin() + 0.125 * (tf * 0.2).sin();
                        let master = 0.14 * (0.82 + 0.18 * pink) * fade;
                        let mut s = 0.0f32;
                        for (i, p) in PARTIALS.iter().enumerate() {
                            let amp = match i {
                                0 => 0.22,
                                1 => 0.11,
                                2 => 0.073,
                                3 | 4 | 5 => 0.05 * c.building + 0.06 * c.surge,
                                _ => 0.04 * c.done,
                            };
                            s += amp * (tf * ROOT * p * std::f32::consts::TAU).sin();
                        }
                        // blocked tension: +4.5Hz against partial 5 — audible unease
                        if c.blocked > 0.0 {
                            s += 0.035 * c.blocked * (tf * (ROOT * 5.0 + 4.5) * std::f32::consts::TAU).sin();
                        }
                        let v = s * master;
                        for smp in frame.iter_mut() { *smp = v; }
                        t += 1.0 / rate as f64;
                        fade = (fade + 1.0 / (rate * 3.0)).min(1.0);
                    }
                },
                |e| eprintln!("[audio] {e}"),
                None,
            )
            .ok()?;
        Some(stream)
    }
}
