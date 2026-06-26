export function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Gondolin User Arcade</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #16181d;
      --muted: #68707f;
      --line: #d9dfeb;
      --panel: #ffffff;
      --page: #f5f7fb;
      --hot: #ff4d6d;
      --gold: #ffb703;
      --mint: #2ec4b6;
      --sky: #4cc9f0;
      --violet: #7c3aed;
      --shadow: 0 18px 42px rgba(22, 24, 29, 0.1);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-width: 320px;
      color: var(--ink);
      background:
        linear-gradient(135deg, rgba(76, 201, 240, 0.18), transparent 34%),
        linear-gradient(315deg, rgba(255, 183, 3, 0.22), transparent 30%),
        var(--page);
    }

    button, input { font: inherit; }

    .shell {
      width: min(1480px, 100%);
      margin: 0 auto;
      padding: 22px;
    }

    header {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 16px;
      align-items: center;
      margin-bottom: 18px;
    }

    h1 {
      margin: 0;
      font-size: clamp(2rem, 4vw, 4.8rem);
      line-height: 0.92;
      letter-spacing: 0;
    }

    .subtitle {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 10px;
      color: var(--muted);
      font-weight: 700;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      min-height: 30px;
      padding: 6px 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.82);
      color: var(--ink);
      white-space: nowrap;
    }

    .badge.hot { border-color: rgba(255, 77, 109, 0.55); color: #a91535; }
    .badge.live { border-color: rgba(46, 196, 182, 0.7); color: #087f73; }

    .actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 8px;
    }

    .btn {
      border: 0;
      border-radius: 8px;
      min-height: 42px;
      padding: 0 15px;
      color: white;
      background: var(--ink);
      cursor: pointer;
      font-weight: 800;
      box-shadow: 0 8px 20px rgba(22, 24, 29, 0.12);
    }

    .btn.alt { background: var(--violet); }
    .btn.warn { background: var(--hot); }
    .btn.gold { background: #b86b00; }
    .btn:disabled { opacity: 0.45; cursor: not-allowed; }

    .grid {
      display: grid;
      grid-template-columns: minmax(0, 1.45fr) minmax(340px, 0.55fr);
      gap: 16px;
    }

    .metrics {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 16px;
    }

    .metric, .panel, .control {
      background: rgba(255, 255, 255, 0.9);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
    }

    .metric {
      min-height: 94px;
      padding: 13px;
      overflow: hidden;
    }

    .metric .label {
      color: var(--muted);
      font-size: 0.78rem;
      font-weight: 800;
      text-transform: uppercase;
    }

    .metric .value {
      margin-top: 8px;
      font-size: clamp(1.65rem, 4vw, 3.1rem);
      line-height: 0.95;
      font-weight: 900;
    }

    .arena {
      overflow: hidden;
      min-height: 520px;
    }

    .arena-head, .panel-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 16px;
      border-bottom: 1px solid var(--line);
    }

    h2 {
      margin: 0;
      font-size: 1rem;
      letter-spacing: 0;
    }

    .canvas-wrap {
      position: relative;
      min-height: 440px;
      background:
        linear-gradient(90deg, rgba(22, 24, 29, 0.05) 1px, transparent 1px),
        linear-gradient(rgba(22, 24, 29, 0.05) 1px, transparent 1px);
      background-size: 34px 34px;
    }

    #arena {
      display: block;
      width: 100%;
      height: 440px;
    }

    .controls {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      margin-top: 16px;
    }

    .control {
      padding: 14px;
      min-height: 106px;
    }

    .control label {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      color: var(--muted);
      font-size: 0.78rem;
      font-weight: 900;
      text-transform: uppercase;
    }

    .control strong { color: var(--ink); font-size: 0.95rem; }

    input[type="range"] {
      width: 100%;
      margin: 16px 0 0;
      accent-color: var(--violet);
    }

    .side {
      display: grid;
      gap: 16px;
      align-content: start;
    }

    .panel {
      overflow: hidden;
      min-height: 0;
    }

    .list {
      display: grid;
      gap: 8px;
      max-height: 352px;
      overflow: auto;
      padding: 12px;
    }

    .resource-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      padding: 12px;
    }

    .resource-item {
      min-height: 94px;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: white;
    }

    .resource-label {
      color: var(--muted);
      font-size: 0.72rem;
      font-weight: 900;
      text-transform: uppercase;
    }

    .resource-value {
      margin-top: 6px;
      font-size: 1.35rem;
      line-height: 1;
      font-weight: 950;
      overflow-wrap: anywhere;
    }

    .resource-meta {
      margin-top: 6px;
      color: var(--muted);
      font-size: 0.78rem;
      font-weight: 800;
      overflow-wrap: anywhere;
    }

    .bar {
      width: 100%;
      height: 8px;
      margin-top: 9px;
      overflow: hidden;
      border-radius: 999px;
      background: #edf1f7;
    }

    .bar > span {
      display: block;
      width: 0%;
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, var(--mint), var(--gold), var(--hot));
      transition: width 180ms ease;
    }

    .user-row, .event-row {
      display: grid;
      gap: 4px;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: white;
    }

    .user-row {
      grid-template-columns: 12px 1fr auto;
      align-items: center;
    }

    .dot {
      width: 12px;
      height: 12px;
      border-radius: 999px;
      background: var(--mint);
    }

    .row-title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 900;
    }

    .row-meta {
      color: var(--muted);
      font-size: 0.82rem;
      font-weight: 700;
      overflow-wrap: anywhere;
    }

    .state {
      border-radius: 8px;
      padding: 4px 7px;
      background: #eef2ff;
      color: #3730a3;
      font-size: 0.72rem;
      font-weight: 900;
      text-transform: uppercase;
    }

    .empty {
      padding: 24px 12px;
      color: var(--muted);
      font-weight: 800;
      text-align: center;
    }

    @media (max-width: 980px) {
      .grid { grid-template-columns: 1fr; }
      .metrics, .controls { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      header { grid-template-columns: 1fr; }
      .actions { justify-content: flex-start; }
    }

    @media (max-width: 560px) {
      .shell { padding: 14px; }
      .metrics, .controls, .resource-grid { grid-template-columns: 1fr; }
      .arena { min-height: 420px; }
      .canvas-wrap { min-height: 340px; }
      #arena { height: 340px; }
      .btn { flex: 1 1 45%; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header>
      <div>
        <h1>Gondolin User Arcade</h1>
        <div class="subtitle">
          <span id="backend" class="badge">backend</span>
          <span id="status" class="badge">paused</span>
          <span id="cap" class="badge hot">caps</span>
        </div>
      </div>
      <div class="actions">
        <button id="start" class="btn alt" type="button">Start</button>
        <button id="pause" class="btn gold" type="button">Pause</button>
        <button id="burst" class="btn" type="button">Burst</button>
        <button id="reset" class="btn warn" type="button">Reset</button>
      </div>
    </header>

    <section class="metrics" aria-label="Current load">
      <div class="metric"><div class="label">Crowd</div><div id="m-users" class="value">0</div></div>
      <div class="metric"><div class="label">VM Slots</div><div id="m-vms" class="value">0</div></div>
      <div class="metric"><div class="label">Msgs/min</div><div id="m-mpm" class="value">0</div></div>
      <div class="metric"><div class="label">p95 ms</div><div id="m-p95" class="value">-</div></div>
    </section>

    <section class="grid">
      <div>
        <section class="panel arena">
          <div class="arena-head">
            <h2>Live Floor</h2>
            <span id="floor-note" class="badge">0 queued</span>
          </div>
          <div class="canvas-wrap">
            <canvas id="arena"></canvas>
          </div>
        </section>

        <section class="controls" aria-label="Load controls">
          <div class="control">
            <label for="target">Crowd <strong id="target-value">0</strong></label>
            <input id="target" type="range" min="0" value="0" step="1">
          </div>
          <div class="control">
            <label for="slots">VM Slots <strong id="slots-value">0</strong></label>
            <input id="slots" type="range" min="1" value="1" step="1">
          </div>
          <div class="control">
            <label for="spawn">Arrivals/min <strong id="spawn-value">0</strong></label>
            <input id="spawn" type="range" min="0" value="0" step="1">
          </div>
          <div class="control">
            <label for="tempo">Tempo <strong id="tempo-value">1x</strong></label>
            <input id="tempo" type="range" min="0.1" value="1" step="0.1">
          </div>
        </section>
      </div>

      <aside class="side">
        <section class="panel">
          <div class="panel-head">
            <h2>Resources</h2>
            <span id="res-status" class="badge">loading</span>
          </div>
          <div class="resource-grid">
            <div class="resource-item">
              <div class="resource-label">Pod CPU</div>
              <div id="res-cpu" class="resource-value">-</div>
              <div id="res-cpu-meta" class="resource-meta">request / limit</div>
              <div class="bar"><span id="res-cpu-bar"></span></div>
            </div>
            <div class="resource-item">
              <div class="resource-label">Pod Memory</div>
              <div id="res-mem" class="resource-value">-</div>
              <div id="res-mem-meta" class="resource-meta">request / limit</div>
              <div class="bar"><span id="res-mem-bar"></span></div>
            </div>
            <div class="resource-item" title="Configured guest RAM budget, not pod RSS">
              <div class="resource-label">Guest RAM Budget</div>
              <div id="res-guest" class="resource-value">-</div>
              <div id="res-guest-meta" class="resource-meta">live slots x VM max</div>
              <div class="bar"><span id="res-guest-bar"></span></div>
            </div>
            <div class="resource-item">
              <div class="resource-label">Pod</div>
              <div id="res-pod" class="resource-value">-</div>
              <div id="res-pod-meta" class="resource-meta">phase / restarts</div>
            </div>
          </div>
        </section>
        <section class="panel">
          <div class="panel-head">
            <h2>Active Users</h2>
            <span id="user-count" class="badge">0</span>
          </div>
          <div id="users" class="list"></div>
        </section>
        <section class="panel">
          <div class="panel-head">
            <h2>Run Log</h2>
            <span id="error-count" class="badge hot">0 errors</span>
          </div>
          <div id="events" class="list"></div>
        </section>
      </aside>
    </section>
  </main>

  <script>
    const els = {
      backend: document.getElementById("backend"),
      status: document.getElementById("status"),
      cap: document.getElementById("cap"),
      start: document.getElementById("start"),
      pause: document.getElementById("pause"),
      burst: document.getElementById("burst"),
      reset: document.getElementById("reset"),
      target: document.getElementById("target"),
      slots: document.getElementById("slots"),
      spawn: document.getElementById("spawn"),
      tempo: document.getElementById("tempo"),
      targetValue: document.getElementById("target-value"),
      slotsValue: document.getElementById("slots-value"),
      spawnValue: document.getElementById("spawn-value"),
      tempoValue: document.getElementById("tempo-value"),
      users: document.getElementById("users"),
      events: document.getElementById("events"),
      userCount: document.getElementById("user-count"),
      errorCount: document.getElementById("error-count"),
      floorNote: document.getElementById("floor-note"),
      mUsers: document.getElementById("m-users"),
      mVms: document.getElementById("m-vms"),
      mMpm: document.getElementById("m-mpm"),
      mP95: document.getElementById("m-p95"),
      resStatus: document.getElementById("res-status"),
      resCpu: document.getElementById("res-cpu"),
      resCpuMeta: document.getElementById("res-cpu-meta"),
      resCpuBar: document.getElementById("res-cpu-bar"),
      resMem: document.getElementById("res-mem"),
      resMemMeta: document.getElementById("res-mem-meta"),
      resMemBar: document.getElementById("res-mem-bar"),
      resGuest: document.getElementById("res-guest"),
      resGuestMeta: document.getElementById("res-guest-meta"),
      resGuestBar: document.getElementById("res-guest-bar"),
      resPod: document.getElementById("res-pod"),
      resPodMeta: document.getElementById("res-pod-meta"),
      canvas: document.getElementById("arena")
    };

    let state = null;
    let resources = null;
    let dirtyControls = false;
    let lastControlSend = 0;
    const ctx = els.canvas.getContext("2d");

    function fmtMs(value) {
      if (value === null || value === undefined) return "-";
      return Math.round(value).toLocaleString();
    }

    function fmtCpu(value) {
      if (value === null || value === undefined) return "-";
      if (value >= 1000) return (value / 1000).toFixed(value >= 10000 ? 0 : 1) + " cores";
      return Math.round(value) + "m";
    }

    function fmtBytes(value) {
      if (value === null || value === undefined) return "-";
      const units = ["B", "Ki", "Mi", "Gi", "Ti"];
      let n = value;
      let i = 0;
      while (n >= 1024 && i < units.length - 1) {
        n /= 1024;
        i += 1;
      }
      return n.toFixed(i === 0 || n >= 10 ? 0 : 1) + " " + units[i];
    }

    function pct(value, max) {
      if (!value || !max) return 0;
      return Math.max(0, Math.min(100, (value / max) * 100));
    }

    async function api(path, body) {
      const res = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    }

    async function loadState() {
      const [stateRes, resourceRes] = await Promise.all([
        fetch("/api/state", { cache: "no-store" }),
        fetch("/api/resources", { cache: "no-store" }).catch(() => null)
      ]);
      if (!stateRes.ok) return;
      state = await stateRes.json();
      resources = resourceRes && resourceRes.ok ? await resourceRes.json() : null;
      applyState();
    }

    function applyState() {
      if (!state) return;
      els.backend.textContent = state.backend;
      els.status.textContent = state.settings.running ? "running" : "paused";
      els.status.className = "badge " + (state.settings.running ? "live" : "");
      els.cap.textContent = "cap " + state.caps.maxActiveUsers + " users / " + state.caps.maxActiveVms + " VMs";
      els.mUsers.textContent = state.gauges.activeUsers;
      els.mVms.textContent = state.gauges.activeVms + "/" + state.settings.maxActiveVms;
      els.mMpm.textContent = state.gauges.messagesPerMinute;
      els.mP95.textContent = fmtMs(state.gauges.p95LatencyMs);
      els.floorNote.textContent = state.gauges.queuedUsers + " queued";
      els.userCount.textContent = String(state.users.length);
      els.errorCount.textContent = state.totals.errors + " errors";

      if (!dirtyControls) {
        els.target.max = state.caps.maxActiveUsers;
        els.slots.max = state.caps.maxActiveVms;
        els.spawn.max = state.caps.maxSpawnRatePerMinute;
        els.tempo.max = state.caps.maxTempo;
        els.target.value = state.settings.targetUsers;
        els.slots.value = state.settings.maxActiveVms;
        els.spawn.value = state.settings.spawnRatePerMinute;
        els.tempo.value = state.settings.tempo;
        labelControls();
      }
      renderUsers(state.users);
      renderEvents(state.events);
      renderResources();
      drawArena();
    }

    function renderResources() {
      if (!resources) {
        els.resStatus.textContent = "unavailable";
        els.resCpu.textContent = "-";
        els.resMem.textContent = "-";
        els.resGuest.textContent = "-";
        els.resPod.textContent = "-";
        return;
      }

      els.resStatus.textContent = resources.available ? "live" : "limited";
      els.resStatus.className = "badge " + (resources.available ? "live" : "hot");

      const cpu = resources.cpu;
      els.resCpu.textContent = fmtCpu(cpu.usageMillicores);
      els.resCpuMeta.textContent = fmtCpu(cpu.requestMillicores) + " req / " + fmtCpu(cpu.limitMillicores) + " limit";
      els.resCpuBar.style.width = pct(cpu.usageMillicores, cpu.limitMillicores || cpu.requestMillicores) + "%";

      const mem = resources.memory;
      els.resMem.textContent = fmtBytes(mem.usageBytes);
      els.resMemMeta.textContent = fmtBytes(mem.requestBytes) + " req / " + fmtBytes(mem.limitBytes) + " limit";
      els.resMemBar.style.width = pct(mem.usageBytes, mem.limitBytes || mem.requestBytes) + "%";

      const vms = resources.vms;
      els.resGuest.textContent = fmtBytes(vms.estimatedGuestMemoryBytes);
      els.resGuestMeta.textContent = vms.activeSlots + "/" + vms.configuredSlots + " slots x " + fmtBytes(vms.guestMemoryBytesEach) + " max";
      els.resGuestBar.style.width = pct(vms.activeSlots, vms.configuredSlots) + "%";

      const podName = resources.pod.name || "-";
      els.resPod.textContent = podName.length > 18 ? podName.slice(0, 18) + "..." : podName;
      els.resPodMeta.textContent = (resources.pod.phase || "-") + " / " + String(resources.pod.restartCount ?? 0) + " restarts";
    }

    function labelControls() {
      els.targetValue.textContent = els.target.value;
      els.slotsValue.textContent = els.slots.value;
      els.spawnValue.textContent = els.spawn.value;
      els.tempoValue.textContent = Number(els.tempo.value).toFixed(1) + "x";
    }

    function renderUsers(users) {
      els.users.textContent = "";
      if (users.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "No active users";
        els.users.append(empty);
        return;
      }
      for (const user of users.slice(0, 32)) {
        const row = document.createElement("div");
        row.className = "user-row";
        const dot = document.createElement("span");
        dot.className = "dot";
        dot.style.background = user.color;
        const main = document.createElement("div");
        main.style.minWidth = "0";
        const title = document.createElement("div");
        title.className = "row-title";
        title.textContent = user.name + " - " + user.profile;
        const meta = document.createElement("div");
        meta.className = "row-meta";
        meta.textContent = user.messagesSent + "/" + user.messageBudget + " msgs - " + fmtMs(user.lastLatencyMs) + " ms";
        main.append(title, meta);
        const statePill = document.createElement("span");
        statePill.className = "state";
        statePill.textContent = user.inFlight ? "busy" : user.state;
        row.append(dot, main, statePill);
        els.users.append(row);
      }
    }

    function renderEvents(events) {
      els.events.textContent = "";
      if (events.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "No events yet";
        els.events.append(empty);
        return;
      }
      for (const event of events.slice(0, 24)) {
        const row = document.createElement("div");
        row.className = "event-row";
        const title = document.createElement("div");
        title.className = "row-title";
        title.textContent = event.title;
        const meta = document.createElement("div");
        meta.className = "row-meta";
        meta.textContent = new Date(event.at).toLocaleTimeString() + " - " + event.detail;
        if (event.level === "error") row.style.borderColor = "rgba(255, 77, 109, 0.65)";
        row.append(title, meta);
        els.events.append(row);
      }
    }

    function drawArena() {
      const canvas = els.canvas;
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const width = Math.max(1, Math.floor(rect.width * dpr));
      const height = Math.max(1, Math.floor(rect.height * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const radius = Math.min(rect.width, rect.height) * 0.34;
      ctx.lineWidth = 2;
      for (let i = 0; i < 4; i += 1) {
        ctx.strokeStyle = ["#ff4d6d", "#ffb703", "#2ec4b6", "#4cc9f0"][i];
        ctx.globalAlpha = 0.45;
        ctx.beginPath();
        ctx.arc(cx, cy, radius * (0.45 + i * 0.18), 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#16181d";
      ctx.font = "900 20px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(String(state.gauges.activeVms) + " active VMs", cx, cy - 4);
      ctx.font = "800 13px system-ui, sans-serif";
      ctx.fillStyle = "#68707f";
      ctx.fillText(String(state.gauges.liveUsers) + " live / " + String(state.gauges.queuedUsers) + " queued", cx, cy + 20);

      const users = state.users;
      const now = performance.now() / 1000;
      for (let i = 0; i < users.length; i += 1) {
        const user = users[i];
        const base = hash(user.id);
        const angle = (base % 628) / 100 + now * (user.inFlight ? 1.2 : 0.25);
        const lane = user.state === "queued" ? 1.12 : 0.58 + ((base >> 4) % 34) / 100;
        const x = cx + Math.cos(angle) * radius * lane;
        const y = cy + Math.sin(angle) * radius * lane;
        const size = user.inFlight ? 13 : user.state === "queued" ? 8 : 10;
        ctx.beginPath();
        ctx.fillStyle = user.color;
        ctx.globalAlpha = user.state === "queued" ? 0.55 : 0.92;
        ctx.arc(x, y, size, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#ffffff";
        ctx.stroke();
      }
    }

    function hash(text) {
      let h = 2166136261;
      for (let i = 0; i < text.length; i += 1) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return h >>> 0;
    }

    function scheduleSettingsSend() {
      dirtyControls = true;
      labelControls();
      const now = performance.now();
      if (now - lastControlSend < 160) return;
      lastControlSend = now;
      api("/api/settings", {
        targetUsers: Number(els.target.value),
        maxActiveVms: Number(els.slots.value),
        spawnRatePerMinute: Number(els.spawn.value),
        tempo: Number(els.tempo.value)
      }).finally(() => {
        setTimeout(() => {
          dirtyControls = false;
          loadState();
        }, 250);
      });
    }

    for (const input of [els.target, els.slots, els.spawn, els.tempo]) {
      input.addEventListener("input", scheduleSettingsSend);
    }

    els.start.addEventListener("click", () => api("/api/action", { action: "start" }).then(loadState));
    els.pause.addEventListener("click", () => api("/api/action", { action: "pause" }).then(loadState));
    els.reset.addEventListener("click", () => api("/api/action", { action: "reset" }).then(loadState));
    els.burst.addEventListener("click", () => api("/api/action", { action: "burst", value: 3 }).then(loadState));
    window.addEventListener("resize", drawArena);

    setInterval(loadState, 1000);
    setInterval(drawArena, 80);
    loadState();
  </script>
</body>
</html>`;
}
