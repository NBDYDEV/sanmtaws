const http = require("http");
const { WebSocketServer } = require("ws");
const PORT = Number(process.env.PORT || 3001);
const MTA_SERVER_IP = process.env.MTA_SERVER_IP;
const SECRET_TOKEN = process.env.SECRET_TOKEN;
const MTA_TIMEOUT_MS = Number(process.env.MTA_TIMEOUT_MS || 15000);

if (!MTA_SERVER_IP || !SECRET_TOKEN) {
    console.error("❌ Missing required ENV variables.");
    process.exit(1);
}

let onlinePlayers = [];
let lastUpdate = 0;
let mtaServerStatus = "offline";
let statusCheckTimeout = null;

const watchers = new Map();
const clientWatchList = new Map();

let frameCount = 0;
let lastStatTime = Date.now();

function getClientIp(req) {
    const raw =
        req.headers["x-forwarded-for"] ||
        req.socket.remoteAddress ||
        "";
    return raw.split(",")[0].trim().replace("::ffff:", "");
}

function resetStatusTimeout() {
    if (statusCheckTimeout) clearTimeout(statusCheckTimeout);

    mtaServerStatus = "online";

    statusCheckTimeout = setTimeout(() => {
        console.log("[TIMEOUT] MTA server offline.");
        mtaServerStatus = "offline";
        onlinePlayers = [];
        lastUpdate = Date.now();
        watchers.clear();
        clientWatchList.forEach((s) => s.clear());
        broadcastPlayers();
    }, MTA_TIMEOUT_MS);
}

function verifyMta(req) {
    const ip = getClientIp(req);
    if (ip !== MTA_SERVER_IP && ip !== "127.0.0.1") return false;

    return req.headers["authorization"] === `Bearer ${SECRET_TOKEN}`;
}

function readBodyRaw(req, max) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;

        req.on("data", (chunk) => {
            size += chunk.length;
            if (size > max) {
                reject(new Error("Payload too large"));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });

        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}

function jsonRes(res, code, obj) {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
}

function addWatcher(ws, playerName) {
    if (!watchers.has(playerName))
        watchers.set(playerName, { requestedBy: new Set() });

    watchers.get(playerName).requestedBy.add(ws);

    if (!clientWatchList.has(ws))
        clientWatchList.set(ws, new Set());

    clientWatchList.get(ws).add(playerName);
}

function removeWatcher(ws, playerName) {
    const entry = watchers.get(playerName);
    if (entry) {
        entry.requestedBy.delete(ws);
        if (entry.requestedBy.size === 0)
            watchers.delete(playerName);
    }

    const set = clientWatchList.get(ws);
    if (set) set.delete(playerName);
}

function removeAllWatchers(ws) {
    const set = clientWatchList.get(ws);
    if (!set) return;

    for (const name of set) {
        const entry = watchers.get(name);
        if (entry) {
            entry.requestedBy.delete(ws);
            if (entry.requestedBy.size === 0)
                watchers.delete(name);
        }
    }

    set.clear();
}

const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
    }

    const path = req.url?.split("?")[0];

    if (req.method === "GET" && path === "/health") {
        const elapsed = (Date.now() - lastStatTime) / 1000;

        return jsonRes(res, 200, {
            status: "ok",
            mtaServer: mtaServerStatus,
            onlinePlayers: onlinePlayers.length,
            lastUpdate,
            wsClients: wss.clients.size,
            activeWatchers: watchers.size,
            avgFps: elapsed > 0 ? Math.round(frameCount / elapsed) : 0,
        });
    }

    if (req.method === "GET" && path === "/api/players") {
        return jsonRes(res, 200, {
            players: onlinePlayers,
            serverStatus: mtaServerStatus,
            lastUpdate,
            playerCount: onlinePlayers.length,
        });
    }

    if (req.method === "POST" && path === "/api/players") {
        if (!verifyMta(req))
            return jsonRes(res, 403, { error: "Forbidden" });

        try {
            const body = await readBodyRaw(req, 1 * 1024 * 1024);
            const data = JSON.parse(body.toString());

            if (!Array.isArray(data.players))
                return jsonRes(res, 400, { error: "Invalid players array" });

            onlinePlayers = data.players;
            lastUpdate = Date.now();
            resetStatusTimeout();
            broadcastPlayers();

            return jsonRes(res, 200, {
                success: true,
                received: onlinePlayers.length,
            });
        } catch (e) {
            return jsonRes(res, 400, { error: e.message });
        }
    }

    if (req.method === "POST" && path === "/api/frame") {
        if (!verifyMta(req))
            return jsonRes(res, 403, { error: "Forbidden" });

        try {
            const rawBody = await readBodyRaw(req, 5 * 1024 * 1024);
            const data = JSON.parse(rawBody.toString());

            const { p: playerName, d: b64 } = data;

            if (!playerName || !b64)
                return jsonRes(res, 400, { error: "Missing fields" });

            const entry = watchers.get(playerName);

            if (entry?.requestedBy.size > 0) {
                const msg = JSON.stringify({
                    type: "screenshot_data",
                    playerName,
                    imageData: "data:image/jpeg;base64," + b64,
                    timestamp: Date.now(),
                });

                for (const ws of entry.requestedBy) {
                    if (ws.readyState === 1)
                        ws.send(msg);
                }
            }

            frameCount++;
            res.writeHead(200);
            res.end("ok");
        } catch (e) {
            res.writeHead(400);
            res.end(e.message);
        }

        return;
    }

    jsonRes(res, 404, { error: "Not found" });
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
    const ip = getClientIp(req);
    console.log(`[WS] Connected: ${ip} (total: ${wss.clients.size})`);

    clientWatchList.set(ws, new Set());

    ws.send(
        JSON.stringify({
            type: "players_update",
            players: onlinePlayers,
            serverStatus: mtaServerStatus,
            lastUpdate,
            playerCount: onlinePlayers.length,
        })
    );

    ws.on("message", (raw) => {
        try {
            const msg = JSON.parse(raw.toString());

            if (msg.type === "watch_player" && msg.playerName) {
                addWatcher(ws, msg.playerName);
                ws.send(JSON.stringify({
                    type: "watch_confirmed",
                    playerName: msg.playerName,
                    status: "watching",
                }));
            }

            if (msg.type === "unwatch_player" && msg.playerName) {
                removeWatcher(ws, msg.playerName);
                ws.send(JSON.stringify({
                    type: "watch_confirmed",
                    playerName: msg.playerName,
                    status: "stopped",
                }));
            }

            if (msg.type === "unwatch_all") {
                removeAllWatchers(ws);
                ws.send(JSON.stringify({
                    type: "watch_confirmed",
                    playerName: null,
                    status: "all_stopped",
                }));
            }
        } catch (e) {
            console.error("[WS] Parse error:", e.message);
        }
    });

    ws.on("close", () => {
        removeAllWatchers(ws);
        clientWatchList.delete(ws);
        console.log(`[WS] Disconnected (total: ${wss.clients.size})`);
    });
});

function broadcastPlayers() {
    const msg = JSON.stringify({
        type: "players_update",
        players: onlinePlayers,
        serverStatus: mtaServerStatus,
        lastUpdate,
        playerCount: onlinePlayers.length,
    });

    for (const client of wss.clients) {
        if (client.readyState === 1)
            client.send(msg);
    }
}

setInterval(() => {
    for (const client of wss.clients) {
        if (client.readyState === 1)
            client.ping();
    }
}, 30000);

setInterval(() => {
    const onlineNames = new Set(onlinePlayers.map(p => p.name));

    for (const [name, entry] of watchers.entries()) {
        if (!onlineNames.has(name)) {
            for (const ws of entry.requestedBy) {
                if (ws.readyState === 1) {
                    ws.send(JSON.stringify({
                        type: "watch_ended",
                        playerName: name,
                        reason: "player_offline",
                    }));
                }
            }
            watchers.delete(name);
        }
    }
}, 5000);

process.on("SIGTERM", () => {
    console.log("🛑 Shutting down...");
    server.close(() => {
        process.exit(0);
    });
});

server.listen(PORT, "0.0.0.0", () => {
    console.log("==================================================");
    console.log(" SanMTA WS Server v6 – Production Ready");
    console.log(` Port: ${PORT}`);
    console.log("==================================================");
});