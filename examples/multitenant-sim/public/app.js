let latest = null;
let formReady = false;
let saveTimer = null;
let lastLiveAt = 0;

const $ = (selector) => document.querySelector(selector);
const form = $("#configForm");
const streamStatus = $("#streamStatus");

const outputs = {
  targetUsers: $("#targetUsersOut"),
  arrivalRatePerSec: $("#arrivalRatePerSecOut"),
  maxActiveVms: $("#maxActiveVmsOut"),
  bootConcurrency: $("#bootConcurrencyOut"),
  taskCpuIterations: $("#taskCpuIterationsOut"),
};

$("#startBtn").addEventListener("click", () => post("/api/start"));
$("#pauseBtn").addEventListener("click", () => post("/api/pause"));
$("#resetBtn").addEventListener("click", () => post("/api/reset"));
$("#burstBtn").addEventListener("click", () =>
  post("/api/burst", { count: Number($("#burstCount").value || 1) }),
);
$("#copyReportBtn").addEventListener("click", copyReport);
$("#downloadReportBtn").addEventListener("click", downloadReport);

form.addEventListener("submit", (event) => {
  event.preventDefault();
  submitConfig("advanced saved");
});

form.addEventListener("input", (event) => {
  updateOutputs();
  if (event.target.matches("[data-live]")) scheduleSubmit();
});

form.addEventListener("change", (event) => {
  updateOutputs();
  if (event.target.matches("[data-live]")) submitConfig("saved");
});

$("#strategyButtons").addEventListener("click", (event) => {
  const button = event.target.closest("[data-strategy]");
  if (!button) return;
  form.elements.strategy.value = button.dataset.strategy;
  updateStrategyButtons();
  submitConfig("strategy saved");
});

document.querySelectorAll("[data-preset]").forEach((button) => {
  button.addEventListener("click", () => {
    applyPreset(button.dataset.preset);
    submitConfig(`${button.textContent} loaded`);
  });
});

function scheduleSubmit() {
  $("#saveStatus").textContent = "saving...";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => submitConfig("saved"), 350);
}

function submitConfig(message = "saved") {
  clearTimeout(saveTimer);
  post("/api/config", configFromForm()).then(() => {
    $("#saveStatus").textContent = message;
  });
}

function configFromForm() {
  const data = new FormData(form);
  return {
    strategy: data.get("strategy"),
    targetUsers: Number(data.get("targetUsers")),
    arrivalRatePerSec: Number(data.get("arrivalRatePerSec")),
    maxActiveVms: Number(data.get("maxActiveVms")),
    bootConcurrency: Number(data.get("bootConcurrency")),
    hotIdleTtlMs: Number(data.get("hotIdleTtlMs")),
    warmSnapshotTtlMs: Number(data.get("warmSnapshotTtlMs")),
    vmMemory: String(data.get("vmMemory") || ""),
    vmStartTimeoutMs: Number(data.get("vmStartTimeoutMs")),
    taskCpuIterations: Number(data.get("taskCpuIterations")),
    networkEnabled: Boolean(data.get("networkEnabled")),
    imagePath: String(data.get("imagePath") || ""),
    workDir: String(data.get("workDir") || ""),
  };
}

async function post(url, body = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  renderState(await response.json());
}

function connectStream() {
  if (!window.EventSource) {
    streamStatus.textContent = "polling";
    setInterval(pollOnce, 1000);
    void pollOnce();
    return;
  }

  const source = new EventSource("/api/stream");
  source.onopen = () => setStreamStatus("live", true);
  source.onmessage = (event) => {
    lastLiveAt = Date.now();
    setStreamStatus("live", true);
    renderState(JSON.parse(event.data));
  };
  source.onerror = () => setStreamStatus("reconnecting", false);

  setInterval(() => {
    if (Date.now() - lastLiveAt > 2500) void pollOnce();
  }, 1500);
}

async function pollOnce() {
  try {
    const response = await fetch("/api/state");
    renderState(await response.json());
  } catch {
    setStreamStatus("offline", false);
  }
}

function setStreamStatus(text, online) {
  streamStatus.textContent = text;
  streamStatus.classList.toggle("on", online);
  streamStatus.classList.toggle("off", !online);
}

function renderState(state) {
  latest = state;
  if (!formReady) fillForm(state.config);
  renderTop();
  renderWorld();
  renderHealth();
  renderEvents();
  renderReport();
}

function fillForm(config) {
  for (const [key, value] of Object.entries(config)) {
    const input = form.elements.namedItem(key);
    if (!input) continue;
    if (input.type === "checkbox") input.checked = Boolean(value);
    else input.value = value;
  }
  formReady = true;
  updateOutputs();
  updateStrategyButtons();
}

function updateOutputs() {
  outputs.targetUsers.textContent = form.elements.targetUsers.value;
  outputs.arrivalRatePerSec.textContent = `${form.elements.arrivalRatePerSec.value} / sec`;
  outputs.maxActiveVms.textContent = form.elements.maxActiveVms.value;
  outputs.bootConcurrency.textContent = form.elements.bootConcurrency.value;
  outputs.taskCpuIterations.textContent = form.elements.taskCpuIterations.value;
}

function updateStrategyButtons() {
  const value = form.elements.strategy.value;
  document.querySelectorAll("[data-strategy]").forEach((button) => {
    button.classList.toggle("active", button.dataset.strategy === value);
  });
}

function renderTop() {
  const c = latest.counts;
  const m = latest.metrics;
  $("#runState").textContent = latest.running ? "running" : "paused";
  $("#runState").classList.toggle("running", latest.running);
  $("#doneText").textContent = m.tasksCompleted;
  $("#waitText").textContent = c.queued || 0;
  $("#vmText").textContent = `${c.slots || 0}/${latest.config.maxActiveVms}`;
  $("#memoryText").textContent = bytes(latest.resource.vmmRssBytes);
}

function renderWorld() {
  const counts = latest.counts;
  $("#zoneQueued").textContent = counts.queued || 0;
  $("#zoneActive").textContent = activeCount(counts);
  $("#zoneHot").textContent = counts.hot || 0;
  $("#zoneWarm").textContent = counts.warm || 0;
  fillTokens("#queueTokens", ["queued"]);
  fillTokens("#activeTokens", ["starting", "running", "snapshotting", "closing"]);
  fillTokens("#hotTokens", ["hot"]);
  fillTokens("#warmTokens", ["warm"]);
}

function fillTokens(selector, statuses) {
  const sessions = latest.sessions
    .filter((session) => statuses.includes(session.status))
    .slice(0, 16);
  const node = $(selector);
  node.replaceChildren(
    ...(sessions.length
      ? sessions.map((session) => {
          const chip = el("span", `vm-chip ${session.status}`);
          chip.title = `${session.id}: ${session.status}`;
          chip.textContent = compactUser(session.id);
          return chip;
        })
      : [el("span", "empty", "clear")]),
  );
}

function renderHealth() {
  const c = latest.counts;
  const r = latest.resource;
  const config = latest.config;
  const slotRatio = ratio(c.slots || 0, config.maxActiveVms);
  const queueRatio = ratio(c.queued || 0, Math.max(1, config.maxActiveVms * 3));
  const hostFreeRatio = ratio(r.freeMemBytes, r.totalMemBytes);
  setBar("#slotBar", slotRatio);
  setBar("#queueBar", queueRatio);
  setBar("#hostBar", hostFreeRatio);
  $("#slotText").textContent = percent(slotRatio);
  $("#queueText").textContent = percent(queueRatio);
  $("#hostText").textContent = bytes(r.freeMemBytes);
}

function renderEvents() {
  const events = latest.events.slice(0, 8);
  $("#eventsList").replaceChildren(
    ...(events.length
      ? events.map((event) => {
          const item = el("li", event.level);
          item.textContent = `${new Date(event.at).toLocaleTimeString()} ${event.message}`;
          return item;
        })
      : [el("li", "info", "No events yet")]),
  );
}

function renderReport() {
  $("#reportText").value = buildReport();
}

function buildReport() {
  if (!latest) return "";
  const m = latest.metrics;
  const c = latest.counts;
  const r = latest.resource;
  const config = latest.config;
  const recentEvents = latest.events
    .slice(0, 10)
    .map((event) => `- ${new Date(event.at).toISOString()} [${event.level}] ${event.message}`)
    .join("\n");
  const sessions = latest.sessions
    .slice(0, 12)
    .map(
      (session) =>
        `- ${session.id}: ${session.status}, tasks=${session.tasksCompleted}, ${
          session.lastError || session.lastResult || "no result"
        }`,
    )
    .join("\n");

  return [
    "# Gondolin VM testing report",
    `time: ${new Date().toISOString()}`,
    "",
    "## Scenario",
    `strategy: ${config.strategy}`,
    `users: ${config.targetUsers}`,
    `traffic: ${config.arrivalRatePerSec} tasks/sec`,
    `vm_slots: ${config.maxActiveVms}`,
    `boot_gates: ${config.bootConcurrency}`,
    `vm_memory: ${config.vmMemory}`,
    `network: ${config.networkEnabled ? "on" : "off"}`,
    "",
    "## Results",
    `tasks_completed: ${m.tasksCompleted}`,
    `tasks_failed: ${m.tasksFailed}`,
    `queued_now: ${c.queued || 0}`,
    `cold_boots: ${m.coldBoots}`,
    `restores: ${m.restores}`,
    `snapshots: ${m.snapshots}`,
    `snapshot_failures: ${m.snapshotFailures}`,
    `avg_wait_ms: ${Math.round(m.avgWaitMs)}`,
    `avg_run_ms: ${Math.round(m.avgRunMs)}`,
    "",
    "## Resources",
    `active_vm_slots: ${c.slots || 0}/${config.maxActiveVms}`,
    `vmm_rss: ${bytes(r.vmmRssBytes)}`,
    `simulator_rss: ${bytes(r.processRssBytes)}`,
    `host_free: ${bytes(r.freeMemBytes)}`,
    `snapshot_bytes: ${bytes(m.snapshotBytes)}`,
    "",
    "## Recent sessions",
    sessions || "- none",
    "",
    "## Recent events",
    recentEvents || "- none",
    "",
    "## Raw summary",
    JSON.stringify(
      {
        running: latest.running,
        config,
        metrics: m,
        counts: c,
        resource: r,
      },
      null,
      2,
    ),
  ].join("\n");
}

async function copyReport() {
  const text = buildReport();
  $("#reportText").value = text;
  try {
    if (!navigator.clipboard) throw new Error("clipboard unavailable");
    await navigator.clipboard.writeText(text);
  } catch {
    $("#reportText").select();
    document.execCommand("copy");
    window.getSelection()?.removeAllRanges();
  }
  $("#reportSummary").textContent = "Copied. Send this report back for analysis.";
}

function downloadReport() {
  const blob = new Blob([buildReport()], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `gondolin-vm-report-${Date.now()}.md`;
  link.click();
  URL.revokeObjectURL(url);
}

function applyPreset(name) {
  const presets = {
    demo: {
      strategy: "hybrid",
      targetUsers: 100,
      arrivalRatePerSec: 0,
      maxActiveVms: 2,
      bootConcurrency: 1,
      taskCpuIterations: 20000,
      vmMemory: "30M",
    },
    rush: {
      strategy: "hot",
      targetUsers: 1000,
      arrivalRatePerSec: 8,
      maxActiveVms: 8,
      bootConcurrency: 2,
      taskCpuIterations: 30000,
      vmMemory: "30M",
    },
    save: {
      strategy: "warm-snapshot",
      targetUsers: 500,
      arrivalRatePerSec: 2,
      maxActiveVms: 3,
      bootConcurrency: 1,
      taskCpuIterations: 20000,
      vmMemory: "30M",
    },
    cold: {
      strategy: "cold",
      targetUsers: 200,
      arrivalRatePerSec: 3,
      maxActiveVms: 4,
      bootConcurrency: 2,
      taskCpuIterations: 20000,
      vmMemory: "30M",
    },
  };
  const preset = presets[name];
  for (const [key, value] of Object.entries(preset)) {
    const input = form.elements.namedItem(key);
    if (input) input.value = value;
  }
  updateOutputs();
  updateStrategyButtons();
}

function setBar(selector, value) {
  $(selector).style.width = `${Math.round(Math.max(0.03, Math.min(1, value)) * 100)}%`;
}

function activeCount(counts) {
  return (
    (counts.running || 0) +
    (counts.starting || 0) +
    (counts.snapshotting || 0) +
    (counts.closing || 0)
  );
}

function compactUser(id) {
  return id.replace(/^user-0*/, "u");
}

function ratio(value, max) {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.max(0, Math.min(1, value / max));
}

function percent(value) {
  return `${Math.round(value * 100)}%`;
}

function bytes(value) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let n = value;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function el(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

connectStream();
