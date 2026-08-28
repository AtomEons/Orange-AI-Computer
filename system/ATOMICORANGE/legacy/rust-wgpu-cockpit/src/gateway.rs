//! gateway — N8 heartbeat, std-only (no reqwest). A background thread probes
//! OrangeBrain (127.0.0.1:1337 /healthz) every 7s; the UI reads one atomic.
//! Honest law: LIVE means a 200 answered THIS window; anything else = OFFLINE.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

pub struct Gateway {
    live: Arc<AtomicBool>,
    /// last probe round-trip in ms — REAL measured latency (u32::MAX = offline)
    latency: Arc<AtomicU32>,
}

impl Gateway {
    pub fn start() -> Self {
        let live = Arc::new(AtomicBool::new(false));
        let latency = Arc::new(AtomicU32::new(u32::MAX));
        let flag = live.clone();
        let lat = latency.clone();
        std::thread::spawn(move || {
            // DEBOUNCE: /v1/models live-probes both upstreams, so one slow reply
            // is not death. Alive on the FIRST success (good news is instant),
            // dead only after TWO consecutive failures (~14s of real silence).
            // Undebounced, a single blip fired ALERT and fail-stopped a working
            // autopilot mid-request — the signal was wrong, not the autopilot.
            let mut misses = 0u8;
            loop {
                let t0 = std::time::Instant::now();
                let ok = probe();
                if ok {
                    misses = 0;
                    flag.store(true, Ordering::Relaxed);
                    lat.store(t0.elapsed().as_millis().min(60_000) as u32, Ordering::Relaxed);
                } else {
                    misses = misses.saturating_add(1);
                    if misses >= 2 {
                        flag.store(false, Ordering::Relaxed);
                        lat.store(u32::MAX, Ordering::Relaxed);
                    }
                }
                std::thread::sleep(Duration::from_secs(7));
            }
        });
        Gateway { live, latency }
    }

    pub fn live(&self) -> bool {
        self.live.load(Ordering::Relaxed)
    }

    /// measured probe RTT in ms; None when offline
    pub fn latency_ms(&self) -> Option<u32> {
        match self.latency.load(Ordering::Relaxed) {
            u32::MAX => None,
            v => Some(v),
        }
    }
}

fn probe() -> bool {
    let addr = "127.0.0.1:1337".parse().ok();
    let Some(addr) = addr else { return false };
    let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_millis(400)) else {
        return false;
    };
    // /v1/models, NOT /healthz: the gateway's healthz HANGS (verified 2026-07-27
    // — models answers 200 instantly, healthz times out), so the organism read
    // OFFLINE against a fully live brain for this entire stretch. Probe the
    // endpoint that proves the thing we care about: can it serve models.
    let _ = s.set_read_timeout(Some(Duration::from_millis(2500)));
    if s.write_all(b"GET /v1/models HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").is_err() {
        return false;
    }
    let mut buf = [0u8; 64];
    match s.read(&mut buf) {
        Ok(n) if n > 12 => String::from_utf8_lossy(&buf[..n]).contains("200"),
        _ => false,
    }
}
