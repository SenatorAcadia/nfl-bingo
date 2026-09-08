/*
 * Filename: test/server.test.js
 * Purpose: Verify temporary rooms and host-only WebSocket authorization end to end.
 * Version: 24.1.0
 */

/* Section 1: Test dependencies
 * Load Node test utilities and the same WebSocket client used by the browser protocol.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const { WebSocket } = require("ws");

/* Section 2: Server lifecycle helpers
 * Run each integration test against isolated temporary SQLite storage.
 */
const PORT = 18765;
let processHandle;

test.before(async () => {
    processHandle = spawn(process.execPath, [path.resolve(__dirname, "../server.js")], {
        env: { ...process.env, PORT: String(PORT) },
        stdio: ["ignore", "pipe", "pipe"]
    });
    await waitForHealth();
});

test.after(async () => {
    if (processHandle && !processHandle.killed) {
        const exited = new Promise(resolve => processHandle.once("exit", resolve));
        processHandle.kill("SIGTERM");
        await exited;
    }
});

function waitForHealth() {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + 5000;
        const attempt = () => {
            http.get(`http://127.0.0.1:${PORT}/health`, response => {
                response.resume();
                if (response.statusCode === 200) resolve();
                else retry();
            }).on("error", retry);
        };
        const retry = () => Date.now() > deadline ? reject(new Error("Server did not become healthy.")) : setTimeout(attempt, 50);
        attempt();
    });
}

function requestJson(method, route, body) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body || {});
        const request = http.request({ hostname: "127.0.0.1", port: PORT, path: route, method, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } }, response => {
            const chunks = [];
            response.on("data", chunk => chunks.push(chunk));
            response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
        });
        request.on("error", reject);
        request.end(payload);
    });
}

function connectSocket(query) {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws?${new URLSearchParams(query)}`);
        socket.once("open", () => resolve(socket));
        socket.once("error", reject);
    });
}

function nextMessage(socket) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for a WebSocket message.")), 2000);
        socket.once("message", raw => {
            clearTimeout(timeout);
            resolve(JSON.parse(raw.toString("utf8")));
        });
    });
}

/* Section 3: Room authorization test
 * Prove that players can join while only the token holder can publish authoritative state.
 */
test("host token protects authoritative room messages", async () => {
    const created = await requestJson("POST", "/api/rooms", { roomCode: "T24A", state: { calls: [] } });
    assert.equal(created.status, 201);
    assert.ok(created.body.hostToken.length >= 32);

    const host = await connectSocket({ room: "T24A", clientId: "phost123", hostToken: created.body.hostToken });
    assert.equal((await nextMessage(host)).type, "STATE");

    const player = await connectSocket({ room: "T24A", clientId: "pplayer1" });
    assert.equal((await nextMessage(player)).type, "STATE");

    const playerError = nextMessage(player);
    player.send(JSON.stringify({ type: "WINNER_DECLARED", name: "CHEAT" }));
    assert.equal((await playerError).code, "MESSAGE_NOT_ALLOWED");

    const playerState = nextMessage(player);
    host.send(JSON.stringify({ type: "STATE", state: { calls: ["TOUCHDOWN"] } }));
    assert.deepEqual((await playerState).state.calls, ["TOUCHDOWN"]);

    host.close();
    player.close();
});
