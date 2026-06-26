let latest = null;
let formReady = false;
let lastLiveAt = 0;

const $ = (selector) => document.querySelector(selector);

const form = $("#configForm");
const chart = $("#historyChart");
const streamStatus = $("#streamStatus");

const score = {
  completed: $("#scoreCompleted"),
  run: $("#scoreRun"),
  queued: $("#scoreQueued"),
  active: $("#scoreActive"),
  slots: $("#scoreSlots"),
  hot: $("#scoreHot"),
  warm: $("#scoreWarm"),
  snapshotBytes: $("#scoreSnapshotBytes"),
  failed: $("#scoreFailed"),
  snapshotFails: $("#scoreSnapshotFails"),
};

$("#startBtn").addEventListener("click", () => post("/api/start"));
$("#pauseBtn").addEventListener("click", () => post("/api/pause"));
$("#resetBtn").addEventListener("click", () => post("/api/reset"));
$("#burstBtn").addEventListener("click", () =>
  post("/api/burst", { count: Number($("#burstCount").value || 1) }),
);
$("#userTaskBtn").addEventListener("click", () =>
  post("/api/user-task", { userId: $("#userTaskId").value }),
);

form.addEventListener("submit", (event) => {
  event.preventDefault();
  submitConfig();
});
$("#applyConfigBtn").addEventListener("click", (event) => {
  event.preventDefault();
  submitConfig();
});
$("#topApplyConfigBtn").addEventListener("click", (event) => {
  event.preventDefault();
  submitConfig();
});

function submitConfig() {
  const data = new FormData(form);
  post(
    "/api/config",
    {
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
    },
    true,
  );
}

async function post(url, body = {}, refill = false) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  renderState(await response.json());
  if (refill && latest) fillForm(latest.config);
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
  renderHeader();
  renderScore();
  renderLanes();
  renderMeters();
  renderSessions();
  renderEvents();
  drawChart();
}

function fillForm(config) {
  for (const [key, value] of Object.entries(config)) {
    const input = form.elements.namedItem(key);
    if (!input) continue;
    if (input.type === "checkbox") input.checked = Boolean(value);
    else input.value = value;
  }
  formReady = true;
}

function renderHeader() {
  $("#runState").textContent = latest.running ? "running" : "paused";
  $("#runState").classList.toggle("running", latest.running);
  $("#strategyReadout").textContent = `${latest.config.strategy} strategy`;
  document.body.dataset.running = latest.running ? "true" : "false";
}

function renderScore() {
  const counts = latest.counts;
  const metrics = latest.metrics;
  const active = activeCount(counts);
  score.completed.textContent = metrics.tasksCompleted;
  score.run.textContent = `${ms(metrics.avgRunMs)} avg run`;
  score.queued.textContent = counts.queued || 0;
  score.active.textContent = active;
  score.slots.textContent = `${counts.slots || 0} / ${latest.config.maxActiveVms} slots`;
  score.hot.textContent = counts.hot || 0;
  score.warm.textContent = counts.warm || 0;
  score.snapshotBytes.textContent = bytes(metrics.snapshotBytes);
  score.failed.textContent = metrics.tasksFailed;
  score.snapshotFails.textContent = `${metrics.snapshotFailures} snapshot fails`;
}

function renderLanes() {
  const counts = latest.counts;
  const lanes = [
    {
      key: "queued",
      title: "Queue",
      value: counts.queued || 0,
      statuses: ["queued"],
    },
    {
      key: "active",
      title: "Booting + Running",
      value: activeCount(counts),
      statuses: ["starting", "running", "snapshotting", "closing"],
    },
    {
      key: "hot",
      title: "Hot VMs",
      value: counts.hot || 0,
      statuses: ["hot"],
    },
    {
      key: "warm",
      title: "Saved VMs",
      value: counts.warm || 0,
      statuses: ["warm"],
    },
    {
      key: "error",
      title: "Needs Attention",
      value: counts.error || latest.metrics.tasksFailed || 0,
      statuses: ["error"],
    },
  ];

  $("#laneGrid").replaceChildren(
    ...lanes.map((lane) => {
      const sessions = latest.sessions
        .filter((session) => lane.statuses.includes(session.status))
        .slice(0, 24);
      const node = el("article", `lane lane-${lane.key}`);
      const head = el("div", "lane-head");
      head.append(el("span", "", lane.title), el("strong", "", String(lane.value)));
      const tokens = el("div", "tokens");
      if (sessions.length === 0) {
        tokens.append(el("span", "empty-token", "clear"));
      } else {
        for (const session of sessions) tokens.append(sessionToken(session));
      }
      node.append(head, tokens);
      return node;
    }),
  );
}

function sessionToken(session) {
  const token = el("div", `token token-${session.status}`);
  token.title = `${session.id} ${session.status}`;
  token.append(
    el("span", "token-dot"),
    el("span", "token-id", compactUser(session.id)),
    el("span", "token-tasks", String(session.tasksCompleted)),
  );
  return token;
}

function renderMeters() {
  const counts = latest.counts;
  const config = latest.config;
  const resource = latest.resource;
  const metrics = latest.metrics;
  const activeSlots = counts.slots || 0;
  const slotRatio = ratio(activeSlots, config.maxActiveVms);
  const queueRatio = ratio(counts.queued || 0, Math.max(1, config.maxActiveVms * 2));
  const vmMemBytes = parseBytes(config.vmMemory);
  const rssLimit = vmMemBytes ? vmMemBytes * Math.max(1, config.maxActiveVms) * 1.5 : 1;
  const rssRatio = ratio(resource.vmmRssBytes, rssLimit);
  const hostFreeRatio = ratio(resource.freeMemBytes, resource.totalMemBytes);

  setBar("#slotBar", slotRatio);
  setBar("#rssBar", rssRatio);
  setBar("#hostBar", hostFreeRatio);
  setBar("#queueBar", queueRatio);
  $("#slotText").textContent = percent(slotRatio);
  $("#rssText").textContent = bytes(resource.vmmRssBytes);
  $("#hostText").textContent = bytes(resource.freeMemBytes);
  $("#queueText").textContent = percent(queueRatio);
  $("#resourceReadout").textContent =
    `cold ${metrics.coldBoots} | restores ${metrics.restores} | host ${bytes(resource.processRssBytes)}`;
}

function setBar(selector, value) {
  $(selector).style.width = `${Math.round(Math.max(0.02, Math.min(1, value)) * 100)}%`;
}

function renderSessions() {
  $("#rosterSummary").textContent = `${latest.sessions.length} visible sessions`;
  const sessions = latest.sessions.slice(0, 18);
  $("#sessionsList").replaceChildren(
    ...(sessions.length
      ? sessions.map((session) => {
          const card = el("article", `session-card status-${session.status}`);
          card.append(
            el("strong", "", session.id),
            el("span", "session-status", session.status),
            el(
              "small",
              "",
              `tasks ${session.tasksCompleted} | pid ${session.pid || "none"}`,
            ),
            el(
              "p",
              session.lastError ? "bad" : "",
              session.lastError || session.lastResult || "waiting",
            ),
          );
          return card;
        })
      : [el("div", "empty-panel", "No user sessions yet")]),
  );
}

function renderEvents() {
  const events = latest.events.slice(0, 40);
  $("#feedSummary").textContent = events.length
    ? `${events.length} recent events`
    : "no events yet";
  $("#eventsList").replaceChildren(
    ...(events.length
      ? events.map((event) => {
          const item = el("li", event.level);
          item.append(
            el("span", "event-time", new Date(event.at).toLocaleTimeString()),
            el("span", "event-text", event.message),
          );
          return item;
        })
      : [el("li", "info", "Waiting for arena events")]),
  );
}

function drawChart() {
  const ctx = chart.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const width = chart.clientWidth;
  const height = chart.clientHeight;
  chart.width = Math.floor(width * dpr);
  chart.height = Math.floor(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const history = latest.history || [];
  if (history.length < 2) {
    ctx.fillStyle = "#657182";
    ctx.font = "13px system-ui";
    ctx.fillText("Waiting for live samples", 24, 42);
    return;
  }

  const pad = 30;
  const maxCount = Math.max(
    1,
    ...history.map((p) => Math.max(p.queued, p.active, p.hot, p.warm)),
  );
  const maxRss = Math.max(1, ...history.map((p) => p.vmmRssBytes));

  drawGrid(ctx, width, height, pad);
  drawLine(ctx, history, width, height, pad, maxCount, "queued", "#c47a11");
  drawLine(ctx, history, width, height, pad, maxCount, "active", "#009b72");
  drawLine(ctx, history, width, height, pad, maxCount, "hot", "#2563eb");
  drawLine(ctx, history, width, height, pad, maxCount, "warm", "#8b5cf6");
  drawLine(ctx, history, width, height, pad, maxRss, "vmmRssBytes", "#e11d48");
  drawLegend(ctx, [
    ["queue", "#c47a11"],
    ["active", "#009b72"],
    ["hot", "#2563eb"],
    ["saved", "#8b5cf6"],
    ["rss", "#e11d48"],
  ]);
}

function drawGrid(ctx, width, height, pad) {
  ctx.strokeStyle = "#d8dee9";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const y = pad + ((height - pad * 2) * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(width - pad, y);
    ctx.stroke();
  }
}

function drawLine(ctx, history, width, height, pad, max, key, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.lineJoin = "round";
  ctx.beginPath();
  history.forEach((point, index) => {
    const x = pad + ((width - pad * 2) * index) / (history.length - 1);
    const y = height - pad - ((height - pad * 2) * point[key]) / max;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function drawLegend(ctx, items) {
  ctx.font = "12px system-ui";
  let x = 34;
  for (const [label, color] of items) {
    ctx.fillStyle = color;
    ctx.fillRect(x, 10, 10, 10);
    ctx.fillStyle = "#354052";
    ctx.fillText(label, x + 14, 20);
    x += 78;
  }
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

function parseBytes(value) {
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?)([kmgt])?b?$/i);
  if (!match) return 0;
  const n = Number(match[1]);
  const unit = (match[2] || "").toUpperCase();
  const scale = { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
  return n * scale[unit];
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

function el(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

connectStream();
