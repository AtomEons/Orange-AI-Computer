//! ops — the operational brain, native. Port of the design lab's operations.ts +
//! project-intelligence.ts: THIS is the system under the cosmos. Order in →
//! project condenses → work completes → receipt on disk → the field recalls it.
//!
//! Honest + free: JSON persistence in %APPDATA%\AtomicOrange\, receipts written to
//! the repo receipt spine (10-RECEIPTS/atomic-orange/app/). No fake data: the seed
//! portfolio is labeled, everything you create/complete is real and persists.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum PState {
    Building,
    Hold,
    Complete,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Task {
    pub name: String,
    pub done: bool,
    /// GTD "WAITING FOR": open work blocked on someone/something else. It is
    /// NOT a next action — the runway must never offer it. serde default keeps
    /// every journal and store written before this state loadable.
    #[serde(default)]
    pub waiting: bool,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub kind: String, // software | exe | pdf | website | system
    pub state: PState,
    pub weight: f32,
    pub slot: usize, // stable seat in the orbital slot table
    pub tasks: Vec<Task>,
}

impl Project {
    pub fn progress(&self) -> u32 {
        if self.tasks.is_empty() {
            return if self.state == PState::Complete { 100 } else { 0 };
        }
        let done = self.tasks.iter().filter(|t| t.done).count();
        ((done as f32 / self.tasks.len() as f32) * 100.0).round() as u32
    }
}

pub struct FeedEvent {
    pub when: String,
    pub text: String,
    pub tone: u8, // 0 info · 1 ok · 2 warn
}

/// one moment in the organism's life — full state snapshot (event sourcing, honest)
#[derive(Clone, Serialize, Deserialize)]
pub struct Moment {
    pub ts: String,
    pub label: String,
    pub snapshot: Vec<Project>,
}

pub struct Ops {
    pub projects: Vec<Project>,
    pub feed: Vec<FeedEvent>,
    pub receipts_written: usize,
    /// the journal — every mutation, with the state as it was AFTER it
    pub journal: Vec<Moment>,
    /// estate awareness: last seen receipt-file count across the spine
    pub estate_count: usize,
}

fn now_hm() -> String {
    chrono::Local::now().format("%H:%M").to_string()
}

fn store_path() -> std::path::PathBuf {
    let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".into());
    std::path::PathBuf::from(base).join("AtomicOrange").join("projects.json")
}

fn journal_path() -> std::path::PathBuf {
    let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".into());
    std::path::PathBuf::from(base).join("AtomicOrange").join("journal.jsonl")
}

const RECEIPT_DIR: &str = "C:/AtomEons/Orange5/10-RECEIPTS/atomic-orange/app";

/// the seed portfolio — real Orange5 workstreams (labeled seed; replaced as you create)
fn seeds() -> Vec<Project> {
    let mk = |id: &str, name: &str, kind: &str, state: PState, weight: f32, slot: usize, tasks: &[(&str, bool)]| Project {
        id: id.into(),
        name: name.into(),
        kind: kind.into(),
        state,
        weight,
        slot,
        tasks: tasks.iter().map(|(n, d)| Task { name: (*n).into(), done: *d, waiting: false }).collect(),
    };
    vec![
        mk("orangefive", "OrangeFive Release", "system", PState::Building, 1.0, 0, &[
            ("Atomic Chat upstream intake", true),
            ("Cosmos cockpit shell", true),
            ("Port living canvas into native", true),
            ("Wire Codexa lease + receipts", false),
            ("Release gates green", false),
        ]),
        mk("aesee", "AESee Living Dashboard", "software", PState::Building, 0.85, 1, &[
            ("Organ constellation", true),
            ("Truth rails", true),
            ("Pixel-proof harness", true),
            ("72-state atlas", false),
        ]),
        mk("cockpit", "Atomic Orange Native", "exe", PState::Building, 0.9, 2, &[
            ("wgpu organism first light", true),
            ("HDR bloom + god-rays", true),
            ("State atlas 5 anchors", true),
            ("Operations brain port", false),
            ("Gateway heartbeat", false),
        ]),
        mk("navigator", "Orange Navigator", "software", PState::Hold, 0.55, 3, &[
            ("Intent router draft", true),
            ("Recall memory lane", false),
        ]),
        mk("orangeeye", "OrangeEye Vision", "software", PState::Hold, 0.5, 4, &[
            ("Screenshot understanding", false),
            ("Artifact proof lane", false),
        ]),
        mk("receipts", "Receipt Spine", "system", PState::Complete, 0.7, 5, &[
            ("Hash-chained store", true),
            ("Spine CLI", true),
            ("85/85 verify", true),
        ]),
    ]
}

impl Ops {
    pub fn load() -> Self {
        let projects = std::fs::read_to_string(store_path())
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<Project>>(&s).ok())
            .filter(|v: &Vec<Project>| !v.is_empty())
            .unwrap_or_else(seeds);
        let receipts_written = std::fs::read_dir(RECEIPT_DIR).map(|d| d.count()).unwrap_or(0);
        // the journal: every prior moment of this organism's life, replayable
        let journal: Vec<Moment> = std::fs::read_to_string(journal_path())
            .map(|s| s.lines().filter_map(|l| serde_json::from_str(l).ok()).collect())
            .unwrap_or_default();
        let mut ops = Ops { projects, feed: Vec::new(), receipts_written, journal, estate_count: 0 };
        ops.estate_count = ops.estate_scan();
        ops.event("organism awake — state recalled", 1);
        // honest boot: the heartbeat hasn't answered yet — probe, don't presume
        ops.event("probing OrangeBrain gateway…", 0);
        ops
    }

    /// append a moment to the journal (memory + disk) — time becomes navigable
    fn journal_moment(&mut self, label: &str) {
        let m = Moment {
            ts: chrono::Local::now().format("%m-%d %H:%M:%S").to_string(),
            label: label.into(),
            snapshot: self.projects.clone(),
        };
        if let Ok(line) = serde_json::to_string(&m) {
            if let Some(dir) = journal_path().parent() { let _ = std::fs::create_dir_all(dir); }
            use std::io::Write;
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(journal_path()) {
                let _ = writeln!(f, "{line}");
            }
        }
        self.journal.push(m);
    }

    /// honest velocity: tasks completed per day over the journal's real span
    pub fn velocity_per_day(&self) -> f32 {
        let n = self.journal.iter().filter(|m| m.label.starts_with("done")).count();
        if n == 0 || self.journal.len() < 2 { return 0.0; }
        // span from first to last journal moment, in days (min half a day)
        let parse = |s: &str| chrono::NaiveDateTime::parse_from_str(
            &format!("2026-{s}"), "%Y-%m-%d %H:%M:%S").ok();
        match (parse(&self.journal[0].ts), parse(&self.journal[self.journal.len() - 1].ts)) {
            (Some(a), Some(b)) => {
                let days = ((b - a).num_seconds() as f32 / 86_400.0).max(0.5);
                n as f32 / days
            }
            _ => 0.0,
        }
    }

    /// WIP TRUTH (Kanban's one hard law): how many projects are genuinely in
    /// flight. Beyond a human's real capacity, throughput falls — the board
    /// states the count and the threshold; the operator decides what to do.
    pub fn wip(&self) -> usize {
        self.projects.iter().filter(|p| p.state == PState::Building).count()
    }

    /// AGE OF THE RUNWAY — days since the last completion anywhere (from the
    /// journal, not a guess). Stale work is the quietest failure mode there is.
    pub fn days_since_progress(&self) -> Option<f32> {
        let last = self.journal.iter().rev().find(|m| m.label.starts_with("done"))?;
        let parse = |s: &str| {
            chrono::NaiveDateTime::parse_from_str(&format!("2026-{s}"), "%Y-%m-%d %H:%M:%S").ok()
        };
        let then = parse(&last.ts)?;
        let now = chrono::Local::now().naive_local();
        Some(((now - then).num_seconds() as f32 / 86_400.0).max(0.0))
    }

    /// GTD CAPTURE at the desk: a new task appended to a named project. The
    /// board is not read-only — the operator adds work where he sees it.
    pub fn add_task(&mut self, project: &str, task: &str) -> bool {
        let Some(pi) = self.projects.iter().position(|p| p.name == project) else { return false };
        self.projects[pi].tasks.push(Task { name: task.into(), done: false, waiting: false });
        if self.projects[pi].state == PState::Complete {
            self.projects[pi].state = PState::Building;
        }
        let pname = self.projects[pi].name.clone();
        self.event(&format!("captured: {task}"), 0);
        self.write_receipt("task.capture", &pname, task);
        self.journal_moment(&format!("capture: {task}"));
        self.save();
        true
    }

    /// THE RUNWAY — the next N actionable tasks across all building projects,
    /// in the same order the organism will meet them. Real queue, no invention.
    pub fn runway(&self, n: usize) -> Vec<(String, String)> {
        let mut out = Vec::new();
        for p in self.projects.iter().filter(|p| p.state == PState::Building) {
            for t in p.tasks.iter().filter(|t| !t.done && !t.waiting) {
                out.push((p.name.clone(), t.name.clone()));
                if out.len() >= n {
                    return out;
                }
            }
        }
        out
    }

    /// THE WORK RHYTHM — real completions per day for the last N days, straight
    /// from the journal (day letter, count). No invention: empty days read zero.
    pub fn completions_last_days(&self, days: i64) -> Vec<(String, usize)> {
        let now = chrono::Local::now();
        (0..days)
            .rev()
            .map(|d| {
                let day = now - chrono::Duration::days(d);
                let key = day.format("%m-%d").to_string();
                let n = self
                    .journal
                    .iter()
                    .filter(|m| m.ts.starts_with(&key) && m.label.starts_with("done"))
                    .count();
                (day.format("%a").to_string()[..1].to_string(), n)
            })
            .collect()
    }

    /// ghost fraction: where the portfolio will be in 7 days AT CURRENT PACE (labeled extrapolation)
    pub fn ghost_frac(&self) -> f32 {
        let total: usize = self.projects.iter().map(|p| p.tasks.len()).sum();
        if total == 0 { return self.complete_frac(); }
        let open: usize = self.projects.iter().map(|p| p.tasks.iter().filter(|t| !t.done).count()).sum();
        let will_do = (self.velocity_per_day() * 7.0).min(open as f32);
        let done_now: usize = total - open;
        ((done_now as f32 + will_do) / total as f32).clamp(0.0, 1.0)
    }

    /// estate awareness: count receipt files across the Orange5 spine (cheap poll)
    pub fn estate_scan(&self) -> usize {
        ["C:/AtomEons/Orange5/10-RECEIPTS/atomic-orange/app",
         "C:/AtomEons/Orange5/10-RECEIPTS/atomic-orange/pixel",
         "C:/AtomEons/Orange5/10-RECEIPTS/orange5-build"]
            .iter()
            .map(|d| std::fs::read_dir(d).map(|r| r.count()).unwrap_or(0))
            .sum()
    }

    /// fraction of the portfolio shipped (drives the fruit's lit wedges)
    pub fn complete_frac(&self) -> f32 {
        if self.projects.is_empty() { return 0.0; }
        let done = self.projects.iter().filter(|p| p.state == PState::Complete).count();
        done as f32 / self.projects.len() as f32
    }
    pub fn open_tasks(&self) -> usize {
        self.projects.iter().filter(|p| p.state == PState::Building)
            .map(|p| p.tasks.iter().filter(|t| !t.done).count()).sum()
    }
    pub fn holds(&self) -> usize {
        self.projects.iter().filter(|p| p.state == PState::Hold).count()
    }
    pub fn completes(&self) -> usize {
        self.projects.iter().filter(|p| p.state == PState::Complete).count()
    }

    pub fn save(&self) {
        let p = store_path();
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string_pretty(&self.projects) {
            let _ = std::fs::write(p, json);
        }
    }

    pub fn event(&mut self, text: &str, tone: u8) {
        self.feed.insert(0, FeedEvent { when: now_hm(), text: text.into(), tone });
        self.feed.truncate(6);
    }

    /// GTD runway: the single next actionable task (first building project, first open task)
    pub fn next_action(&self) -> Option<(usize, usize)> {
        for (pi, p) in self.projects.iter().enumerate() {
            if p.state == PState::Building {
                // GTD law: waiting-for work is NOT a next action — the runway
                // may only ever offer what the operator can actually do now
                if let Some(ti) = p.tasks.iter().position(|t| !t.done && !t.waiting) {
                    return Some((pi, ti));
                }
            }
        }
        None
    }

    /// how much open work is blocked on someone else (GTD "waiting for" list)
    pub fn waiting_count(&self) -> usize {
        self.projects
            .iter()
            .filter(|p| p.state == PState::Building)
            .map(|p| p.tasks.iter().filter(|t| !t.done && t.waiting).count())
            .sum()
    }

    /// flip a task between actionable and waiting-for. Real state change:
    /// receipt on the spine, journal moment, store saved.
    pub fn toggle_waiting(&mut self, project: &str, task: &str) -> bool {
        let Some(pi) = self.projects.iter().position(|p| p.name == project) else { return false };
        let Some(ti) = self.projects[pi].tasks.iter().position(|t| t.name == task && !t.done) else { return false };
        let now_waiting = !self.projects[pi].tasks[ti].waiting;
        self.projects[pi].tasks[ti].waiting = now_waiting;
        let pname = self.projects[pi].name.clone();
        let tname = self.projects[pi].tasks[ti].name.clone();
        self.event(
            &format!("{}: {tname}", if now_waiting { "waiting on" } else { "unblocked" }),
            if now_waiting { 2 } else { 1 },
        );
        self.write_receipt(if now_waiting { "task.waiting" } else { "task.unblocked" }, &pname, &tname);
        self.journal_moment(&format!("{}: {tname}", if now_waiting { "waiting" } else { "unblocked" }));
        self.save();
        true
    }

    pub fn next_action_text(&self) -> String {
        match self.next_action() {
            Some((pi, ti)) => format!("{} — {}", self.projects[pi].name, self.projects[pi].tasks[ti].name),
            None => "all building work complete — order something new".into(),
        }
    }

    /// complete the runway task: truth propagates, receipt lands on disk
    pub fn complete_next(&mut self) -> Option<String> {
        let (pi, ti) = self.next_action()?;
        self.projects[pi].tasks[ti].done = true;
        let tname = self.projects[pi].tasks[ti].name.clone();
        let pname = self.projects[pi].name.clone();
        if self.projects[pi].tasks.iter().all(|t| t.done) {
            self.projects[pi].state = PState::Complete;
            self.event(&format!("{pname} COMPLETE"), 1);
        } else {
            self.event(&format!("done: {tname}"), 1);
        }
        self.write_receipt("task.complete", &pname, &tname);
        self.journal_moment(&format!("done: {tname}"));
        self.save();
        Some(tname)
    }

    /// complete a SPECIFIC task by name — the autopilot completes exactly the
    /// task it worked, even if the runway moved while the brain was thinking
    pub fn complete_named(&mut self, project: &str, task: &str) -> bool {
        let Some(pi) = self.projects.iter().position(|p| p.name == project) else { return false };
        let Some(ti) = self.projects[pi].tasks.iter().position(|t| t.name == task && !t.done) else { return false };
        self.projects[pi].tasks[ti].done = true;
        let pname = self.projects[pi].name.clone();
        let tname = self.projects[pi].tasks[ti].name.clone();
        if self.projects[pi].tasks.iter().all(|t| t.done) {
            self.projects[pi].state = PState::Complete;
            self.event(&format!("{pname} COMPLETE"), 1);
        } else {
            self.event(&format!("done: {tname}"), 1);
        }
        self.write_receipt("task.complete", &pname, &tname);
        self.journal_moment(&format!("done: {tname}"));
        self.save();
        true
    }

    /// N9 AUTOPILOT deliverable: the brain's REAL output lands on disk as an
    /// artifact file; receipt + journal remember it. Returns the artifact path.
    pub fn artifact(&mut self, project: &str, task: &str, content: &str) -> String {
        let dir = "C:/AtomEons/Orange5/10-RECEIPTS/atomic-orange/artifacts";
        let _ = std::fs::create_dir_all(dir);
        let slug: String = task
            .to_lowercase()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect::<String>()
            .split('-')
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("-");
        let slug = &slug[..slug.len().min(42)];
        let ts = chrono::Local::now().format("%Y-%m-%dT%H-%M-%S");
        let path = format!("{dir}/{ts}-{slug}.md");
        let body = format!(
            "# {task}\n\nproject: {project}\ngenerated: {ts} · OrangeBrain via AUTOPILOT (atomic-orange-native)\n\n---\n\n{content}\n"
        );
        let _ = std::fs::write(&path, body);
        self.write_receipt("task.artifact", project, &path);
        path
    }

    /// an idea condenses into a real project (kind detection + task template)
    pub fn create(&mut self, idea: &str) -> String {
        let lower = idea.to_lowercase();
        let kind = if lower.contains("site") || lower.contains("web") || lower.contains("landing") {
            "website"
        } else if lower.contains("exe") || lower.contains("install") || lower.contains("app") {
            "exe"
        } else if lower.contains("pdf") || lower.contains("deck") || lower.contains("doc") {
            "pdf"
        } else {
            "software"
        };
        // strip leading filler, keep the substance
        let mut name = idea.trim().to_string();
        for f in ["build me a ", "build me ", "build a ", "build ", "make me a ", "make a ", "make ", "create a ", "create ", "i want a ", "i want "] {
            if lower.starts_with(f) {
                name = idea[f.len()..].trim().to_string();
                break;
            }
        }
        if name.is_empty() {
            name = idea.trim().to_string();
        }
        // capitalize first letter
        let mut cs = name.chars();
        let name = match cs.next() {
            Some(c) => c.to_uppercase().collect::<String>() + cs.as_str(),
            None => name,
        };
        let template: &[&str] = match kind {
            "website" => &["Goal + audience", "Information architecture", "Visual design", "Build pages", "Content", "Deploy"],
            "exe" => &["Spec + platform", "Core loop", "Interface", "Package installer", "Smoke test"],
            "pdf" => &["Outline", "Draft content", "Layout + typography", "Proof pass", "Export + deliver"],
            _ => &["Spec the system", "Architecture", "Build core", "Tests + hardening", "Ship"],
        };
        let used: Vec<usize> = self.projects.iter().map(|p| p.slot).collect();
        let slot = (0..12).find(|s| !used.contains(s)).unwrap_or(6);
        let id = format!("p-{}", chrono::Local::now().format("%m%d%H%M%S"));
        self.projects.insert(0, Project {
            id,
            name: name.clone(),
            kind: kind.into(),
            state: PState::Building,
            weight: 0.6,
            slot,
            tasks: template.iter().map(|n| Task { name: (*n).into(), done: false, waiting: false }).collect(),
        });
        self.event(&format!("order received: {name}"), 0);
        self.write_receipt("project.create", &name, kind);
        self.journal_moment(&format!("order: {name}"));
        self.save();
        name
    }

    fn write_receipt(&mut self, action: &str, subject: &str, detail: &str) {
        self.receipts_written += 1;
        // N7 HANDSHAKE: the same act flows through the GOVERNED spine (route → LOOM →
        // hash-chained ledger). Fire-and-forget; the estate poll notices the landing.
        let order = serde_json::json!({
            "action": action,
            "intent": format!("atomic-orange-native: {subject}"),
            "payload": { "subject": subject, "detail": detail, "surface": "atomic-orange-native" }
        });
        let _ = std::process::Command::new("bun")
            .arg("C:/AtomEons/Orange5/03-BACKEND/spine-cli.mjs")
            .arg("--order").arg(order.to_string())
            .arg("--learn")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
        let _ = std::fs::create_dir_all(RECEIPT_DIR);
        let ts = chrono::Local::now().format("%Y-%m-%dT%H-%M-%S");
        let body = serde_json::json!({
            "schema": "orange5.receipt.v0",
            "action": action,
            "subject": subject,
            "detail": detail,
            "ts": ts.to_string(),
            "surface": "atomic-orange-native",
        });
        let _ = std::fs::write(
            format!("{RECEIPT_DIR}/rcpt-{ts}-{action}.json"),
            serde_json::to_string_pretty(&body).unwrap_or_default(),
        );
    }
}
