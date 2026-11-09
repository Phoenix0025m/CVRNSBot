
"use strict";

const { addLog } = require("./logger");
const mineflayer = require("mineflayer");
const { pathfinder } = require("mineflayer-pathfinder");
const config = require("./settings.json");
const express = require("express");
const http = require("http");
const https = require("https");

// ============================================================
// BOT STATE
// The bot is idle when the web app starts. A visitor must press
// Join Server to begin one connection attempt.
// ============================================================
const SESSION_LENGTH_MS = 10 * 1000;
const CONNECTION_TIMEOUT_MS = 120 * 1000;

let bot = null;
let connectionTimeoutId = null;
let leaveTimeoutId = null;
let activeAttemptId = 0;

const botState = {
  status: "idle", // idle | starting | started | stopped | failed
  connected: false,
  message: "Click Join Server to connect the bot for 10 seconds.",
  lastActivity: Date.now(),
  joinedAt: null,
  finishedAt: null,
  leaveAt: null,
};

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

        <link rel="stylesheet" media="print"
          onload="this.media='all'"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">

        <style>
          *, *::before, *::after {
            box-sizing: border-box;
          }

          body {
            font-family: 'Inter', -apple-system, sans-serif;
            background: #0d1117;
            color: #e6edf3;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            margin: 0;
            padding: 24px;
          }

          main {
            width: 100%;
            max-width: 400px;
          }

          header {
            margin-bottom: 28px;
          }

          header h1 {
            font-size: 26px;
            font-weight: 700;
            color: #f0f6fc;
            margin: 0;
            line-height: 1.2;
          }

          header p {
            font-size: 14px;
            color: #8b949e;
            margin: 6px 0 0;
            line-height: 1.5;
          }

          .status-section {
            border-radius: 12px;
            padding: 20px 24px;
            margin-bottom: 16px;
            display: flex;
            align-items: center;
            gap: 16px;
            transition: background 0.3s, border-color 0.3s;
          }

          .status-section.online {
            background: #0d2218;
            border: 2px solid #238636;
          }

          .status-section.offline {
            background: #161b22;
            border: 2px solid #30363d;
          }

          .status-section.starting {
            background: #221a0d;
            border: 2px solid #d29922;
          }

          .status-section.failed {
            background: #200d0d;
            border: 2px solid #da3633;
          }

          .status-icon {
            width: 44px;
            height: 44px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 20px;
            font-weight: 700;
            flex-shrink: 0;
            transition: background 0.3s;
          }

          .status-icon.online {
            background: #238636;
            color: #fff;
          }

          .status-icon.offline {
            background: #30363d;
            color: #c9d1d9;
          }

          .status-icon.starting {
            background: #9e6a03;
            color: #fff;
          }

          .status-icon.failed {
            background: #da3633;
            color: #fff;
          }

          .status-label {
            font-size: 18px;
            font-weight: 700;
            line-height: 1.2;
          }

          .status-label.online {
            color: #3fb950;
          }

          .status-label.offline {
            color: #c9d1d9;
          }

          .status-label.starting {
            color: #e3b341;
          }

          .status-label.failed {
            color: #f85149;
          }

          .status-detail {
            font-size: 13px;
            color: #8b949e;
            margin-top: 3px;
            line-height: 1.45;
          }

          dl {
            margin: 0;
          }

          .stat-card {
            background: #161b22;
            border: 1px solid #21262d;
            border-radius: 10px;
            padding: 16px 20px;
            margin-bottom: 10px;
          }

          dt {
            font-size: 12px;
            color: #8b949e;
            font-weight: 600;
            margin-bottom: 4px;
          }

          dd {
            margin: 0;
            font-size: 17px;
            font-weight: 600;
            color: #e6edf3;
            line-height: 1.3;
          }

          .stat-detail {
            margin: 4px 0 0;
            font-size: 11px;
            color: #6e7681;
          }

          .controls {
            margin-top: 8px;
          }

          .btn-grid {
            display: grid;
            gap: 10px;
            margin-bottom: 10px;
          }

          .btn-grid-2 {
            grid-template-columns: 1fr 1fr;
          }

          .btn-primary {
            width: 100%;
            min-height: 52px;
            border-radius: 10px;
            font-size: 15px;
            font-weight: 700;
            cursor: pointer;
            transition: opacity 0.2s, filter 0.2s;
            font-family: inherit;
          }

          .btn-primary:hover:not(:disabled) {
            filter: brightness(1.1);
          }

          .btn-primary:disabled {
            cursor: not-allowed;
            opacity: 0.65;
          }

          .btn-start {
            border: 2px solid #238636;
            background: #0d2218;
            color: #3fb950;
          }

          .btn-secondary {
            min-height: 44px;
            border-radius: 10px;
            border: 1px solid #21262d;
            background: #161b22;
            color: #8b949e;
            font-size: 13px;
            font-weight: 500;
            text-decoration: none;
            display: flex;
            align-items: center;
            justify-content: center;
            font-family: inherit;
            cursor: pointer;
          }

          .btn-secondary:hover {
            background: #21262d;
            color: #c9d1d9;
          }

          footer {
            margin-top: 20px;
            text-align: center;
          }

          footer p {
            font-size: 12px;
            color: #484f58;
            margin: 0;
          }
        </style>
      </head>

      <body>
        <main role="main">

          <header>
            <h1>AFK Bot Dashboard</h1>
            <p>Minecraft server bot &middot; Manual 10-second session</p>
          </header>

          <section id="status-section"
            class="status-section offline"
            aria-live="polite">

            <div id="status-icon"
              class="status-icon offline">○</div>

            <div>
              <div id="status-label"
                class="status-label offline">
                Ready to start
              </div>

              <div id="status-detail"
                class="status-detail">
                Click Join Server to begin.
              </div>
            </div>

          </section>

          <section>
            <dl>

              <div class="stat-card">
                <dt>Server Time (UTC)</dt>
                <dd id="bot-clock">Loading...</dd>
              </div>

              <div class="stat-card">
                <dt>Connected Duration</dt>
                <dd id="uptime-text">0 seconds</dd>
              </div>

              <div class="stat-card">
                <dt>Coordinates</dt>
                <dd id="coords-text">—</dd>
                <p class="stat-detail">
                  Available after the bot spawns in the world
                </p>
              </div>

            </dl>
          </section>

          <section class="controls">

            <div class="btn-grid">
              <button
                id="join-button"
                class="btn-primary btn-start"
                type="button"
                onclick="joinServer()">
                Join Server
              </button>
            </div>

            <div class="btn-grid btn-grid-2">
              <a href="/tutorial" class="btn-secondary">
                Setup guide
              </a>

              <a href="/logs" class="btn-secondary">
                View logs
              </a>
            </div>

          </section>

          <footer>
            <p>Status updates automatically</p>
          </footer>

        </main>

        <script>

          function updateBotTime() {
            const now = new Date();

            document.getElementById('bot-clock').textContent =
              now.toLocaleTimeString('en-US', {
                timeZone: 'UTC',
                hour12: true
              });
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

              const response = await fetch('/health', {
                cache: 'no-store'
              });

              if (!response.ok) {
                throw new Error('Status request failed');
              }

              const data = await response.json();
              const state = data.status || 'idle';

              const views = {

                idle: {
                  className: 'offline',
                  icon: '○',
                  label: 'Ready to start'
                },

                starting: {
                  className: 'starting',
                  icon: '…',
                  label: 'Server starting…'
                },

                started: {
                  className: 'online',
                  icon: '✓',
                  label: 'Server started'
                },

                stopped: {
                  className: 'offline',
                  icon: '○',
                  label: 'Disconnected'
                },

                failed: {
                  className: 'failed',
                  icon: '!',
                  label: 'Join failed'
                }

              };

              const view = views[state] || views.idle;

              document.getElementById('status-section').className =
                'status-section ' + view.className;

              document.getElementById('status-icon').className =
                'status-icon ' + view.className;

              document.getElementById('status-icon').textContent =
                view.icon;

              document.getElementById('status-label').className =
                'status-label ' + view.className;

              document.getElementById('status-label').textContent =
                view.label;


              let detail = data.message || 'Click Join Server to begin.';

              if (state === 'starting') {
                detail =
                  'Server starting… Waiting for the bot to spawn in the world.';
              }

              if (state === 'started') {

                const remaining = Math.max(
                  0,
                  Number(data.remainingSeconds) || 0
                );

                detail =
                  'Bot joined successfully. It will leave in ' +
                  remaining +
                  (remaining === 1 ? ' second.' : ' seconds.');

              }

              document.getElementById('status-detail').textContent =
                detail;


              document.getElementById('uptime-text').textContent =
                formatDuration(data.uptime);


              if (data.coords) {

                document.getElementById('coords-text').textContent =
                  'X ' + Math.floor(data.coords.x) +
                  ', Y ' + Math.floor(data.coords.y) +
                  ', Z ' + Math.floor(data.coords.z);

              } else {

                document.getElementById('coords-text').textContent =
                  state === 'starting' ? 'Waiting for spawn…' : '—';

              }


              const joinButton =
                document.getElementById('join-button');

              const busy =
                state === 'starting' || state === 'started';

              joinButton.disabled = busy;

              joinButton.textContent =
                state === 'starting'
                  ? 'Joining…'
                  : (state === 'started'
                    ? 'Joined'
                    : 'Join Server');

            } catch (error) {

              const section =
                document.getElementById('status-section');

              const icon =
                document.getElementById('status-icon');

              const label =
                document.getElementById('status-label');

              section.className = 'status-section failed';
              icon.className = 'status-icon failed';
              icon.textContent = '!';

              label.className = 'status-label failed';
              label.textContent = 'Dashboard unreachable';

              document.getElementById('status-detail').textContent =
                'Could not retrieve the bot status.';

            }

          }


          async function joinServer() {

            const button =
              document.getElementById('join-button');

            button.disabled = true;
            button.textContent = 'Joining…';

            try {

              const response = await fetch('/join', {
                method: 'POST'
              });

              const data = await response.json();

              if (!response.ok) {

                document.getElementById('status-detail').textContent =
                  data.msg || 'A join attempt is already active.';

              }

            } catch (error) {

              document.getElementById('status-detail').textContent =
                'Could not start the join attempt. Please try again.';

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
// OTHER DASHBOARD ROUTES
// ============================================================

app.get("/tutorial", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <body>
        <h2>Tutorial Page Loaded</h2>
      </body>
    </html>
  `);
});


app.get("/health", (req, res) => {

  const isJoined =
    botState.status === "started" && botState.connected;

  const endTime = botState.finishedAt || Date.now();

  const uptime = botState.joinedAt
    ? Math.max(
        0,
        Math.floor((endTime - botState.joinedAt) / 1000)
      )
    : 0;

  res.set("Cache-Control", "no-store");

  res.json({

    status: botState.status,

    connected: isJoined,

    message: botState.message,

    uptime,

    coords:
      isJoined && bot && bot.entity
        ? bot.entity.position
        : null,

    remainingSeconds:
      isJoined && botState.leaveAt
        ? Math.max(
            0,
            Math.ceil((botState.leaveAt - Date.now()) / 1000)
          )
        : 0,

    canJoin:
      botState.status !== "starting" &&
      botState.status !== "started"

  });

});


app.get("/ping", (req, res) => res.send("pong"));


// Original supplied file contained a placeholder for this route.
app.get("/logs", (req, res) => {

  res.send(`
    Logs route is functioning.
    (Keep your original logs HTML block here)
  `);

});


// ============================================================
// JOIN API
// ============================================================

app.post("/join", (req, res) => {

  if (
    botState.status === "starting" ||
    botState.status === "started"
  ) {

    return res.status(409).json({

      success: false,

      msg: "A join attempt is already active.",

      status: botState.status

    });

  }

  const result = startJoinAttempt();

  if (!result.success) {

    return res.status(500).json({

      success: false,

      msg: result.message,

      status: botState.status

    });

  }

  return res.status(202).json({

    success: true,

    msg: "Join attempt started.",

    status: botState.status

  });

});


// ============================================================
// START EXPRESS SERVER
// ============================================================

const server = app.listen(PORT, "0.0.0.0", () => {

  addLog(
    `[Server] Listening on port ${server.address().port}`
  );

});

server.on("error", (err) => {

  if (err.code === "EADDRINUSE") {

    addLog(
      `[Server] Port ${PORT} is busy; trying ${Number(PORT) + 1}.`
    );

    server.listen(Number(PORT) + 1, "0.0.0.0");

  } else {

    addLog(`[Server Error] ${err.message}`);

  }

});


// ============================================================
// SELF-PING & MEMORY MANAGEMENT
// ============================================================

function startSelfPing() {

  setInterval(() => {

    const targetUrl = process.env.RENDER_EXTERNAL_URL
      ? `${process.env.RENDER_EXTERNAL_URL}/ping`
      : `http://127.0.0.1:${PORT}/ping`;

    const protocol =
      targetUrl.startsWith("https") ? https : http;

    protocol
      .get(targetUrl, (res) => res.resume())
      .on("error", () => {});

  }, 4 * 60 * 1000);

}

startSelfPing();


setInterval(() => {

  if (
    global.gc &&
    process.memoryUsage().heapUsed > 180 * 1024 * 1024
  ) {
    global.gc();
  }

}, 5 * 60 * 1000);


// ============================================================
// BOT LIFECYCLE
// ============================================================

function clearBotTimeouts() {

  if (connectionTimeoutId) {
    clearTimeout(connectionTimeoutId);
  }

  if (leaveTimeoutId) {
    clearTimeout(leaveTimeoutId);
  }

  connectionTimeoutId = null;
  leaveTimeoutId = null;

}


function closeBot(targetBot, reason) {

  if (!targetBot) return;

  // Keep a harmless error listener during shutdown.
  try {
    targetBot.removeAllListeners();
    targetBot.on("error", () => {});
  } catch (_) {}

  try {

    if (typeof targetBot.quit === "function") {
      targetBot.quit(reason);
    } else if (typeof targetBot.end === "function") {
      targetBot.end();
    }

  } catch (_) {

    try {
      if (typeof targetBot.end === "function") {
        targetBot.end();
      }
    } catch (_) {}

  }

}


// Ends the current attempt and invalidates its event handlers before
// disconnecting. This prevents accidental automatic reconnection.

function finishAttempt(
  status,
  message,
  attemptId,
  expectedBot,
  disconnect = true
) {

  if (
    attemptId !== activeAttemptId ||
    !expectedBot ||
    bot !== expectedBot
  ) {
    return;
  }

  clearBotTimeouts();

  bot = null;

  botState.connected = false;
  botState.status = status;
  botState.message = message;
  botState.finishedAt = Date.now();
  botState.leaveAt = null;

  addLog(`[Bot] ${message}`);

  if (disconnect) {

    closeBot(expectedBot, message);

  } else {

    try {
      expectedBot.removeAllListeners();
    } catch (_) {}

  }

}


// ============================================================
// START A SINGLE JOIN ATTEMPT
// ============================================================

function startJoinAttempt() {

  if (
    botState.status === "starting" ||
    botState.status === "started"
  ) {

    return {
      success: false,
      message: "A join attempt is already active."
    };

  }

  clearBotTimeouts();

  const attemptId = ++activeAttemptId;

  botState.status = "starting";
  botState.connected = false;

  botState.message =
    "Server starting… Waiting for the bot to spawn in the world.";

  botState.lastActivity = Date.now();

  botState.joinedAt = null;
  botState.finishedAt = null;
  botState.leaveAt = null;

  addLog(
    `[Control] Join requested from the dashboard (attempt ${attemptId}).`
  );

  const created = createBot(attemptId);

  return created
    ? { success: true }
    : { success: false, message: botState.message };

}


// ============================================================
// CORE MINEFLAYER CONNECTION LOGIC
// ============================================================

function createBot(attemptId) {

  if (
    attemptId !== activeAttemptId ||
    botState.status !== "starting"
  ) {
    return false;
  }

  addLog(
    `[Bot] Initiating connection to ${config.server.ip}:${config.server.port}...`
  );

  try {

    const currentBot = mineflayer.createBot({

      username: config["bot-account"].username,

      password:
        config["bot-account"].password || undefined,

      auth: config["bot-account"].type,

      host: config.server.ip,

      port: config.server.port,

      version:
        config.server.version &&
        config.server.version.trim() !== ""
          ? config.server.version
          : false,

      hideErrors: false,

      checkTimeoutInterval: 30000

    });

    bot = currentBot;

    currentBot.loadPlugin(pathfinder);


    // ----------------------------------------------------------
    // CONNECTION WATCHDOG
    // Login alone does NOT count as successful joining.
    // Wait until spawn or timeout.
    // ----------------------------------------------------------

    connectionTimeoutId = setTimeout(() => {

      if (
        attemptId === activeAttemptId &&
        bot === currentBot &&
        botState.status === "starting"
      ) {

        finishAttempt(

          "failed",

          "The bot did not spawn before the 120-second connection timeout.",

          attemptId,

          currentBot

        );

      }

    }, CONNECTION_TIMEOUT_MS);


    // ----------------------------------------------------------
    // AUTOMATIC SERVER AUTHENTICATION
    // Retains the original /login and /register functionality.
    // ----------------------------------------------------------

    if (
      config.utils &&
      config.utils["auto-auth"] &&
      config.utils["auto-auth"].enabled
    ) {

      const password =
        config.utils["auto-auth"].password;

      currentBot.on("messagestr", (message) => {

        if (
          attemptId !== activeAttemptId ||
          bot !== currentBot
        ) {
          return;
        }

        const msg = String(message).toLowerCase();

        if (msg.includes("/register")) {

          currentBot.chat(
            `/register ${password} ${password}`
          );

        } else if (msg.includes("/login")) {

          currentBot.chat(
            `/login ${password}`
          );

        }

      });

    }


    // ----------------------------------------------------------
    // LOGIN EVENT
    // Network authentication succeeded, but the bot may not
    // have entered the world yet.
    // ----------------------------------------------------------

    currentBot.once("login", () => {

      if (
        attemptId !== activeAttemptId ||
        bot !== currentBot
      ) {
        return;
      }

      addLog(
        "[Bot] Authenticated on the server network; waiting for world spawn confirmation..."
      );

    });


    // ----------------------------------------------------------
    // RESOURCE PACK
    // ----------------------------------------------------------

    currentBot.on("resourcePack", () => {

      if (
        attemptId !== activeAttemptId ||
        bot !== currentBot
      ) {
        return;
      }

      addLog(
        "[ResourcePack] Server requested a custom texture pack. Accepting..."
      );

      try {

        currentBot.acceptResourcePack();

      } catch (err) {

        addLog(
          `[ResourcePack Error] ${err.message}`
        );

      }

    });


    // ----------------------------------------------------------
    // SUCCESS EVENT
    // Actual spawn confirms successful entry into the world.
    // Start the 10-second session only now.
    // ----------------------------------------------------------

    currentBot.once("spawn", () => {

      if (
        attemptId !== activeAttemptId ||
        bot !== currentBot ||
        botState.status !== "starting"
      ) {
        return;
      }

      if (connectionTimeoutId) {
        clearTimeout(connectionTimeoutId);
      }

      connectionTimeoutId = null;

      botState.status = "started";
      botState.connected = true;

      botState.lastActivity = Date.now();
      botState.joinedAt = Date.now();

      botState.finishedAt = null;

      botState.leaveAt =
        Date.now() + SESSION_LENGTH_MS;

      botState.message =
        "Server started. The bot joined successfully.";

      addLog(
        `[Bot] [+] Spawn confirmed. Starting the ${SESSION_LENGTH_MS / 1000}-second session. (Version: ${currentBot.version})`
      );


      // --------------------------------------------------------
      // AUTOMATIC DISCONNECT AFTER 10 SECONDS
      // --------------------------------------------------------

      leaveTimeoutId = setTimeout(() => {

        finishAttempt(

          "stopped",

          "The bot left the server after 10 seconds. Click Join Server to try again.",

          attemptId,

          currentBot

        );

      }, SESSION_LENGTH_MS);

    });


    // ----------------------------------------------------------
    // KICK EVENT
    // ----------------------------------------------------------

    currentBot.on("kicked", (reason) => {

      if (
        attemptId !== activeAttemptId ||
        bot !== currentBot
      ) {
        return;
      }

      let reasonText;

      try {

        reasonText =
          typeof reason === "string"
            ? reason
            : JSON.stringify(reason);

      } catch (_) {

        reasonText = String(reason);

      }

      const hadSpawned =
        botState.status === "started";

      finishAttempt(

        hadSpawned ? "stopped" : "failed",

        hadSpawned
          ? `The server disconnected the bot before the 10-second session ended. Reason: ${reasonText}`
          : `The server rejected the join attempt. Reason: ${reasonText}`,

        attemptId,

        currentBot,

        false

      );

    });


    // ----------------------------------------------------------
    // END EVENT
    // ----------------------------------------------------------

    currentBot.on("end", () => {

      if (
        attemptId !== activeAttemptId ||
        bot !== currentBot
      ) {
        return;
      }

      const hadSpawned =
        botState.status === "started";

      finishAttempt(

        hadSpawned ? "stopped" : "failed",

        hadSpawned
          ? "The connection ended before the 10-second session finished."
          : "The connection closed before the bot spawned in the world.",

        attemptId,

        currentBot,

        false

      );

    });


    // ----------------------------------------------------------
    // ERROR EVENT
    // ----------------------------------------------------------

    currentBot.on("error", (err) => {

      if (
        attemptId !== activeAttemptId ||
        bot !== currentBot
      ) {
        return;
      }

      addLog(
        `[Bot Error] ${err.message}`
      );

      // Continue showing Server starting until the connection
      // ends or the connection timeout is reached.

    });


    return true;

  } catch (err) {

    clearBotTimeouts();

    const failedBot = bot;

    bot = null;

    botState.connected = false;
    botState.status = "failed";

    botState.message =
      `Bot setup failed: ${err.message}`;

    botState.finishedAt = Date.now();
    botState.leaveAt = null;

    addLog(
      `[Bot Setup Error] ${err.message}`
    );

    closeBot(failedBot, "Bot setup failed");

    return false;

  }

}


// ============================================================
// IMPORTANT
// No automatic bot startup.
// No automatic reconnect.
// Every join requires a website button click.
// ============================================================


// ============================================================
// GLOBAL ERROR HANDLING
// ============================================================

process.on("uncaughtException", (err) => {

  addLog(
    `[FATAL] Uncaught Exception: ${err.message}`
  );

  if (bot) {

    finishAttempt(

      "failed",

      "The bot stopped because of an internal error.",

      activeAttemptId,

      bot

    );

  }

});


process.on("unhandledRejection", (err) => {

  addLog(
    `[FATAL] Unhandled Rejection: ${
      err && err.message ? err.message : String(err)
    }`
  );

  if (bot) {

    finishAttempt(

      "failed",

      "The bot stopped because of an internal error.",

      activeAttemptId,

      bot

    );

  }

});
