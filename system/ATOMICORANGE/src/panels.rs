//! panels — the instrument kit. Real information design, NO BOXES (operator law
//! 2026-07-17: "the composer's canvas is the entire screen … noooo fucking
//! boxes"): information lives as light in space — floating type over soft
//! atmospheric dimming, arcs, filaments, rings. LAW: every value MEASURED.

use eframe::egui;

/// soft atmospheric dimming — legibility without a rectangle. A TRUE radial
/// gradient (per-vertex mesh, GPU-interpolated dark→transparent): depth-of-field
/// darkness with zero banding. Flat polygons here read as 8-bit sprite shadows
/// (operator caught it) — never again.
pub fn dim_halo(p: &egui::Painter, center: egui::Pos2, rx: f32, ry: f32, strength: u8) {
    use eframe::egui::epaint::{Mesh, Vertex, WHITE_UV};
    let mut mesh = Mesh::default();
    let n: u32 = 32;
    mesh.vertices.push(Vertex {
        pos: center,
        uv: WHITE_UV,
        color: egui::Color32::from_black_alpha(strength),
    });
    // mid ring keeps the core dark before the falloff begins
    for i in 0..=n {
        let a = i as f32 / n as f32 * std::f32::consts::TAU;
        mesh.vertices.push(Vertex {
            pos: egui::pos2(center.x + a.cos() * rx * 0.45, center.y + a.sin() * ry * 0.45),
            uv: WHITE_UV,
            color: egui::Color32::from_black_alpha((strength as f32 * 0.85) as u8),
        });
    }
    for i in 0..=n {
        let a = i as f32 / n as f32 * std::f32::consts::TAU;
        mesh.vertices.push(Vertex {
            pos: egui::pos2(center.x + a.cos() * rx, center.y + a.sin() * ry),
            uv: WHITE_UV,
            color: egui::Color32::TRANSPARENT,
        });
    }
    let ring1 = 1u32; // first mid-ring vertex
    let ring2 = ring1 + n + 1; // first outer-ring vertex
    for i in 0..n {
        mesh.indices.extend_from_slice(&[0, ring1 + i, ring1 + i + 1]);
        mesh.indices.extend_from_slice(&[ring1 + i, ring2 + i, ring2 + i + 1]);
        mesh.indices.extend_from_slice(&[ring1 + i, ring2 + i + 1, ring1 + i + 1]);
    }
    p.add(egui::Shape::mesh(mesh));
}

/// a luminous thread — three layered strokes: wide faint glow, mid, crisp core
pub fn filament(p: &egui::Painter, a: egui::Pos2, b: egui::Pos2, c: egui::Color32) {
    for (w, alpha) in [(4.5, 26), (2.2, 70), (1.0, 190)] {
        p.line_segment(
            [a, b],
            egui::Stroke::new(w, egui::Color32::from_rgba_unmultiplied(c.r(), c.g(), c.b(), alpha)),
        );
    }
}

/// arc of light around a center (radians, clockwise from +x)
pub fn arc_stroke(p: &egui::Painter, c: egui::Pos2, r: f32, a0: f32, a1: f32, stroke: egui::Stroke) {
    let steps = (((a1 - a0).abs() * r / 3.0) as usize).clamp(6, 90);
    let pts: Vec<egui::Pos2> = (0..=steps)
        .map(|i| {
            let a = a0 + (a1 - a0) * (i as f32 / steps as f32);
            egui::pos2(c.x + a.cos() * r, c.y + a.sin() * r)
        })
        .collect();
    p.add(egui::Shape::line(pts, stroke));
}

pub const CYAN: egui::Color32 = egui::Color32::from_rgb(90, 200, 255);
pub const BONE: egui::Color32 = egui::Color32::from_rgb(246, 242, 235);
pub const MUTED: egui::Color32 = egui::Color32::from_rgb(143, 135, 128);
pub const DIMC: egui::Color32 = egui::Color32::from_rgb(95, 89, 82);
pub const GREEN: egui::Color32 = egui::Color32::from_rgb(119, 209, 124);
pub const AMBER: egui::Color32 = egui::Color32::from_rgb(255, 193, 74);
pub const RED: egui::Color32 = egui::Color32::from_rgb(255, 93, 86);
pub const VIOLET: egui::Color32 = egui::Color32::from_rgb(170, 130, 255);

/// AELID panel chrome: deep glass, cyan-lit top edge, glyph + title header.
/// The membrane the instruments live in — crisp, never a gray admin card.
pub fn panel<R>(
    ctx: &egui::Context,
    id: &str,
    anchor: egui::Align2,
    offset: egui::Vec2,
    glyph: &str,
    title: &str,
    body: impl FnOnce(&mut egui::Ui) -> R,
) {
    egui::Area::new(egui::Id::new(id))
        .anchor(anchor, offset)
        .show(ctx, |ui| panel_inline(ui, glyph, title, body));
}

/// same instrument content, drawn INSIDE an existing ui — NO BOX: a soft
/// atmospheric halo (last frame's measured rect) carries legibility; the
/// header floats as light; the body draws raw onto the stage
pub fn panel_inline<R>(
    ui: &mut egui::Ui,
    glyph: &str,
    title: &str,
    body: impl FnOnce(&mut egui::Ui) -> R,
) {
    {
            let key = egui::Id::new(("cluster-rect", title));
            let last: Option<egui::Rect> = ui.ctx().memory(|m| m.data.get_temp(key));
            if let Some(r) = last {
                dim_halo(ui.painter(), r.center(), r.width() * 0.66, r.height() * 0.64, 175);
            }
            let out = ui.vertical(|ui| {
                ui.horizontal(|ui| {
                    ui.label(egui::RichText::new(glyph).color(CYAN).size(10.0));
                    // TYPE CRAFT — tracked caps: the references' instrument
                    // headers breathe. Hair-space between letters, words kept
                    // apart by a wider gap. Titles only; data never tracked.
                    let tracked: String = title
                        .chars()
                        .map(|c| if c == ' ' { "  ".to_string() } else { format!("{c}\u{2009}") })
                        .collect();
                    ui.label(
                        egui::RichText::new(tracked.trim_end())
                            .color(BONE)
                            .size(9.5)
                            .strong(),
                    );
                });
                ui.add_space(5.0);
                body(ui)
            });
            // remember the real rect — next frame's halo is sized by THIS truth
            ui.ctx().memory_mut(|m| m.data.insert_temp(key, out.response.rect));
            // no chrome — a box's edge is still a box. The halo carries it.
    }
}

/// radial gauge — fraction 0..1 as a lit arc with the value burning at center
pub fn radial_gauge(ui: &mut egui::Ui, label: &str, frac: f32, text: &str, color: egui::Color32) {
    let size = 46.0;
    let (rect, _) = ui.allocate_exact_size(egui::vec2(size, size + 12.0), egui::Sense::hover());
    let p = ui.painter();
    let c = egui::pos2(rect.center().x, rect.top() + size / 2.0);
    let r = size / 2.0 - 4.0;
    let f = frac.clamp(0.0, 1.0);
    // track
    p.circle_stroke(c, r, egui::Stroke::new(3.0, egui::Color32::from_white_alpha(14)));
    // lit arc (gap at bottom like a meter)
    let start = 0.75 * std::f32::consts::TAU; // bottom
    let sweep = f * std::f32::consts::TAU;
    let steps = (40.0 * f).max(2.0) as usize;
    let pts: Vec<egui::Pos2> = (0..=steps)
        .map(|i| {
            let a = start + sweep * (i as f32 / steps as f32);
            egui::pos2(c.x + a.cos() * r, c.y + a.sin() * r)
        })
        .collect();
    p.add(egui::Shape::line(pts, egui::Stroke::new(3.0, color)));
    p.text(
        c,
        egui::Align2::CENTER_CENTER,
        text,
        egui::FontId::monospace(12.0),
        BONE,
    );
    p.text(
        egui::pos2(c.x, rect.bottom() - 4.0),
        egui::Align2::CENTER_CENTER,
        label,
        egui::FontId::proportional(8.0),
        MUTED,
    );
}

/// sparkline — a measured series as a thin lit line with a glow-dot on NOW
pub fn sparkline(ui: &mut egui::Ui, series: &[f32], w: f32, h: f32, color: egui::Color32) {
    let (rect, _) = ui.allocate_exact_size(egui::vec2(w, h), egui::Sense::hover());
    if series.len() < 2 {
        ui.painter().text(
            rect.center(),
            egui::Align2::CENTER_CENTER,
            "gathering…",
            egui::FontId::proportional(8.0),
            DIMC,
        );
        return;
    }
    let (mut lo, mut hi) = (f32::MAX, f32::MIN);
    for v in series {
        lo = lo.min(*v);
        hi = hi.max(*v);
    }
    if (hi - lo).abs() < 1e-6 {
        hi = lo + 1.0;
    }
    let p = ui.painter();
    let n = series.len();
    let pts: Vec<egui::Pos2> = series
        .iter()
        .enumerate()
        .map(|(i, v)| {
            let x = rect.left() + rect.width() * (i as f32 / (n - 1) as f32);
            let y = rect.bottom() - rect.height() * ((v - lo) / (hi - lo)).clamp(0.0, 1.0);
            egui::pos2(x, y)
        })
        .collect();
    let last = *pts.last().unwrap();
    p.add(egui::Shape::line(pts, egui::Stroke::new(1.3, color)));
    p.circle_filled(last, 2.0, color);
}

/// metric row — small-caps label, big mono number, optional unit
pub fn metric(ui: &mut egui::Ui, label: &str, value: &str, color: egui::Color32) {
    // A LABEL AND ITS VALUE ARE A PAIR. Right-aligning across the panel made
    // every value drift to whatever the widest row happened to be — on the
    // health panel that stranded "offline" 300px from the word GATEWAY.
    // Read as a pair, always, at any panel width.
    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 6.0;
        ui.label(egui::RichText::new(label).color(MUTED).size(8.5));
        ui.label(egui::RichText::new(value).color(color).size(11.5).monospace().strong());
    });
}

/// stage flow — the pipeline as lit stages with counts (IDEATE → … → LEARN)
pub fn flow(ui: &mut egui::Ui, stages: &[(&str, usize, bool)]) {
    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 6.0;
        for (i, (name, count, active)) in stages.iter().enumerate() {
            if i > 0 {
                ui.label(egui::RichText::new("›").color(DIMC).size(9.0));
            }
            let c = if *active { CYAN } else { DIMC };
            ui.vertical(|ui| {
                ui.label(egui::RichText::new(*name).color(c).size(8.0).strong());
                ui.label(
                    egui::RichText::new(count.to_string())
                        .color(if *active { BONE } else { DIMC })
                        .size(11.0)
                        .monospace(),
                );
            });
        }
    });
}

/// project bar — name, thin truth-lit progress, percent
pub fn project_bar(ui: &mut egui::Ui, name: &str, progress: u32, color: egui::Color32) {
    ui.horizontal(|ui| {
        ui.label(egui::RichText::new(name).color(BONE).size(9.5));
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            ui.label(
                egui::RichText::new(format!("{progress}%"))
                    .color(MUTED)
                    .size(9.0)
                    .monospace(),
            );
        });
    });
    let (bar, _) = ui.allocate_exact_size(egui::vec2(ui.available_width(), 3.0), egui::Sense::hover());
    let p = ui.painter();
    p.rect_filled(bar, 1.5, egui::Color32::from_white_alpha(12));
    let mut fill = bar;
    fill.set_width(bar.width() * (progress as f32 / 100.0));
    p.rect_filled(fill, 1.5, color);
    ui.add_space(3.0);
}

/// THE WORK RHYTHM — one lit column per day (real completions), today brightest.
/// Empty days show a dim floor tick: honest zero, never a hidden gap.
pub fn day_bars(ui: &mut egui::Ui, data: &[(String, usize)], w: f32, h: f32) {
    let (rect, _) = ui.allocate_exact_size(egui::vec2(w, h), egui::Sense::hover());
    if data.is_empty() {
        return;
    }
    let p = ui.painter();
    let peak = data.iter().map(|(_, n)| *n).max().unwrap_or(1).max(1) as f32;
    let n = data.len();
    let step = rect.width() / n as f32;
    for (i, (label, count)) in data.iter().enumerate() {
        let x = rect.left() + step * (i as f32 + 0.5);
        let today = i + 1 == n;
        let frac = *count as f32 / peak;
        let bh = 2.0 + frac * (h - 13.0);
        let col = if *count == 0 {
            egui::Color32::from_white_alpha(26)
        } else if today {
            BONE
        } else {
            egui::Color32::from_rgba_unmultiplied(119, 209, 124, (120.0 + 120.0 * frac) as u8)
        };
        p.line_segment(
            [
                egui::pos2(x, rect.bottom() - 10.0),
                egui::pos2(x, rect.bottom() - 10.0 - bh),
            ],
            egui::Stroke::new(if today { 3.0 } else { 2.2 }, col),
        );
        p.text(
            egui::pos2(x, rect.bottom() - 4.0),
            egui::Align2::CENTER_CENTER,
            label,
            egui::FontId::proportional(7.0),
            if today { MUTED } else { DIMC },
        );
    }
}

/// dense event tick-strip — the journal as a timeline of lit moments
pub fn tick_strip(ui: &mut egui::Ui, ticks: &[(bool, bool)], w: f32) {
    // (is_done_kind, is_current)
    let (rect, _) = ui.allocate_exact_size(egui::vec2(w, 14.0), egui::Sense::hover());
    let p = ui.painter();
    let n = ticks.len().max(1);
    for (i, (done, cur)) in ticks.iter().enumerate() {
        let x = rect.left() + rect.width() * (i as f32 + 0.5) / n as f32;
        let (h, c) = if *cur {
            (11.0, BONE)
        } else if *done {
            (8.0, GREEN)
        } else {
            (6.0, CYAN)
        };
        p.line_segment(
            [egui::pos2(x, rect.bottom()), egui::pos2(x, rect.bottom() - h)],
            egui::Stroke::new(if *cur { 2.0 } else { 1.2 }, c),
        );
    }
}
