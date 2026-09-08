/*
 * Filename: server.js
 * Purpose: Serve NFL BEANO, authenticate room hosts, and relay temporary in-memory game state.
 * Version: 24.1.0
 */

/* Section 1: Runtime dependencies
 * Load Node built-ins and the WebSocket server with no application framework.
 */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { WebSocketServer, WebSocket } = require("ws");
const BeanoRules = require("./js/game-rules.js");

/* Section 2: Configuration and room memory
 * Keep this week's rooms ephemeral so a restart starts clean without a database.
 */
const APP_ROOT = __dirname;
const PORT = Number(process.env.PORT || 8080);
const ROOM_TTL_HOURS = Number(process.env.ROOM_TTL_HOURS || 12);
const MAX_BODY_BYTES = 64 * 1024;
const MAX_MESSAGE_BYTES = 512 * 1024;
const STATIC_TYPES = new Map([
    [".css", "text/css; charset=utf-8"],
    [".html", "text/html; charset=utf-8"],
    [".js", "text/javascript; charset=utf-8"],
    [".json", "application/json; charset=utf-8"],
    [".png", "image/png"],
    [".svg", "image/svg+xml"]
]);

const rooms = new Map();

/* Section 3: HTTP API
 * Create rooms, report health, and serve the versioned static client safely.
 */
const server = http.createServer(async (request, response) => {
    try {
        const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
        if (request.method === "GET" && url.pathname === "/health") {
            return sendJson(response, 200, { status: "ok", version: "24.1.0", rooms: rooms.size });
        }
        if (request.method === "POST" && url.pathname === "/api/rooms") {
            const body = await readJsonBody(request);
            const requestedCode = normalizeRoomCode(body.roomCode);
            if (!requestedCode) return sendJson(response, 400, { error: "Room codes must contain four letters or numbers." });
            if (rooms.has(requestedCode)) return sendJson(response, 409, { error: "That room code is already active. Try again." });

            const hostToken = crypto.randomBytes(32).toString("base64url");
            const now = Date.now();
            rooms.set(requestedCode, { hostTokenHash: hashToken(hostToken), stateJson: JSON.stringify(body.state || {}), createdAt: now, updatedAt: now });
            return sendJson(response, 201, { roomCode: requestedCode, hostToken });
        }
        if (request.method !== "GET" && request.method !== "HEAD") return sendJson(response, 405, { error: "Method not allowed." });
        return serveStatic(url.pathname, request.method === "HEAD", response);
    } catch (error) {
        console.error("HTTP request failed:", error);
        if (!response.headersSent) sendJson(response, error.statusCode || 500, { error: error.publicMessage || "Unexpected server error." });
        else response.end();
    }
});

function normalizeRoomCode(value) {
    const code = String(value || "").trim().toUpperCase();
    return /^[A-Z0-9]{4}$/.test(code) ? code : null;
}

function hashToken(token) {
    return crypto.createHash("sha256").update(String(token)).digest("hex");
}

async function readJsonBody(request) {
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
            const error = new Error("Request body too large.");
            error.statusCode = 413;
            error.publicMessage = error.message;
            throw error;
        }
        chunks.push(chunk);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
        const error = new Error("Invalid JSON body.");
        error.statusCode = 400;
        error.publicMessage = error.message;
        throw error;
    }
}

function sendJson(response, status, body) {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(payload),
        "Cache-Control": "no-store"
    });
    response.end(payload);
}

function serveStatic(requestPath, headOnly, response) {
    const relativePath = requestPath === "/" ? "index.html" : decodeURIComponent(requestPath).replace(/^\/+/, "");
    const filePath = path.resolve(APP_ROOT, relativePath);
    if (!filePath.startsWith(`${APP_ROOT}${path.sep}`)) return sendJson(response, 404, { error: "Not found." });

    let stat;
    try {
        stat = fs.statSync(filePath);
    } catch {
        return sendJson(response, 404, { error: "Not found." });
    }
    if (!stat.isFile()) return sendJson(response, 404, { error: "Not found." });

    response.writeHead(200, {
        "Content-Type": STATIC_TYPES.get(path.extname(filePath).toLowerCase()) || "application/octet-stream",
        "Content-Length": stat.size,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "same-origin",
        "Cache-Control": relativePath === "index.html" ? "no-cache" : "public, max-age=3600"
    });
    if (headOnly) return response.end();
    fs.createReadStream(filePath).pipe(response);
}

/* Section 4: Authenticated WebSocket relay
 * Bind senders to connections and reserve authoritative game messages for the room host.
 */
const socketsByRoom = new Map();
const HOST_MESSAGE_TYPES = new Set(["STATE", "FEED_ITEM", "SCORE_UPDATE", "WINNER_DECLARED", "KICKED"]);
const PLAYER_MESSAGE_TYPES = new Set(["JOIN", "UPDATE", "UPDATE_TEAM"]);
const webSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname !== "/ws") return socket.destroy();

    const roomCode = normalizeRoomCode(url.searchParams.get("room"));
    const clientId = String(url.searchParams.get("clientId") || "");
    const hostToken = String(url.searchParams.get("hostToken") || "");
    const room = roomCode ? rooms.get(roomCode) : null;
    if (!room || !/^p[a-z0-9]{6,32}$/i.test(clientId)) return rejectUpgrade(socket, 404, "Room not found");

    const isHost = hostToken.length > 0 && safeTokenMatch(room.hostTokenHash, hashToken(hostToken));
    webSockets.handleUpgrade(request, socket, head, ws => {
        ws.roomCode = roomCode;
        ws.clientId = clientId;
        ws.isHost = isHost;
        webSockets.emit("connection", ws);
    });
});

function safeTokenMatch(expected, actual) {
    const left = Buffer.from(expected);
    const right = Buffer.from(actual);
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function rejectUpgrade(socket, status, message) {
    socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
}

webSockets.on("connection", socket => {
    if (!socketsByRoom.has(socket.roomCode)) socketsByRoom.set(socket.roomCode, new Set());
    socketsByRoom.get(socket.roomCode).add(socket);

    const room = rooms.get(socket.roomCode);
    if (room?.stateJson) socket.send(JSON.stringify({ type: "STATE", state: JSON.parse(room.stateJson), sender: "server" }));

    socket.on("message", raw => handleSocketMessage(socket, raw));
    socket.on("close", () => {
        const roomSockets = socketsByRoom.get(socket.roomCode);
        if (!roomSockets) return;
        roomSockets.delete(socket);
        if (roomSockets.size === 0) socketsByRoom.delete(socket.roomCode);
    });
});

function handleSocketMessage(socket, raw) {
    let message;
    try {
        message = JSON.parse(raw.toString("utf8"));
    } catch {
        return sendSocketError(socket, "INVALID_JSON");
    }

    const allowed = socket.isHost ? HOST_MESSAGE_TYPES.has(message.type) : PLAYER_MESSAGE_TYPES.has(message.type);
    if (!allowed) return sendSocketError(socket, "MESSAGE_NOT_ALLOWED");

    message.sender = socket.clientId;
    if (message.type === "JOIN") {
        message.name = String(message.name || "").replace(/[^a-z0-9 ]/gi, "").trim().slice(0, 10).toUpperCase();
        message.team = normalizeTeam(message.team);
        if (!message.name) return sendSocketError(socket, "INVALID_PLAYER");
    }
    if (message.type === "UPDATE_TEAM") message.team = normalizeTeam(message.team);
    if (message.type === "UPDATE" && !validatePlayerUpdate(socket, message)) return sendSocketError(socket, "INVALID_PLAYER_UPDATE");
    if (message.type === "STATE") {
        const stateJson = JSON.stringify(message.state || {});
        if (Buffer.byteLength(stateJson) > MAX_MESSAGE_BYTES) return sendSocketError(socket, "STATE_TOO_LARGE");
        const room = rooms.get(socket.roomCode);
        if (!room) return sendSocketError(socket, "ROOM_EXPIRED");
        room.stateJson = stateJson;
        room.updatedAt = Date.now();
    }
    broadcast(socket.roomCode, message);
}

function normalizeTeam(value) {
    const team = String(value || "None").toUpperCase();
    return /^[A-Z0-9]{1,5}$/.test(team) ? team : "NONE";
}

function validatePlayerUpdate(socket, message) {
    const room = rooms.get(socket.roomCode);
    if (!room) return false;

    let state;
    try {
        state = JSON.parse(room.stateJson);
    } catch {
        return false;
    }
    const assigned = state.players?.[socket.clientId];
    const submitted = message.pData;
    if (!assigned || !submitted || !Array.isArray(assigned.cards) || !Array.isArray(submitted.cards)) return false;
    if (assigned.cards.length !== submitted.cards.length) return false;

    for (let index = 0; index < assigned.cards.length; index += 1) {
        const original = assigned.cards[index];
        const changed = submitted.cards[index];
        if (!Array.isArray(original.events) || !Array.isArray(changed.events)) return false;
        const eventsChanged = JSON.stringify(original.events) !== JSON.stringify(changed.events);
        if (eventsChanged && state.calls.length > 0) return false;
        if (eventsChanged && !isValidCard(changed.events, state.mode)) return false;
        if (!Array.isArray(changed.marked) || changed.marked.some(cell => !Number.isInteger(cell) || cell < 0 || cell > 24)) return false;
        if (changed.marked.some(cell => original.events[cell] !== "FREE" && !state.calls.includes(original.events[cell]))) return false;
    }

    message.pData = {
        name: assigned.name,
        team: normalizeTeam(submitted.team || assigned.team),
        cards: submitted.cards
    };
    return true;
}

function isValidCard(events, mode) {
    if (!Array.isArray(events) || events.length !== 25 || new Set(events).size !== 25) return false;
    const allowed = new Set([...BeanoRules.allSquares, "FREE"]);
    if (!events.every(event => allowed.has(event))) return false;
    if (mode === "COVERALL") return !events.includes("FREE");
    return events[12] === "FREE";
}

function sendSocketError(socket, code) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ERROR", code }));
}

function broadcast(roomCode, message) {
    const payload = JSON.stringify(message);
    for (const socket of socketsByRoom.get(roomCode) || []) {
        if (socket.readyState === WebSocket.OPEN) socket.send(payload);
    }
}

/* Section 5: Lifecycle
 * Expire abandoned rooms and shut down storage cleanly.
 */
const cleanupTimer = setInterval(() => {
    const cutoff = Date.now() - ROOM_TTL_HOURS * 60 * 60 * 1000;
    for (const [code, room] of rooms) {
        if (room.updatedAt < cutoff) rooms.delete(code);
    }
}, 60 * 60 * 1000);
cleanupTimer.unref();

server.listen(PORT, "0.0.0.0", () => {
    console.log(`NFL BEANO v24.1.0 listening on port ${PORT}`);
});

function shutdown() {
    clearInterval(cleanupTimer);
    for (const socket of webSockets.clients) socket.terminate();
    webSockets.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
