
"use strict";

const { addLog: writeLog } = require("./logger");
const mineflayer = require("mineflayer");
const { pathfinder } = require("mineflayer-pathfinder");
const config = require("./settings.json");
const express = require("express");
const http = require("http");
const https = require("https");

// ============================================================
// SETTINGS
// ============================================================
const SESSION_LENGTH_MS = 10 * 1000;
const CONNECTION_TIMEOUT_MS = 120 * 1000;
const RETRY_DELAY_MS = 5 * 1000;
const MAX_LOG_ENTRIES = 1000;

// ============================================================
// STATE
// ============================================================
let bot = null;
let connectionTimeoutId = null;
let retryTimeoutId = null;
let leaveTimeoutId = null;
let activeAttemptId = 0;
let startRequested = false;
let retryCount = 0;
const logHistory = [];
let logSequence = 0;

const botState = {
  status: "idle", // idle | starting | started
  connected: false,
  message: "Click Start Server to begin.",
  joinedAt: null,
  finishedAt: null,
  leaveAt: null,
  lastSuccessfulDuration: 0,
};

// All bot/server events go to both the existing logger and the live
// Logs for nerds page. The in-memory history is capped to avoid growth.
function addLog(message) {
  const entry = {
    id: ++logSequence,
    time: new Date().toISOString(),
    message: String(message),
  };

  logHistory.push(entry);
  if (logHistory.length > MAX_LOG_ENTRIES) logHistory.shift();

  try {
    writeLog(entry.message);
  } catch (err) {
    console.error("Logger write failed:", err.message);
  }
}

function clearTimeoutIfSet(name) {
  if (name === "connection" && connectionTimeoutId) {
    clearTimeout(connectionTimeoutId);
    connectionTimeoutId = null;
  } else if (name === "retry" && retryTimeoutId) {
    clearTimeout(retryTimeoutId);
    retryTimeoutId = null;
  } else if (name === "leave" && leaveTimeoutId) {
    clearTimeout(leaveTimeoutId);
    leaveTimeoutId = null;
  }
}

function clearBotTimeouts() {
  clearTimeoutIfSet("connection");
  clearTimeoutIfSet("retry");
  clearTimeoutIfSet("leave");
}

// Detach listeners before closing so an intentional disconnect cannot
// trigger the normal failure/retry handlers.
function disconnectBot(targetBot, reason) {
  if (!targetBot) return;

  try {
    targetBot.removeAllListeners();
    targetBot.on("error", () => {});
  } catch (_) {}

  try {
    if (typeof targetBot.quit === "function") {
      targetBot.quit(reason || "Session complete");
    } else if (typeof targetBot.end === "function") {
      targetBot.end();
    }
  } catch (err) {
    addLog(`[Cleanup] Graceful disconnect failed: ${err.message}`);
    try {
      if (typeof targetBot.end === "function") targetBot.end();
    } catch (_) {}
  }
}

// ============================================================
// RETRY CONTROL
// ============================================================
function scheduleRetry(reason, attemptId, expectedBot, disconnect = false) {
  if (!startRequested || attemptId !== activeAttemptId) return;
  if (expectedBot && bot !== expectedBot) return;

  clearTimeoutIfSet("connection");
  clearTimeoutIfSet("leave");

  if (expectedBot && bot === expectedBot) {
    bot = null;
    if (disconnect) disconnectBot(expectedBot, "Retrying connection");
    else {
      try { expectedBot.removeAllListeners(); } catch (_) {}
    }
  }

  botState.status = "starting";
  botState.connected = false;
  botState.leaveAt = null;
  botState.message = "Starting server…";

  retryCount += 1;
  addLog(`[Retry] ${reason}`);
  addLog(`[Retry] Attempt ${retryCount + 1} will begin in ${RETRY_DELAY_MS / 1000} seconds.`);

  clearTimeoutIfSet("retry");
  retryTimeoutId = setTimeout(() => {
    retryTimeoutId = null;
    if (startRequested) beginConnectionAttempt();
  }, RETRY_DELAY_MS);
}

function completeSuccessfulSession(attemptId, expectedBot, reason) {
  if (attemptId !== activeAttemptId || bot !== expectedBot) return;
  if (botState.status !== "started") return;

  clearTimeoutIfSet("connection");
  clearTimeoutIfSet("leave");

  const finishedAt = Date.now();
  botState.lastSuccessfulDuration = botState.joinedAt
    ? Math.max(0, Math.floor((finishedAt - botState.joinedAt) / 1000))
    : 0;
  botState.finishedAt = finishedAt;
  botState.connected = false;
  botState.leaveAt = null;
  botState.message = "Server started. The bot has left.";

  bot = null;
  startRequested = false;

  addLog(`[Session] ${reason}`);
  disconnectBot(expectedBot, "10-second startup visit complete");
}

// ============================================================
// MINEFLAYER CONNECTION ATTEMPT
// ============================================================
function beginConnectionAttempt() {
  if (!startRequested || botState.status === "started" && botState.connected) return;

  clearTimeoutIfSet("retry");
  clearTimeoutIfSet("connection");

  const attemptId = ++activeAttemptId;
  addLog(`[Bot] Starting connection attempt #${retryCount + 1} to ${config.server.ip}:${config.server.port}.`);

  let currentBot = null;

  try {
    currentBot = mineflayer.createBot({
      username: config["bot-account"].username,
      password: config["bot-account"].password || undefined,
      auth: config["bot-account"].type,
      host: config.server.ip,
      port: config.server.port,
      version:
        config.server.version && config.server.version.trim() !== ""
          ? config.server.version
          : false,
      hideErrors: false,
      checkTimeoutInterval: 30000,
    });

    bot = currentBot;
    currentBot.loadPlugin(pathfinder);

    // A connection attempt that never reaches spawn is retried.
    connectionTimeoutId = setTimeout(() => {
      if (
        startRequested &&
        attemptId === activeAttemptId &&
        bot === currentBot &&
        botState.status === "starting"
      ) {
        scheduleRetry(
          `Connection attempt #${retryCount + 1} timed out before world spawn.`,
          attemptId,
          currentBot,
          true
        );
      }
    }, CONNECTION_TIMEOUT_MS);

    // Record server messages for Logs for nerds and preserve the
    // original automatic /register and /login support.
    const autoAuthEnabled = Boolean(
      config.utils &&
      config.utils["auto-auth"] &&
      config.utils["auto-auth"].enabled
    );
    const authPassword = autoAuthEnabled
      ? config.utils["auto-auth"].password
      : null;

    currentBot.on("messagestr", (message) => {
      if (attemptId !== activeAttemptId || bot !== currentBot) return;

      const serverMessage = String(message);
      addLog(`[Server Message] ${serverMessage}`);

      if (!autoAuthEnabled) return;

      const msg = serverMessage.toLowerCase();
      if (msg.includes("/register")) {
        addLog("[Auth] Registration prompt detected; sending configured registration command.");
        currentBot.chat(`/register ${authPassword} ${authPassword}`);
      } else if (msg.includes("/login")) {
        addLog("[Auth] Login prompt detected; sending configured login command.");
        currentBot.chat(`/login ${authPassword}`);
      }
    });

    currentBot.on("connect", () => {
      if (attemptId !== activeAttemptId || bot !== currentBot) return;
      addLog("[Network] Minecraft socket connected; waiting for server login response.");
    });

    currentBot.once("login", () => {
      if (attemptId !== activeAttemptId || bot !== currentBot) return;
      addLog("[Bot] Network login accepted. Waiting for the actual world-spawn event.");
    });

    currentBot.on("resourcePack", () => {
      if (attemptId !== activeAttemptId || bot !== currentBot) return;
      addLog("[ResourcePack] Server requested a resource pack; accepting it.");
      try {
        currentBot.acceptResourcePack();
      } catch (err) {
        addLog(`[ResourcePack] Accept failed: ${err.message}`);
      }
    });

    // Spawn is the success condition. The ten-second timer starts here,
    // not when TCP connects or the login event fires.
    currentBot.once("spawn", () => {
      if (
        attemptId !== activeAttemptId ||
        bot !== currentBot ||
        !startRequested ||
        botState.status !== "starting"
      ) return;

      clearTimeoutIfSet("connection");
      retryCount = 0;

      botState.status = "started";
      botState.connected = true;
      botState.joinedAt = Date.now();
      botState.finishedAt = null;
      botState.leaveAt = Date.now() + SESSION_LENGTH_MS;
      botState.message = "Server started. The bot joined successfully.";

      addLog(`[Bot] SUCCESS: world spawn confirmed (Minecraft ${currentBot.version || "version unknown"}).`);
      addLog(`[Session] The bot will leave in ${SESSION_LENGTH_MS / 1000} seconds.`);

      leaveTimeoutId = setTimeout(() => {
        completeSuccessfulSession(
          attemptId,
          currentBot,
          "Bot left normally after the 10-second session. Server startup was confirmed."
        );
      }, SESSION_LENGTH_MS);
    });

    currentBot.on("kicked", (reason) => {
      if (attemptId !== activeAttemptId || bot !== currentBot) return;

      let reasonText;
      try {
        reasonText = typeof reason === "string" ? reason : JSON.stringify(reason);
      } catch (_) {
        reasonText = String(reason);
      }

      if (botState.status === "started") {
        completeSuccessfulSession(
          attemptId,
          currentBot,
          `The server disconnected the bot after spawn (before its timer ended). Reason: ${reasonText}`
        );
      } else {
        scheduleRetry(
          `Server rejected/disconnected attempt #${retryCount + 1}: ${reasonText}`,
          attemptId,
          currentBot,
          false
        );
      }
    });

    currentBot.on("end", (reason) => {
      if (attemptId !== activeAttemptId || bot !== currentBot) return;

      if (botState.status === "started") {
        completeSuccessfulSession(
          attemptId,
          currentBot,
          `Connection ended after successful spawn, before the timer finished. ${reason ? `Details: ${reason}` : ""}`
        );
      } else {
        scheduleRetry(
          `Connection attempt #${retryCount + 1} ended before spawn${reason ? `: ${reason}` : "."}`,
          attemptId,
          currentBot,
          false
        );
      }
    });

    currentBot.on("error", (err) => {
      if (attemptId !== activeAttemptId || bot !== currentBot) return;
      // An error is diagnostic information. Mineflayer generally emits
      // end/kicked too; otherwise the connection watchdog triggers retry.
      addLog(`[Bot Error] ${err.message}`);
    });
  } catch (err) {
    addLog(`[Bot Setup Error] ${err.message}`);
    if (currentBot && bot === currentBot) {
      bot = null;
      disconnectBot(currentBot, "Connection setup failed");
    }
    scheduleRetry(`Could not create the Mineflayer connection: ${err.message}`, attemptId, null, false);
  }
}

function startServerRequest() {
  if (startRequested) {
    return { success: true, alreadyActive: true };
  }

  clearBotTimeouts();
  startRequested = true;
  retryCount = 0;
  botState.status = "starting";
  botState.connected = false;
  botState.message = "Starting server…";
  botState.joinedAt = null;
  botState.finishedAt = null;
  botState.leaveAt = null;

  addLog("[Dashboard] Start Server button clicked. Beginning repeated join attempts until world spawn is confirmed.");
  beginConnectionAttempt();

  return { success: true, alreadyActive: false };
}

// ============================================================
// EXPRESS SERVER & DASHBOARD
// ============================================================
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 5000;

app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <title>${config.name || "Minecraft"} Dashboard</title>
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
          .status-section { border-radius: 12px; padding: 20px 24px; margin-bottom: 16px; display: flex; align-items: center; gap: 16px; transition: background .3s, border-color .3s; }
          .status-section.online { background: #0d2218; border: 2px solid #238636; }
          .status-section.offline { background: #161b22; border: 2px solid #30363d; }
          .status-section.starting { background: #221a0d; border: 2px solid #d29922; }
          .status-icon { width: 44px; height: 44px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 20px; font-weight: 700; flex-shrink: 0; }
          .status-icon.online { background: #238636; color: #fff; }
          .status-icon.offline { background: #30363d; color: #c9d1d9; }
          .status-icon.starting { background: #9e6a03; color: #fff; }
          .status-label { font-size: 18px; font-weight: 700; line-height: 1.2; }
          .status-label.online { color: #3fb950; }
          .status-label.offline { color: #c9d1d9; }
          .status-label.starting { color: #e3b341; }
          .status-detail { font-size: 13px; color: #8b949e; margin-top: 3px; line-height: 1.45; }
          dl { margin: 0; }
          .stat-card { background: #161b22; border: 1px solid #21262d; border-radius: 10px; padding: 16px 20px; margin-bottom: 10px; }
          dt { font-size: 12px; color: #8b949e; font-weight: 600; margin-bottom: 4px; }
          dd { margin: 0; font-size: 17px; font-weight: 600; color: #e6edf3; line-height: 1.3; }
          .stat-detail { margin: 4px 0 0; font-size: 11px; color: #6e7681; }
          .controls { margin-top: 8px; }
          .btn-grid { display: grid; gap: 10px; margin-bottom: 10px; }
          .btn-grid-2 { grid-template-columns: 1fr 1fr; }
          .btn-primary { width: 100%; min-height: 52px; border-radius: 10px; font-size: 15px; font-weight: 700; cursor: pointer; transition: opacity .2s, filter .2s; font-family: inherit; }
          .btn-primary:hover:not(:disabled) { filter: brightness(1.1); }
          .btn-primary:disabled { cursor: not-allowed; opacity: .65; }
          .btn-start { border: 2px solid #238636; background: #0d2218; color: #3fb950; }
          .btn-secondary { min-height: 44px; border-radius: 10px; border: 1px solid #21262d; background: #161b22; color: #8b949e; font-size: 13px; font-weight: 500; text-decoration: none; display: flex; align-items: center; justify-content: center; font-family: inherit; cursor: pointer; }
          .btn-secondary:hover { background: #21262d; color: #c9d1d9; }
          footer { margin-top: 20px; text-align: center; }
          footer p { font-size: 12px; color: #484f58; margin: 0; }
        </style>
      </head>
      <body>
        <main role="main">
          <header>
            <h1>AFK Bot Dashboard</h1>
            <p>Minecraft server bot &middot; On-demand startup</p>
          </header>

          <section id="status-section" class="status-section offline" aria-live="polite">
            <div id="status-icon" class="status-icon offline">○</div>
            <div>
              <div id="status-label" class="status-label offline">Ready to start</div>
              <div id="status-detail" class="status-detail">Click Start Server to wake the server.</div>
            </div>
          </section>

          <section>
            <dl>
              <div class="stat-card">
                <dt>Server Time (UTC)</dt>
                <dd id="bot-clock">Loading...</dd>
              </div>
              <div class="stat-card">
                <dt>Bot Session</dt>
                <dd id="uptime-text">Not connected</dd>
              </div>
              <div class="stat-card">
                <dt>Coordinates</dt>
                <dd id="coords-text">—</dd>
                <p class="stat-detail">Available after the bot spawns in the world</p>
              </div>
            </dl>
          </section>

          <section class="controls">
            <div class="btn-grid">
              <button id="start-button" class="btn-primary btn-start" type="button" onclick="startServer()">
                Start Server
              </button>
            </div>
            <div class="btn-grid btn-grid-2">
              <a href="/tutorial" class="btn-secondary">Setup guide</a>
              <a href="/logs" class="btn-secondary">Logs for nerds</a>
            </div>
          </section>

          <footer><p>Status updates automatically</p></footer>
        </main>

        <script>
          function updateBotTime() {
            document.getElementById('bot-clock').textContent =
              new Date().toLocaleTimeString('en-US', { timeZone: 'UTC', hour12: true });
          }
          setInterval(updateBotTime, 1000);
          updateBotTime();

          function formatDuration(seconds) {
            const s = Math.max(0, Number(seconds) || 0);
            const h = Math.floor(s / 3600);
            const m = Math.floor((s % 3600) / 60);
            const sec = s % 60;
            if (h > 0) return h + 'h ' + m + 'm ' + sec + 's';
            if (m > 0) return m + 'm ' + sec + 's';
            return sec + ' seconds';
          }

          async function update() {
            try {
              const response = await fetch('/health', { cache: 'no-store' });
              if (!response.ok) throw new Error('Status unavailable');
              const data = await response.json();
              const state = data.status || 'idle';

              const view = state === 'starting'
                ? { cls: 'starting', icon: '…', label: 'Starting server…' }
                : state === 'started'
                  ? { cls: 'online', icon: '✓', label: 'Server started' }
                  : { cls: 'offline', icon: '○', label: 'Ready to start' };

              document.getElementById('status-section').className = 'status-section ' + view.cls;
              document.getElementById('status-icon').className = 'status-icon ' + view.cls;
              document.getElementById('status-icon').textContent = view.icon;
              document.getElementById('status-label').className = 'status-label ' + view.cls;
              document.getElementById('status-label').textContent = view.label;

              let detail = 'Click Start Server to wake the server.';
              if (state === 'starting') {
                detail = 'Waking the server. Connection attempts will continue automatically.';
              } else if (state === 'started' && data.connected) {
                detail = 'Bot joined successfully. Leaving in ' + data.remainingSeconds + ' seconds.';
              } else if (state === 'started') {
                detail = 'Startup confirmed. The bot has left the server.';
              }
              document.getElementById('status-detail').textContent = detail;

              document.getElementById('uptime-text').textContent = data.joinedAt
                ? formatDuration(data.uptime)
                : (state === 'starting' ? 'Waiting for server…' : 'Not connected');

              document.getElementById('coords-text').textContent = data.coords
                ? 'X ' + Math.floor(data.coords.x) + ', Y ' + Math.floor(data.coords.y) + ', Z ' + Math.floor(data.coords.z)
                : '—';

              const button = document.getElementById('start-button');
              button.disabled = Boolean(data.active);
              button.textContent = data.active
                ? (data.connected ? 'Server Started' : 'Starting…')
                : 'Start Server';
            } catch (_) {
              // Keep the public-facing page calm; diagnostic details belong
              // on Logs for nerds and in the server-side logger.
              document.getElementById('status-label').textContent = 'Starting server…';
              document.getElementById('status-detail').textContent = 'Checking server status…';
            }
          }

          async function startServer() {
            const button = document.getElementById('start-button');
            button.disabled = true;
            button.textContent = 'Starting…';
            try {
              await fetch('/start-server', { method: 'POST' });
            } catch (_) {
              // The next status poll will recover when the dashboard responds.
            }
            await update();
          }

          setInterval(update, 1000);
          update();
        </script>
      </body>
    </html>
  `);
});

// ============================================================
// STATUS AND LOGS ROUTES
// ============================================================
app.get("/health", (req, res) => {
  const now = Date.now();
  const endTime = botState.connected ? now : (botState.finishedAt || now);
  const uptime = botState.joinedAt
    ? Math.max(0, Math.floor((endTime - botState.joinedAt) / 1000))
    : 0;

  res.set("Cache-Control", "no-store");
  res.json({
    status: botState.status,
    connected: botState.connected,
    active: startRequested,
    message: botState.message,
    uptime,
    joinedAt: botState.joinedAt,
    coords: botState.connected && bot && bot.entity ? bot.entity.position : null,
    remainingSeconds: botState.connected && botState.leaveAt
      ? Math.max(0, Math.ceil((botState.leaveAt - now) / 1000))
      : 0,
    attempts: retryCount + (startRequested ? 1 : 0),
  });
});

app.get("/api/logs", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ logs: logHistory });
});

app.get("/logs", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Logs for nerds</title>
        <style>
          * { box-sizing: border-box; }
          body { margin: 0; padding: 20px; background: #0d1117; color: #e6edf3; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
          main { max-width: 1100px; margin: 0 auto; }
          header { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
          h1 { margin: 0; font: 700 22px system-ui, sans-serif; }
          .sub { color: #8b949e; font: 13px system-ui, sans-serif; margin-top: 6px; }
          a, button { border: 1px solid #30363d; background: #161b22; color: #c9d1d9; border-radius: 8px; padding: 9px 12px; text-decoration: none; cursor: pointer; }
          #logbox { background: #010409; border: 1px solid #30363d; border-radius: 10px; padding: 14px; height: calc(100vh - 125px); min-height: 300px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; line-height: 1.6; }
          .entry { padding: 2px 0; border-bottom: 1px solid #161b22; }
          .time { color: #8b949e; }
          .message { color: #c9d1d9; }
          .empty { color: #6e7681; }
        </style>
      </head>
      <body>
        <main>
          <header>
            <div>
              <h1>Logs for nerds</h1>
              <div class="sub">Live connection attempts, server responses, retries and bot events. Refreshes automatically.</div>
            </div>
            <div>
              <button id="pause" type="button">Pause updates</button>
              <a href="/">Dashboard</a>
            </div>
          </header>
          <div id="logbox" aria-live="polite"><div class="empty">Waiting for log events…</div></div>
        </main>
        <script>
          const logbox = document.getElementById('logbox');
          const pauseButton = document.getElementById('pause');
          let paused = false;
          let lastLogId = 0;
          pauseButton.addEventListener('click', () => {
            paused = !paused;
            pauseButton.textContent = paused ? 'Resume updates' : 'Pause updates';
            if (!paused) refreshLogs();
          });
          async function refreshLogs() {
            if (paused) return;
            try {
              const response = await fetch('/api/logs', { cache: 'no-store' });
              if (!response.ok) return;
              const data = await response.json();
              const logs = Array.isArray(data.logs) ? data.logs : [];
              const newestId = logs.length ? logs[logs.length - 1].id : 0;
              if (newestId === lastLogId) return;
              const stickToBottom = logbox.scrollHeight - logbox.scrollTop - logbox.clientHeight < 40;
              logbox.replaceChildren();
              for (const item of logs) {
                const row = document.createElement('div');
                row.className = 'entry';
                const time = document.createElement('span');
                time.className = 'time';
                time.textContent = '[' + new Date(item.time).toLocaleTimeString() + '] ';
                const message = document.createElement('span');
                message.className = 'message';
                message.textContent = item.message;
                row.append(time, message);
                logbox.appendChild(row);
              }
              if (!logs.length) {
                const empty = document.createElement('div');
                empty.className = 'empty';
                empty.textContent = 'No log events yet. Click Start Server on the dashboard.';
                logbox.appendChild(empty);
              }
              lastLogId = newestId;
              if (stickToBottom) logbox.scrollTop = logbox.scrollHeight;
            } catch (_) {}
          }
          refreshLogs();
          setInterval(refreshLogs, 1000);
        </script>
      </body>
    </html>
  `);
});

app.get("/tutorial", (req, res) => {
  res.send(`<!DOCTYPE html><html><body><h2>Tutorial Page Loaded</h2></body></html>`);
});

app.get("/ping", (req, res) => res.send("pong"));

// A click starts the retry loop. Repeated clicks while it is active
// do not create duplicate Mineflayer clients.
app.post("/start-server", (req, res) => {
  if (startRequested) {
    return res.status(202).json({ success: true, alreadyActive: true });
  }
  const result = startServerRequest();
  return res.status(202).json(result);
});

// ============================================================
// HTTP SERVER
// ============================================================
const server = app.listen(PORT, "0.0.0.0", () => {
  addLog(`[Server] Web dashboard listening on port ${server.address().port}.`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    const fallbackPort = Number(PORT) + 1;
    addLog(`[Server] Port ${PORT} is busy; trying port ${fallbackPort}.`);
    server.listen(fallbackPort, "0.0.0.0");
  } else {
    addLog(`[Server Error] ${err.message}`);
  }
});

// ============================================================
// RENDER KEEP-ALIVE (PRESERVED)
// ============================================================
function startSelfPing() {
  setInterval(() => {
    const targetUrl = process.env.RENDER_EXTERNAL_URL
      ? `${process.env.RENDER_EXTERNAL_URL}/ping`
      : `http://127.0.0.1:${PORT}/ping`;
    const protocol = targetUrl.startsWith("https") ? https : http;
    protocol.get(targetUrl, (res) => res.resume()).on("error", () => {});
  }, 4 * 60 * 1000);
}
startSelfPing();

// Preserve the original optional memory cleanup.
setInterval(() => {
  if (global.gc && process.memoryUsage().heapUsed > 180 * 1024 * 1024) {
    global.gc();
  }
}, 5 * 60 * 1000);

// IMPORTANT: no bot is created at application startup. A visitor must
// click Start Server. Once clicked, retries continue until spawn succeeds.
addLog("[Bot] Idle. Waiting for a visitor to click Start Server.");

process.on("uncaughtException", (err) => {
  addLog(`[FATAL] Uncaught exception: ${err.message}`);
  if (startRequested && bot) {
    const currentBot = bot;
    if (botState.status === "started") {
      completeSuccessfulSession(
        activeAttemptId,
        currentBot,
        `Runtime exception after confirmed spawn: ${err.message}`
      );
    } else {
      scheduleRetry(`Uncaught exception: ${err.message}`, activeAttemptId, currentBot, true);
    }
  }
});

process.on("unhandledRejection", (reason) => {
  const message = reason && reason.message ? reason.message : String(reason);
  addLog(`[FATAL] Unhandled rejection: ${message}`);
  if (startRequested && bot) {
    const currentBot = bot;
    if (botState.status === "started") {
      completeSuccessfulSession(
        activeAttemptId,
        currentBot,
        `Runtime rejection after confirmed spawn: ${message}`
      );
    } else {
      scheduleRetry(`Unhandled rejection: ${message}`, activeAttemptId, currentBot, true);
    }
  }
});
