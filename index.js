"use strict";

const { addLog, getLogs } = require("./logger");
const mineflayer = require("mineflayer");
const { Movements, pathfinder, goals } = require("mineflayer-pathfinder");
const config = require("./settings.json");
const express = require("express");
const http = require("http");
const https = require("https");

// ============================================================
// GLOBAL STATE & LIFECYCLE VARIABLES
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
const NIGHT_SLEEP_DELAY = 1.5 * 60 * 60 * 1000; 

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
        <link rel="stylesheet" media="print" onload="this.media='all'" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
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
          .btn-primary { min-height: 52px; border-radius: 10px; font-size: 15px; font-weight: 700; cursor: pointer; transition: opacity 0.2s, filter 0.2s; font-family: inherit; }
          .btn-primary:hover  { filter: brightness(1.1); }
          .btn-start { border: 2px solid #238636; background: #0d2218; color: #3fb950; }
          .btn-stop  { border: 2px solid #da3633; background: #200d0d; color: #f85149; }
          .btn-force { border: 2px solid #d29922; background: #221a0d; color: #e3b341; }
          .btn-secondary { min-height: 44px; border-radius: 10px; border: 1px solid #21262d; background: #161b22; color: #8b949e; font-size: 13px; font-weight: 500; text-decoration: none; display: flex; align-items: center; justify-content: center; font-family: inherit; cursor: pointer; }
          .btn-secondary:hover { background: #21262d; color: #c9d1d9; }
          .dash-cmd-box { display: flex; gap: 8px; margin-top: 8px; }
          .dash-cmd-input { flex: 1; background: #0d1117; border: 1px solid #30363d; border-radius: 8px; padding: 10px 12px; color: #e6edf3; font-family: inherit; font-size: 13.5px; outline: none; }
          .dash-cmd-input:focus { border-color: #238636; }
          .dash-cmd-btn { background: #0d2218; border: 1px solid #238636; color: #3fb950; font-weight: 600; padding: 0 16px; border-radius: 8px; cursor: pointer; font-family: inherit; }
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
              </div>
              <div class="stat-card">
                <dt>Uptime</dt>
                <dd id="uptime-text">—</dd>
              </div>
              <div class="stat-card">
                <dt>Coordinates</dt>
                <dd id="coords-text">Searching…</dd>
                <p class="stat-detail">Will appear once fully spawned</p>
              </div>
              <div class="stat-card">
                <dt>Send Web Command / Chat</dt>
                <form onsubmit="sendDashCommand(event)">
                  <div class="dash-cmd-box">
                    <input id="dash-cmd-input" class="dash-cmd-input" type="text" placeholder="/login password" autocomplete="off">
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
          <footer><p>Status updates every 5 seconds</p></footer>
        </main>
        <script>
          function updateBotTime() {
            const now = new Date();
            document.getElementById('bot-clock').textContent = now.toLocaleTimeString('en-US', { timeZone: 'UTC', hour12: true });
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
                document.getElementById('coords-text').textContent = 'X ' + Math.floor(data.coords.x) + ', Y ' + Math.floor(data.coords.y) + ', Z ' + Math.floor(data.coords.z);
              } else {
                document.getElementById('coords-text').textContent = online ? 'Awaiting world chunk loading...' : 'Searching…';
              }
            } catch (e) {
              const label = document.getElementById('status-label');
              label.className = 'status-label offline';
              label.textContent = 'Unreachable';
            }
          }

          async function startBot() { await fetch('/start', { method: 'POST' }); update(); }
          async function stopBot() { await fetch('/stop', { method: 'POST' }); update(); }
          async function forceJoin() { await fetch('/force-join', { method: 'POST' }); update(); }

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
              feedback.textContent = data.msg;
              if (data.success) input.value = '';
            } catch (err) {
              feedback.style.color = '#f85149';
              feedback.textContent = 'Failed to reach server.';
            }
          }
          setInterval(update, 5000); update();
        </script>
      </body>
    </html>
  `);
});

app.get("/tutorial", (req, res) => res.send(`<!DOCTYPE html><html><body><h2>Tutorial Page Loaded</h2></body></html>`));

app.get("/health", (req, res) => {
  res.json({
    status: botState.connected ? "connected" : "disconnected",
    uptime: Math.floor((Date.now() - botState.startTime) / 1000),
    coords: bot && bot.entity ? bot.entity.position : null,
    delayEndTime: isReconnecting ? delayEndTime : null,
  });
});

app.get("/ping", (req, res) => res.send("pong"));

// Note: Logs endpoint truncated in this visual example for space, but keep your existing /logs route!
app.get("/logs", (req, res) => {
    // Keep your exact existing /logs HTML code here. I have excluded it to save you scrolling space, 
    // but do not delete your existing logs route block!
    res.send(`Logs route is functioning. (Keep your original logs HTML block here)`);
});

app.post("/start", (req, res) => {
  if (botRunning) return res.json({ success: false, msg: "Already running" });
  botRunning = true; createBot();
  res.json({ success: true });
});

app.post("/stop", (req, res) => {
  if (!botRunning) return res.json({ success: false, msg: "Already stopped" });
  botRunning = false; destroyBot();
  res.json({ success: true });
});

app.post("/force-join", (req, res) => {
  botRunning = true; clearBotTimeouts();
  isReconnecting = false; isWaitingForPlayerClear = false; isNightSleep = false;
  botState.reconnectAttempts = 0; delayEndTime = 0;
  addLog("[Control] Forcing instant join.");
  destroyBot(); createBot();
  res.json({ success: true, msg: "Force join initiated!" });
});

app.post("/command", (req, res) => {
  const cmd = (req.body.command || "").trim();
  if (!cmd) return res.json({ success: false, msg: "Empty command." });
  if (!bot || !botState.connected) return res.json({ success: false, msg: "Bot is not connected to the server yet." });

  try {
    bot.chat(cmd);
    addLog(`[Console] Sent: ${cmd}`);
    res.json({ success: true, msg: `Sent: ${cmd}` });
  } catch (err) {
    res.json({ success: false, msg: err.message });
  }
});

const server = app.listen(PORT, "0.0.0.0", () => addLog(`[Server] Listening on port ${server.address().port}`));
server.on("error", (err) => { if (err.code === "EADDRINUSE") server.listen(PORT + 1, "0.0.0.0"); });

// ============================================================
// SELF-PING & MEMORY MANAGEMENT
// ============================================================
function startSelfPing() {
  setInterval(() => {
    const targetUrl = process.env.RENDER_EXTERNAL_URL ? `${process.env.RENDER_EXTERNAL_URL}/ping` : `http://127.0.0.1:${PORT}/ping`;
    const protocol = targetUrl.startsWith("https") ? https : http;
    protocol.get(targetUrl, (res) => res.resume()).on("error", () => {});
  }, 4 * 60 * 1000);
}
startSelfPing();

setInterval(() => {
  if (global.gc && process.memoryUsage().heapUsed > 180 * 1024 * 1024) global.gc();
}, 5 * 60 * 1000);

// ============================================================
// BOT LIFECYCLE CONTROLS
// ============================================================
function clearBotTimeouts() {
  if (reconnectTimeoutId) clearTimeout(reconnectTimeoutId);
  if (connectionTimeoutId) clearTimeout(connectionTimeoutId);
  if (watchdogTimeoutId) clearTimeout(watchdogTimeoutId);
}

function clearAllIntervals() {
  activeIntervals.forEach((id) => clearInterval(id)); activeIntervals = [];
}

function addInterval(callback, delay) {
  const id = setInterval(callback, delay);
  activeIntervals.push(id); return id;
}

function destroyBot() {
  clearAllIntervals(); clearBotTimeouts();
  if (bot) {
    try { bot.removeAllListeners(); bot.quit(); } catch (_) {}
    try { bot.end(); } catch (_) {}
    bot = null;
  }
  botState.connected = false;
}

function getReconnectDelay() {
  const baseDelay = config.utils ? config.utils["auto-reconnect-delay"] || 3000 : 3000;
  return Math.min(baseDelay * Math.pow(2, botState.reconnectAttempts), 30000) + Math.floor(Math.random() * 2000);
}

// ============================================================
// CORE BOT LOGIC (WITH GHOST FIXES)
// ============================================================
function createBot() {
  if (!botRunning || isReconnecting) return;
  destroyBot();
  addLog(`[Bot] Initiating connection to ${config.server.ip}:${config.server.port}...`);

  try {
    bot = mineflayer.createBot({
      username: config["bot-account"].username,
      password: config["bot-account"].password || undefined,
      auth: config["bot-account"].type,
      host: config.server.ip,
      port: config.server.port,
      version: config.server.version && config.server.version.trim() !== "" ? config.server.version : false,
      hideErrors: false,
      checkTimeoutInterval: 30000,
    });

    bot.loadPlugin(pathfinder);

    // Watchdog: If we can't log in at all within 2 mins, restart.
    connectionTimeoutId = setTimeout(() => {
      if (!botState.connected) {
        addLog("[Bot] Network timeout before login. Recovering...");
        destroyBot(); scheduleReconnect();
      }
    }, 120000);

    // PRE-SPAWN CHAT LISTENER (Vital for breaking out of Auth voids)
    if (config.utils && config.utils["auto-auth"] && config.utils["auto-auth"].enabled) {
      const password = config.utils["auto-auth"].password;
      bot.on("messagestr", (message) => {
        const msg = message.toLowerCase();
        if (msg.includes("/register")) bot.chat(`/register ${password} ${password}`);
        else if (msg.includes("/login")) bot.chat(`/login ${password}`);
      });
    }

    // EVENT: LOGIN (Trigger Dashboard early so you can manually send commands)
    bot.once("login", () => {
      addLog(`[Bot] Successfully authenticated on server network! Waiting for chunks...`);
      botState.connected = true; // Enables dashboard commands
      clearBotTimeouts(); // Prevent watchdog from killing bot if chunks load slowly
    });

    // EVENT: RESOURCE PACK (Force Accept)
    bot.on("resourcePack", (url) => {
      addLog(`[ResourcePack] Server required a custom texture pack. Bypassing...`);
      try {
        bot.acceptResourcePack();
      } catch (err) {
        addLog(`[ResourcePack Error] ${err.message}`);
      }
    });

    // EVENT: SPAWN (Physical entry into the world)
    bot.once("spawn", () => {
      botState.lastActivity = Date.now();
      botState.reconnectAttempts = 0;
      isReconnecting = false;
      addLog(`[Bot] [+] Fully spawned in the physical world! (Version: ${bot.version})`);

      // Night Sleep Handler
      const checkNightRoutine = () => {
        if (!bot || !botState.connected) return;
        const now = new Date();
        if (now.getHours() === 20) {
          if (lastNightSleepDate && lastNightSleepDate.getDate() === now.getDate()) return;
          lastNightSleepDate = now;
          addLog("[NightSleep] 8 PM trigger reached. Disconnecting for 1.5 hours rest.");
          isNightSleep = true; destroyBot(); scheduleReconnect();
        }
      };
      addInterval(checkNightRoutine, 60000);

      // Initialize anti-afk and movement
      if (config.utils && config.utils["anti-afk"] && config.utils["anti-afk"].enabled) {
        addInterval(() => { try { bot.swingArm(); } catch (_) {} }, 25000);
      }
    });

    bot.on("kicked", (reason) => {
      addLog(`[Disconnect - KICKED] Reason: ${typeof reason === "object" ? JSON.stringify(reason) : reason}`);
      destroyBot(); scheduleReconnect();
    });

    bot.on("end", (reason) => {
      addLog(`[Disconnect - END] Connection closed.`);
      destroyBot(); scheduleReconnect();
    });

    bot.on("error", (err) => {
      addLog(`[Bot Error] ${err.message}`);
    });

  } catch (err) {
    addLog(`[Bot Setup Error] ${err.message}`);
    destroyBot(); scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (!botRunning || isReconnecting) return;
  clearBotTimeouts();
  isReconnecting = true; botState.reconnectAttempts++;

  let delay = getReconnectDelay();
  if (isNightSleep) { delay = NIGHT_SLEEP_DELAY; isNightSleep = false; }
  delayEndTime = Date.now() + delay;

  reconnectTimeoutId = setTimeout(() => {
    isReconnecting = false; delayEndTime = 0; createBot();
  }, delay);
}

process.on("uncaughtException", (err) => {
  addLog(`[FATAL] Uncaught Exception: ${err.message}`);
  isReconnecting = false; destroyBot(); setTimeout(scheduleReconnect, 5000);
});
process.on("unhandledRejection", (err) => {
  addLog(`[FATAL] Unhandled Rejection: ${err}`);
  if (!isReconnecting && !botState.connected) { destroyBot(); scheduleReconnect(); }
});

createBot();
