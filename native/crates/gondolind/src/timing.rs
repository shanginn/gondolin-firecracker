//! `timing` debug output: when each step of starting and stopping the VM
//! happened, as `log` messages of component `timing`, e.g.
//!
//! ```text
//! [timing]  151.2 ms (+72.4)  vmm spawned
//! ```
//!
//! Milliseconds since the session was created, then since the previous step.
//! The daemon runs one session per process, so the state is process-global:
//! any module (the guest ports' accept loops, the backends) can [`mark`] a
//! step without plumbing. Off unless the session's debug flags contain
//! `timing`; then each mark costs a lock and one message.

use std::sync::{Arc, Mutex};
use std::time::Instant;

use gondolin_proto::session as ps;

use crate::controller::Controller;

struct State {
    start: Instant,
    last: Instant,
    /// set while the `timing` debug flag is on
    ctl: Option<Arc<Controller>>,
    debug: bool,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);

fn state() -> std::sync::MutexGuard<'static, Option<State>> {
    STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Starts the clock (session creation); marks are relative to this.
pub fn start() {
    let now = Instant::now();
    *state() = Some(State { start: now, last: now, ctl: None, debug: false });
}

/// Turns the output on (with `ctl`) or off.
pub fn enable(ctl: Arc<Controller>, debug: bool) {
    let now = Instant::now();
    let mut guard = state();
    let state = guard.get_or_insert(State { start: now, last: now, ctl: None, debug: false });
    state.ctl = Some(ctl);
    state.debug = debug;
}

/// Whether marks are reported (to skip formatting expensive labels).
pub fn enabled() -> bool {
    state().as_ref().is_some_and(|s| s.debug && s.ctl.is_some())
}

/// Reports that `step` just finished.
pub fn mark(step: impl AsRef<str>) {
    let mut guard = state();
    let Some(state) = guard.as_mut() else { return };
    let Some(ctl) = state.ctl.clone() else { return };
    let now = Instant::now();
    let ms = |d: std::time::Duration| d.as_secs_f64() * 1000.0;
    let message = format!(
        "{:7.1} ms (+{:.1})  {}",
        ms(now - state.start),
        ms(now - state.last),
        step.as_ref()
    );
    let at_ms = ms(now - state.start);
    let debug = state.debug;
    state.last = now;
    drop(guard);
    // Only bounded lifecycle milestones belong in the SDK's timing history.
    // Per-exec and per-VFS diagnostics remain opt-in debug logs.
    if !step.as_ref().starts_with("guest message:") && !step.as_ref().starts_with("fs ") {
        ctl.send("startup_timing", 0, &Timing { name: step.as_ref().to_owned(), at_ms });
    }
    if !debug {
        return;
    }
    ctl.send(ps::LOG, 0, &ps::Log { component: "timing".into(), message });
}

gondolin_wire::wire_encode! {
    struct Timing {
        name: String,
        at_ms: f64,
    }
}
