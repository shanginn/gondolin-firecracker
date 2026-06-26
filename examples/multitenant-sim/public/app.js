let latest = null;
let formReady = false;

const cards = document.querySelector("#cards");
const form = document.querySelector("#configForm");
const sessionsBody = document.querySelector("#sessionsBody");
const eventsList = document.querySelector("#eventsList");
const statusPill = document.querySelector("#statusPill");
const chart = document.querySelector("#historyChart");

document.querySelector("#startBtn").addEventListener("click", () => post("/api/start"));
document.querySelector("#pauseBtn").addEventListener("click", () => post("/api/pause"));
document.querySelector("#resetBtn").addEventListener("click", () => post("/api/reset"));
document.querySelector("#burstBtn").addEventListener("click", () =>
  post("/api/burst", { count: Number(document.querySelector("#burstCount").value || 1) }),
);
document.querySelector("#userTaskBtn").addEventListener("click", () =>
  post("/api/user-task", { userId: document.querySelector("#userTaskId").value }),
);

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(form);
  post("/api/config", {
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
  });
});

async function post(url, body = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  latest = await response.json();
  render();
}

async function poll() {
  try {
    const response = await fetch("/api/state");
    latest = await response.json();
    render();
  } catch (error) {
    console.error(error);
  }
}

function render() {
  if (!latest) return;
  if (!formReady) fillForm(latest.config);
  renderCards();
  renderStatus();
  renderSessions();
  renderEvents();
  drawChart();
}

function fillForm(config) {
  for (const [key, value] of Object.entries(config)) {
    const input = form.elements.namedItem(key);
    if (!input) continue;
    if (input.type === "checkbox") {
      input.checked = Boolean(value);
    } else {
      input.value = value;
    }
  }
  formReady = true;
}

function renderStatus() {
  statusPill.textContent = latest.running ? "running" : "paused";
  statusPill.classList.toggle("paused", !latest.running);
}

function renderCards() {
  const c = latest.counts;
  const m = latest.metrics;
  const r = latest.resource;
  const active = (c.running || 0) + (c.starting || 0) + (c.snapshotting || 0);
  const items = [
    ["Queued", c.queued || 0],
    ["Active VMs", active],
    ["Hot VMs", c.hot || 0],
    ["Warm states", c.warm || 0],
    ["Tasks done", m.tasksCompleted],
    ["Failed", m.tasksFailed],
    ["VMM RSS", bytes(r.vmmRssBytes)],
    ["Host RSS", bytes(r.processRssBytes)],
    ["Host free", bytes(r.freeMemBytes)],
    ["Snapshots", bytes(m.snapshotBytes)],
    ["Cold boots", m.coldBoots],
    ["Restores", m.restores],
    ["Snapshot fails", m.snapshotFailures],
    ["Evictions", m.pressureEvictions],
    ["Avg wait", ms(m.avgWaitMs)],
    ["Avg run", ms(m.avgRunMs)],
  ];
  cards.replaceChildren(
    ...items.map(([label, value]) => {
      const node = document.createElement("div");
      node.className = "card";
      node.innerHTML = `<div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(String(value))}</div>`;
      return node;
    }),
  );
}

function renderSessions() {
  sessionsBody.replaceChildren(
    ...latest.sessions.map((session) => {
      const tr = document.createElement("tr");
      tr.innerHTML = [
        session.id,
        session.status,
        session.pid || "",
        session.tasksCompleted,
        session.snapshotBytes ? bytes(session.snapshotBytes) : "",
        session.lastError || session.lastResult || "",
      ]
        .map((value) => `<td>${escapeHtml(String(value))}</td>`)
        .join("");
      return tr;
    }),
  );
}

function renderEvents() {
  eventsList.replaceChildren(
    ...latest.events.map((event) => {
      const li = document.createElement("li");
      li.className = event.level;
      li.textContent = `${new Date(event.at).toLocaleTimeString()} ${event.message}`;
      return li;
    }),
  );
}

function drawChart() {
  const ctx = chart.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const width = chart.clientWidth;
  const height = chart.clientHeight;
  chart.width = Math.floor(width * dpr);
  chart.height = Math.floor(height * dpr);
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);

  const history = latest.history || [];
  if (history.length < 2) return;
  const pad = 28;
  const maxCount = Math.max(
    1,
    ...history.map((p) => Math.max(p.queued, p.active, p.hot, p.warm)),
  );
  const maxRss = Math.max(1, ...history.map((p) => p.vmmRssBytes));

  grid(ctx, width, height, pad);
  line(ctx, history, width, height, pad, maxCount, "queued", "#b45309");
  line(ctx, history, width, height, pad, maxCount, "active", "#0f766e");
  line(ctx, history, width, height, pad, maxCount, "hot", "#1d4ed8");
  line(ctx, history, width, height, pad, maxCount, "warm", "#7c3aed");
  line(ctx, history, width, height, pad, maxRss, "vmmRssBytes", "#111827");
  legend(ctx, [
    ["queued", "#b45309"],
    ["active", "#0f766e"],
    ["hot", "#1d4ed8"],
    ["warm", "#7c3aed"],
    ["rss", "#111827"],
  ]);
}

function grid(ctx, width, height, pad) {
  ctx.strokeStyle = "#e5e7eb";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const y = pad + ((height - pad * 2) * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(width - pad, y);
    ctx.stroke();
  }
}

function line(ctx, history, width, height, pad, max, key, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  history.forEach((point, index) => {
    const x = pad + ((width - pad * 2) * index) / (history.length - 1);
    const y = height - pad - ((height - pad * 2) * point[key]) / max;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function legend(ctx, items) {
  ctx.font = "12px system-ui";
  let x = 34;
  for (const [label, color] of items) {
    ctx.fillStyle = color;
    ctx.fillRect(x, 10, 10, 10);
    ctx.fillStyle = "#374151";
    ctx.fillText(label, x + 14, 20);
    x += 78;
  }
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

function ms(value) {
  if (!Number.isFinite(value)) return "0 ms";
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value.toFixed(0)} ms`;
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

poll();
setInterval(poll, 1000);
