"use strict";

const { addLog, getLogs } = require("./logger");
const mineflayer = require("mineflayer");
const { Movements, pathfinder, goals } = require("mineflayer-pathfinder");
const { GoalBlock } = goals;
const config = require("./settings.json");
const express = require("express");
const http = require("http");
const https = require("https");

// ============================================================
// GLOBAL STATE & LIFECYCLE VARIABLES (Moved up for safety)
// ============================================================
let bot = null;
let activeIntervals = [];
let reconnectTimeoutId = null;
let connectionTimeoutId = null;
let watchdogTimeoutId = null;
let isReconnecting = false;
let delayEndTime = 0;
let botRunning = true;

const PLAYER_AVOIDANCE_DELAY = 80 * 60 * 1000;
const NIGHT_SLEEP_DELAY = 1.5 * 60 * 60 * 1000; // 1.5 hours in milliseconds

let isWaitingForPlayerClear = false;
let isNightSleep = false;
let lastNightSleepDate = null;

let botState = {
  connected: false,
  lastActivity: Date.now(),
  reconnectAttempts: 0,
  startTime: Date.now(),
  errors: [],
  wasThrottled: false,
};

// ============================================================
// EXPRESS SERVER & KEEP-ALIVE DASHBOARD
// ============================================================
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 5000;

app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <title>${config.name || 'Minecraft'} Dashboard</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="stylesheet" media="print" onload="this.media='all'"
              href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
        <style>
          *, *::before, *::after { box-sizing: border-box; }
          body { font-family: 'Inter', -apple-system, sans-serif; background: #0d1117; color: #e6edf3; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 24px; }
          main { width: 100%; max-width: 400px; }
          header { margin-bottom: 28px; }
          header h1 { font-size: 26px; font-weight: 700; color: #f0f6fc; margin: 0; line-height: 1.2; }
          header p { font-size: 14px; color: #8b949e; margin: 6px 0 0; line-height: 1.5; }
          .status-section { border-radius: 12px; padding: 20px 24px; margin-bottom: 16px; display: flex; align-items: center; gap: 16px; transition: background 0.3s, border-color 0.3s; }
          .status-section.online  { background: #0d2218; border: 2px solid #238636; }
          .status-section.offline { background: #200d0d; border: 2px solid #da3633; }
          .status-icon { width: 44px; height: 44px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 20px; flex-shrink: 0; transition: background 0.3s; }
          .status-icon.online  { background: #238636; }
          .status-icon.offline { background: #da3633; }
          .status-label { font-size: 18px; font-weight: 700; line-height: 1.2; transition: color 0.3s; }
          .status-label.online  { color: #3fb950; }
          .status-label.offline { color: #f85149; }
          .status-detail { font-size: 13px; color: #8b949e; margin-top: 3px; }
          dl { margin: 0; }
          .stat-card { background: #161b22; border: 1px solid #21262d; border-radius: 10px; padding: 16px 20px; margin-bottom: 10px; }
          dt { font-size: 12px; color: #8b949e; font-weight: 600; margin-bottom: 4px; }
          dd { margin: 0; font-size: 17px; font-weight: 600; color: #e6edf3; line-height: 1.3; }
          .stat-detail { margin: 4px 0 0; font-size: 11px; color: #6e7681; }
          .controls { margin-top: 8px; }
          .btn-grid { display: grid; gap: 10px; margin-bottom: 10px; }
          .btn-grid-2 { grid-template-columns: 1fr 1fr; }
          .btn-grid-3 { grid-template-columns: 1fr 1fr 1fr; }
          .btn-primary { min-height: 52px; border-radius: 10px; font-size: 15px; font-weight: 700; cursor: pointer; letter-spacing: 0.3px; transition: opacity 0.2s, filter 0.2s; font-family: inherit; }
          .btn-primary:hover  { filter: brightness(1.1); }
          .btn-primary:active { opacity: 0.85; }
          .btn-start { border: 2px solid #238636; background: #0d2218; color: #3fb950; }
          .btn-stop  { border: 2px solid #da3633; background: #200d0d; color: #f85149; }
          .btn-force { border: 2px solid #d29922; background: #221a0d; color: #e3b341; }
          .btn-secondary { min-height: 44px; border-radius: 10px; border: 1px solid #21262d; background: #161b22; color: #8b949e; font-size: 13px; font-weight: 500; text-decoration: none; display: flex; align-items: center; justify-content: center; font-family: inherit; cursor: pointer; transition: background 0.2s, color 0.2s; }
          .btn-secondary:hover { background: #21262d; color: #c9d1d9; }
          .dash-cmd-box { display: flex; gap: 8px; margin-top: 8px; }
          .dash-cmd-input { flex: 1; background: #0d1117; border: 1px solid #30363d; border-radius: 8px; padding: 10px 12px; color: #e6edf3; font-family: inherit; font-size: 13.5px; outline: none; }
          .dash-cmd-input:focus { border-color: #238636; }
          .dash-cmd-btn { background: #0d2218; border: 1px solid #238636; color: #3fb950; font-weight: 600; padding: 0 16px; border-radius: 8px; cursor: pointer; font-family: inherit; transition: background 0.2s; }
          .dash-cmd-btn:hover { background: #122d1a; }
          footer { margin-top: 20px; text-align: center; }
          footer p { font-size: 12px; color: #484f58; margin: 0; }
        </style>
      </head>
      <body>
        <main role="main">
          <header>
            <h1>AFK Bot Dashboard</h1>
            <p>Minecraft server bot &middot; Live status</p>
          </header>
          <section id="status-section" class="status-section offline">
            <div id="status-icon" class="status-icon offline">&#x2717;</div>
            <div>
              <div id="status-label" class="status-label offline">Connecting…</div>
              <div id="status-detail" class="status-detail">Establishing connection</div>
            </div>
          </section>
          <section>
            <dl>
              <div class="stat-card">
                <dt>Server Time (UTC)</dt>
                <dd id="bot-clock">Loading...</dd>
                <p class="stat-detail">Live internal bot time</p>
              </div>
              <div class="stat-card">
                <dt>Uptime</dt>
                <dd id="uptime-text">—</dd>
                <p class="stat-detail">Time since last connection</p>
              </div>
              <div class="stat-card">
                <dt>Coordinates</dt>
                <dd id="coords-text">Searching…</dd>
                <p class="stat-detail">Bot's current in-game position</p>
              </div>
              <div class="stat-card">
                <dt>Server address</dt>
                <dd>${config.server ? config.server.ip : 'Unknown'}</dd>
                <p class="stat-detail">Minecraft server hostname</p>
              </div>
              <div class="stat-card">
                <dt>Send Web Command / Chat</dt>
                <form onsubmit="sendDashCommand(event)">
                  <div class="dash-cmd-box">
                    <input id="dash-cmd-input" class="dash-cmd-input" type="text" placeholder="/login, /say hello, or chat..." autocomplete="off">
                    <button type="submit" class="dash-cmd-btn">Send</button>
                  </div>
                </form>
                <p id="dash-cmd-feedback" class="stat-detail" style="min-height: 14px; margin-top: 6px;"></p>
              </div>
            </dl>
          </section>
          <section class="controls">
            <div class="btn-grid btn-grid-3">
              <button class="btn-primary btn-start" onclick="startBot()">Start</button>
              <button class="btn-primary btn-stop" onclick="stopBot()">Stop</button>
              <button class="btn-primary btn-force" onclick="forceJoin()">Force Join</button>
            </div>
            <div class="btn-grid btn-grid-2">
              <a href="/tutorial" class="btn-secondary">Setup guide</a>
              <a href="/logs" class="btn-secondary">View logs</a>
            </div>
          </section>
          <footer>
            <p>Status updates every 5 seconds</p>
          </footer>
        </main>
        <script>
          function updateBotTime() {
            const now = new Date();
            document.getElementById('bot-clock').textContent = now.toLocaleTimeString('en-US', { 
                timeZone: 'UTC', hour12: true, hour: 'numeric', minute: 'numeric', second: 'numeric' 
            });
          }
          setInterval(updateBotTime, 1000);
          updateBotTime();

          let countdownInterval = null;

          function formatUptime(s) {
            const h = Math.floor(s / 3600);
            const m = Math.floor((s % 3600) / 60);
            const sec = s % 60;
            if (h > 0) return h + 'h ' + m + 'm ' + sec + 's';
            if (m > 0) return m + 'm ' + sec + 's';
            return sec + ' seconds';
          }

          async function update() {
            try {
              const r = await fetch('/health');
              const data = await r.json();
              const online = data.status === 'connected';

              const section = document.getElementById('status-section');
              const icon    = document.getElementById('status-icon');
              const label   = document.getElementById('status-label');
              const detail  = document.getElementById('status-detail');

              section.className = 'status-section ' + (online ? 'online' : 'offline');
              icon.className    = 'status-icon '    + (online ? 'online' : 'offline');
              icon.textContent  = online ? '✓' : '✗';
              label.className   = 'status-label '   + (online ? 'online' : 'offline');
              label.textContent = online ? 'Connected' : 'Disconnected';

              clearInterval(countdownInterval);
              if (!online && data.delayEndTime && data.delayEndTime > Date.now()) {
                const updateCountdown = () => {
                  const diff = Math.max(0, Math.floor((data.delayEndTime - Date.now()) / 1000));
                  if (diff === 0) {
                    detail.textContent = 'Reconnecting now...';
                    clearInterval(countdownInterval);
                  } else {
                    detail.textContent = 'Waiting for delay... (' + formatUptime(diff) + ' remaining)';
                  }
                };
                updateCountdown();
                countdownInterval = setInterval(updateCountdown, 1000);
              } else {
                detail.textContent = online ? 'Bot is active on the server' : 'Disconnected / Reconnecting';
              }

              document.getElementById('uptime-text').textContent = formatUptime(data.uptime);

              if (data.coords) {
                const x = Math.floor(data.coords.x);
                const y = Math.floor(data.coords.y);
                const z = Math.floor(data.coords.z);
                document.getElementById('coords-text').textContent = 'X ' + x + ', Y ' + y + ', Z ' + z;
              } else {
                document.getElementById('coords-text').textContent = 'Searching…';
              }
            } catch (e) {
              const label = document.getElementById('status-label');
              label.className = 'status-label offline';
              label.textContent = 'Unreachable';
            }
          }

          async function startBot() {
            const r = await fetch('/start', { method: 'POST' });
            const data = await r.json();
            alert(data.success ? 'Bot started!' : data.msg);
            update();
          }

          async function stopBot() {
            const r = await fetch('/stop', { method: 'POST' });
            const data = await r.json();
            alert(data.success ? 'Bot stopped!' : data.msg);
            update();
          }

          async function forceJoin() {
            const r = await fetch('/force-join', { method: 'POST' });
            const data = await r.json();
            alert(data.msg);
            update();
          }

          async function sendDashCommand(e) {
            if (e) e.preventDefault();
            const input = document.getElementById('dash-cmd-input');
            const feedback = document.getElementById('dash-cmd-feedback');
            const cmd = input.value.trim();
            if (!cmd) return;

            feedback.style.color = '#8b949e';
            feedback.textContent = 'Sending...';

            try {
              const r = await fetch('/command', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ command: cmd })
              });
              const data = await r.json();
              feedback.style.color = data.success ? '#3fb950' : '#f85149';
              feedback.textContent = data.msg || (data.success ? 'Command sent successfully!' : 'Error sending command.');
              if (data.success) input.value = '';
            } catch (err) {
              feedback.style.color = '#f85149';
              feedback.textContent = 'Failed to reach server.';
            }
          }

          setInterval(update, 5000);
          update();
        </script>
      </body>
    </html>
  `);
});

app.get("/tutorial", (req, res) => {
  res.send(`<!DOCTYPE html><html><body><h2>Tutorial Page Loaded</h2></body></html>`);
});

app.get("/health", (req, res) => {
  res.json({
    status: botState.connected ? "connected" : "disconnected",
    uptime: Math.floor((Date.now() - botState.startTime) / 1000),
    coords: bot && bot.entity ? bot.entity.position : null,
    lastActivity: botState.lastActivity,
    reconnectAttempts: botState.reconnectAttempts,
    memoryUsage: process.memoryUsage().heapUsed / 1024 / 1024,
    delayEndTime: isReconnecting ? delayEndTime : null,
  });
});

app.get("/ping", (req, res) => res.send("pong"));

app.get("/logs", (req, res) => {
  const logs = getLogs();
  const escapeHTML = (str) =>
    str.replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[m]);

  const logCount = logs.length;

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <title>${config.name || 'Minecraft'} - Logs</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="stylesheet" media="print" onload="this.media='all'" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
        <style>
          /* Log Styles remain unchanged */
          *, *::before, *::after { box-sizing: border-box; }
          body { font-family: 'Inter', -apple-system, sans-serif; background: #0d1117; color: #e6edf3; margin: 0; padding: 40px 24px; }
          main { width: 100%; max-width: 760px; margin: 0 auto; }
          .back-btn { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 500; color: #8b949e; text-decoration: none; background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 7px 14px; margin-bottom: 32px; transition: color 0.2s, background 0.2s; }
          .back-btn:hover { background: #21262d; color: #c9d1d9; }
          .page-header { display: flex; align-items: flex-end; justify-content: space-between; margin-bottom: 20px; gap: 12px; flex-wrap: wrap; }
          .page-header-left h1 { font-size: 26px; font-weight: 700; color: #f0f6fc; margin: 0; line-height: 1.2; }
          .page-header-left p { font-size: 14px; color: #8b949e; margin: 6px 0 0; }
          .badge { font-size: 12px; font-weight: 600; color: #8b949e; background: #161b22; border: 1px solid #21262d; border-radius: 20px; padding: 4px 12px; white-space: nowrap; }
          .log-card { background: #0d1117; border: 1px solid #21262d; border-radius: 12px; overflow: hidden; }
          .log-card-header { background: #161b22; border-bottom: 1px solid #21262d; padding: 12px 18px; display: flex; align-items: center; gap: 8px; }
          .dot { width: 10px; height: 10px; border-radius: 50%; }
          .dot-red   { background: #ff5f57; }
          .dot-yellow{ background: #ffbd2e; }
          .dot-green { background: #28c840; }
          .log-card-title { font-size: 12px; font-weight: 500; color: #484f58; margin-left: 4px; }
          .log-body { padding: 16px 18px; max-height: 560px; overflow-y: auto; font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace; font-size: 12.5px; line-height: 1.7; }
          .log-entry { display: block; padding: 1px 0; white-space: pre-wrap; word-break: break-all; }
          .log-entry.error   { color: #ff7b72; }
          .log-entry.warn    { color: #e3b341; }
          .log-entry.success { color: #3fb950; }
          .log-entry.control { color: #58a6ff; }
          .log-entry.default { color: #8b949e; }
          .console-row { display: flex; align-items: center; border-top: 1px solid #21262d; background: #0d1117; padding: 10px 18px; gap: 10px; }
          .console-prompt { font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace; font-size: 13px; color: #3fb950; font-weight: 700; flex-shrink: 0; }
          .console-input { flex: 1; background: transparent; border: none; outline: none; font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace; font-size: 12.5px; color: #e6edf3; }
          .console-send { background: #0d2218; border: 1px solid #238636; color: #3fb950; font-size: 12px; font-weight: 600; padding: 5px 14px; border-radius: 6px; cursor: pointer; }
        </style>
      </head>
      <body>
        <main>
          <a href="/" class="back-btn">&#8592; Back to Dashboard</a>
          <div class="page-header">
            <div class="page-header-left">
              <h1>Bot Logs</h1>
              <p>Live output from the AFK bot</p>
            </div>
            <span class="badge">${logCount} ${logCount === 1 ? "entry" : "entries"}</span>
          </div>
          <div class="log-card">
            <div class="log-card-header">
              <span class="dot dot-red"></span><span class="dot dot-yellow"></span><span class="dot dot-green"></span>
              <span class="log-card-title">bot.log</span>
            </div>
            <div class="log-body" id="log-body">
              ${logCount === 0
                ? `<div class="empty-state">No log entries yet.</div>`
                : logs.map((l) => {
                    const escaped = escapeHTML(l);
                    const lower = l.toLowerCase();
                    let cls = "default";
                    if (lower.includes("error") || lower.includes("fail")) cls = "error";
                    else if (lower.includes("warn")) cls = "warn";
                    else if (lower.includes("[control]")) cls = "control";
                    else if (lower.includes("connect") || lower.includes("spawn")) cls = "success";
                    return `<span class="log-entry ${cls}">${escaped}</span>`;
                  }).join("")
              }
            </div>
          </div>
        </main>
      </body>
    </html>
  `);
});

app.post("/start", (req, res) => {
  if (botRunning) return res.json({ success: false, msg: "Already running" });
  botRunning = true;
  createBot();
  addLog("[Control] Bot started");
  res.json({ success: true });
});

app.post("/stop", (req, res) => {
  if (!botRunning) return res.json({ success: false, msg: "Already stopped" });
  botRunning = false;
  destroyBot();
  addLog("[Control] Bot stopped");
  res.json({ success: true });
});

app.post("/force-join", (req, res) => {
  botRunning = true;
  clearBotTimeouts();
  isReconnecting = false;
  isWaitingForPlayerClear = false;
  isNightSleep = false;
  delayEndTime = 0;
  botState.wasThrottled = false;
  botState.reconnectAttempts = 0;

  addLog("[Control] Forcing instant join.");
  destroyBot();
  createBot();
  res.json({ success: true, msg: "Force join initiated!" });
});

app.post("/command", (req, res) => {
  const cmd = (req.body.command || "").trim();
  if (!cmd) return res.json({ success: false, msg: "Empty command." });

  if (!bot || !botState.connected) {
    return res.json({ success: false, msg: "Bot is not connected." });
  }

  try {
    bot.chat(cmd);
    addLog(`[Console] Sent: ${cmd}`);
    res.json({ success: true, msg: `Sent: ${cmd}` });
  } catch (err) {
    res.json({ success: false, msg: err.message });
  }
});

const server = app.listen(PORT, "0.0.0.0", () => {
  addLog(`[Server] HTTP server listening on port ${server.address().port}`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    server.listen(PORT + 1, "0.0.0.0");
  }
});

// ============================================================
// SELF-PING SYSTEM (Render 24/7 Keep-Alive Boost)
// ============================================================
const SELF_PING_INTERVAL = 4 * 60 * 1000;

function startSelfPing() {
  setInterval(() => {
    const renderUrl = process.env.RENDER_EXTERNAL_URL;
    const targetUrl = renderUrl ? `${renderUrl}/ping` : `http://127.0.0.1:${PORT}/ping`;
    const protocol = targetUrl.startsWith("https") ? https : http;

    protocol.get(targetUrl, (res) => {
      res.resume(); // Consume stream to avoid memory retention
    }).on("error", (err) => {
      addLog(`[KeepAlive] Ping alert: ${err.message}`);
    });
  }, SELF_PING_INTERVAL);

  addLog("[KeepAlive] Continuous self-ping system initialized (Every 4m).");
}

startSelfPing();

// ============================================================
// MEMORY MONITORING & AUTO GARBAGE COLLECTION
// ============================================================
setInterval(() => {
  const mem = process.memoryUsage();
  const heapMB = (mem.heapUsed / 1024 / 1024).toFixed(2);
  
  if (global.gc && mem.heapUsed > 180 * 1024 * 1024) {
    addLog("[Memory] High heap detected. Triggering Garbage Collection...");
    global.gc();
  }
}, 5 * 60 * 1000);

// ============================================================
// BOT LIFECYCLE CONTROLS
// ============================================================
function clearBotTimeouts() {
  if (reconnectTimeoutId) { clearTimeout(reconnectTimeoutId); reconnectTimeoutId = null; }
  if (connectionTimeoutId) { clearTimeout(connectionTimeoutId); connectionTimeoutId = null; }
  if (watchdogTimeoutId) { clearTimeout(watchdogTimeoutId); watchdogTimeoutId = null; }
}

function clearAllIntervals() {
  activeIntervals.forEach((id) => clearInterval(id));
  activeIntervals = [];
}

function addInterval(callback, delay) {
  const id = setInterval(callback, delay);
  activeIntervals.push(id);
  return id;
}

function destroyBot() {
  clearAllIntervals();
  clearBotTimeouts();

  if (bot) {
    try {
      bot.removeAllListeners();
      if (bot.pathfinder) bot.pathfinder.setGoal(null);
      bot.quit();
    } catch (_) {}
    try { bot.end(); } catch (_) {}
    bot = null;
  }
  botState.connected = false;
}

function getReconnectDelay() {
  if (botState.wasThrottled) {
    botState.wasThrottled = false;
    return 60000 + Math.floor(Math.random() * 30000);
  }
  const baseDelay = config.utils ? config.utils["auto-reconnect-delay"] || 3000 : 3000;
  const maxDelay = config.utils ? config.utils["max-reconnect-delay"] || 30000 : 30000;
  const delay = Math.min(baseDelay * Math.pow(2, botState.reconnectAttempts), maxDelay);
  return delay + Math.floor(Math.random() * 2000);
}

function triggerPlayerAvoidanceDisconnect(reasonMessage) {
  addLog(`[PlayerAvoidance] ${reasonMessage}`);
  isWaitingForPlayerClear = true;
  destroyBot();
  scheduleReconnect();
}

function createBot() {
  if (!botRunning) return;

  if (isReconnecting) {
    addLog("[Bot] Reconnect process already active, skipping duplicate spawn.");
    return;
  }

  destroyBot();

  addLog(`[Bot] Initiating connection to ${config.server.ip}:${config.server.port}...`);

  try {
    const botVersion = config.server.version && config.server.version.trim() !== "" ? config.server.version : false;

    bot = mineflayer.createBot({
      username: config["bot-account"].username,
      password: config["bot-account"].password || undefined,
      auth: config["bot-account"].type,
      host: config.server.ip,
      port: config.server.port,
      version: botVersion,
      hideErrors: false,
      checkTimeoutInterval: 30000,
    });

    bot.loadPlugin(pathfinder);

    connectionTimeoutId = setTimeout(() => {
      if (!botState.connected) {
        addLog("[Bot] Spawn handshake timed out. Recovering...");
        destroyBot();
        scheduleReconnect();
      }
    }, 120000);

    let spawnHandled = false;

    bot.on("resourcePack", (url) => {
      addLog(`[ResourcePack] Offered from ${url}. Accepting...`);
      try { bot.acceptResourcePack(); } catch (err) { addLog(`[ResourcePack] Error: ${err.message}`); }
    });

    bot.once("spawn", () => {
      if (spawnHandled) return;
      spawnHandled = true;

      clearBotTimeouts();
      botState.connected = true;
      botState.lastActivity = Date.now();
      botState.reconnectAttempts = 0;
      isReconnecting = false;

      addLog(`[Bot] [+] Spawned on server successfully! (Version: ${bot.version})`);

      // =========================================
      // SCHEDULED BREAK (8 PM Server Time)
      // =========================================
      const checkNightRoutine = () => {
        if (!bot || !botState.connected) return;
        const now = new Date();
        
        // 20 refers to 20:00 (8 PM Server Time), aligning with 2 AM local time.
        if (now.getHours() === 20) {
          if (lastNightSleepDate && lastNightSleepDate.getDate() === now.getDate()) return;
          lastNightSleepDate = now;
          addLog("[NightSleep] 8 PM trigger reached. Disconnecting for 1.5 hours rest.");
          isNightSleep = true;
          destroyBot();
          scheduleReconnect();
        }
      };

      checkNightRoutine();
      addInterval(checkNightRoutine, 60000);

      // Player Avoidance Guard
      if (config.utils && config.utils["player-avoidance"] && config.utils["player-avoidance"].enabled) {
        setTimeout(() => {
          if (!bot || !botState.connected) return;
          const otherPlayers = Object.keys(bot.players).filter((u) => u !== bot.username);
          if (otherPlayers.length > 0) {
            triggerPlayerAvoidanceDisconnect(`Found ${otherPlayers.length} online player(s): (${otherPlayers.join(", ")})`);
          }
        }, 2000);

        bot.on("playerJoined", (player) => {
          if (!botState.connected || player.username === bot.username) return;
          const leaveDelay = Math.floor(Math.random() * 3000) + 2000;
          addLog(`[PlayerAvoidance] Player '${player.username}' joined. Evacuating in ${leaveDelay / 1000}s...`);
          setTimeout(() => {
            if (botState.connected) {
              triggerPlayerAvoidanceDisconnect(`Player '${player.username}' entered world.`);
            }
          }, leaveDelay);
        });
      }

      const mcData = require("minecraft-data")(bot.version);
      const defaultMove = new Movements(bot, mcData);
      defaultMove.allowFreeMotion = false;
      defaultMove.canDig = false;

      initializeModules(bot, mcData, defaultMove);
    });

    bot.on("kicked", (reason) => {
      const kickReason = typeof reason === "object" ? JSON.stringify(reason) : reason;
      addLog(`[Disconnect - KICKED] Reason: ${kickReason}`);
      if (String(kickReason).toLowerCase().includes("throttl")) botState.wasThrottled = true;
      destroyBot();
      scheduleReconnect();
    });

    bot.on("end", (reason) => {
      addLog(`[Disconnect - END] Connection closed (${reason || "No detail"})`);
      destroyBot();
      scheduleReconnect();
    });

    bot.on("error", (err) => {
      addLog(`[Bot Error] ${err.message}`);
      botState.errors.push({ type: "error", message: err.message, time: Date.now() });
    });

  } catch (err) {
    addLog(`[Bot Setup Error] ${err.message}`);
    destroyBot();
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (!botRunning) return;

  clearBotTimeouts();

  if (isReconnecting) {
    addLog("[Bot] Reconnect cycle already pending.");
    return;
  }

  isReconnecting = true;
  botState.reconnectAttempts++;

  let delay;
  if (isNightSleep) {
    delay = NIGHT_SLEEP_DELAY;
    isNightSleep = false;
    addLog("[NightSleep] Scheduled to reconnect in 1 hour and 30 minutes...");
  } else if (isWaitingForPlayerClear) {
    delay = PLAYER_AVOIDANCE_DELAY;
    isWaitingForPlayerClear = false;
    addLog("[PlayerAvoidance] Reconnecting in 1 hour 20 minutes...");
  } else {
    delay = getReconnectDelay();
    addLog(`[Bot] Reconnecting in ${delay / 1000}s (Attempt #${botState.reconnectAttempts})...`);
  }

  delayEndTime = Date.now() + delay;

  reconnectTimeoutId = setTimeout(() => {
    reconnectTimeoutId = null;
    isReconnecting = false;
    delayEndTime = 0;
    createBot();
  }, delay);

  watchdogTimeoutId = setTimeout(() => {
    if (isReconnecting && !botState.connected) {
      addLog("[Watchdog] Reconnect lock state clear override triggered.");
      isReconnecting = false;
      createBot();
    }
  }, Math.max(delay + 10000, 300000));
}

// ============================================================
// MODULE INITIALIZATION & BEHAVIORS
// ============================================================
function initializeModules(bot, mcData, defaultMove) {
  if (config.utils && config.utils["auto-auth"] && config.utils["auto-auth"].enabled) {
    const password = config.utils["auto-auth"].password;
    let authHandled = false;

    const tryAuth = (type) => {
      if (authHandled || !bot || !botState.connected) return;
      authHandled = true;
      bot.chat(type === "register" ? `/register ${password} ${password}` : `/login ${password}`);
    };

    bot.on("messagestr", (message) => {
      if (authHandled) return;
      const msg = message.toLowerCase();
      if (msg.includes("/register")) tryAuth("register");
      else if (msg.includes("/login")) tryAuth("login");
    });
  }

  if (config.utils && config.utils["anti-afk"] && config.utils["anti-afk"].enabled) {
    addInterval(() => {
      if (!bot || !botState.connected) return;
      try { bot.swingArm(); } catch (_) {}
    }, 20000 + Math.floor(Math.random() * 20000));

    addInterval(() => {
      if (!bot || !botState.connected) return;
      try { bot.setQuickBarSlot(Math.floor(Math.random() * 9)); } catch (_) {}
    }, 40000 + Math.floor(Math.random() * 30000));
  }

  if (config.movement && config.movement["look-around"] && config.movement["look-around"].enabled) {
    addInterval(() => {
      if (!bot || !botState.connected || !bot.entity) return;
      try {
        const yaw = Math.random() * Math.PI * 2 - Math.PI;
        const pitch = (Math.random() * Math.PI) / 2 - Math.PI / 4;
        bot.look(yaw, pitch, false);
      } catch (_) {}
    }, 8000);
  }
}

// ============================================================
// UNCAUGHT CRASH PROTECTION & UNHANDLED REJECTIONS
// ============================================================
process.on("uncaughtException", (err) => {
  const msg = err.message || "Unknown Exception";
  addLog(`[FATAL GUARDIAN] Uncaught Exception: ${msg}`);

  isReconnecting = false;
  destroyBot();

  setTimeout(() => {
    scheduleReconnect();
  }, 5000);
});

process.on("unhandledRejection", (reason) => {
  addLog(`[FATAL GUARDIAN] Unhandled Rejection: ${reason}`);
  if (!isReconnecting && !botState.connected) {
    destroyBot();
    scheduleReconnect();
  }
});

process.on("SIGTERM", () => addLog("[System] SIGTERM caught."));
process.on("SIGINT", () => addLog("[System] SIGINT caught."));

// ============================================================
// INITIAL START
// ============================================================
addLog("==================================================");
addLog("  Minecraft AFK Bot (Render Optimized v3.1)");
addLog("==================================================");

createBot();
