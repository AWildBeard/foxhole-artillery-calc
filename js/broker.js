/**
 * Artillery Broker - Client-side WebSocket manager.
 *
 * Features:
 *   - Application-level ping/pong heartbeat (server auto-responds, doesn't
 *     wake the Durable Object) to detect dead connections quickly.
 *   - Automatic reconnect with exponential backoff if the socket drops.
 *   - State is restored on reconnect: re-sends `join` and re-registers the
 *     battery if it was online before the drop.
 *   - Tab-visibility check: when the tab regains focus we validate the
 *     socket and force a reconnect if it has died silently.
 *   - Manual `reconnect()` for a user-triggered restart while preserving
 *     all room + role + battery state.
 */
var broker = (function() {
    var inst = {};

    // Set this to your deployed Cloudflare Worker URL (no trailing slash).
    var WORKER_URL = "wss://arty.byte.farm";

    // --- Connection state ---
    // connectionState: 'connected' | 'reconnecting' | 'disconnected'
    var STATE_CONNECTED    = 'connected';
    var STATE_RECONNECTING = 'reconnecting';
    var STATE_DISCONNECTED = 'disconnected';

    var ws = null;
    var opCode = null;
    var role = null;
    var connectionState = STATE_DISCONNECTED;
    var batteries = [];

    // Battery state that must persist across reconnects.
    var batteryOnline = false;
    var batteryGrid = null;
    var batteryAlt = null;
    var batteryCallsign = null;

    // Timers / reconnect bookkeeping.
    var pingTimer = null;
    var pongTimer = null;
    var reconnectTimer = null;
    var reconnectAttempt = 0;
    var intentionallyClosing = false;

    var PING_INTERVAL_MS = 20000;
    var PONG_TIMEOUT_MS = 8000;
    var MAX_RECONNECT_DELAY_MS = 30000;

    // --- Callbacks ---
    inst.onConnectionChange  = null; // function(state:'connected'|'reconnecting'|'disconnected')
    inst.onBatteriesUpdate   = null; // function(batteries)
    // Initial fire mission delivered TO this artillery client.
    inst.onFireMission              = null; // function({fireMissionUuid, from, distance, direction, targetAltitude})
    // Resend of an existing fire mission delivered TO this artillery client —
    // same stable fireMissionUuid as the original; client updates the existing
    // record in place rather than creating a new one.
    inst.onFireMissionResend        = null; // function({fireMissionUuid, from, distance, direction, targetAltitude})
    // Adjustment delivered TO this artillery client (same stable fireMissionUuid as the initial).
    inst.onFireMissionAdjust        = null; // function({fireMissionUuid, from, distance, direction, targetAltitude, adjustmentNumber})
    // Batch of fresh missions delivered TO this artillery client.
    inst.onFireMissionBatch         = null; // function({from, missions: [{fireMissionUuid, distance, direction, targetAltitude}, ...]})
    // Server confirmed our send was queued for delivery (spotter side).
    inst.onFireMissionAck           = null; // function({fireMissionUuid, clientRef})
    // Server confirmed our batched send was queued for delivery (spotter side).
    inst.onFireMissionBatchAck      = null; // function({clientRef, fireMissionUuids: [...]})
    // Artillery client explicitly receipted the message (spotter side delivery confirmation).
    inst.onFireMissionDelivered     = null; // function({fireMissionUuid})
    inst.onFireMissionBatchDelivered = null; // function({fireMissionUuids: [...]})
    inst.onError                    = null; // function(message, clientRef?)

    inst.isConnected  = function() { return connectionState === STATE_CONNECTED; };
    inst.getRole      = function() { return role; };
    inst.getOpCode    = function() { return opCode; };
    inst.getBatteries = function() { return batteries; };

    function setConnectionState(newState) {
        if (connectionState === newState) return;
        connectionState = newState;
        if (inst.onConnectionChange) {
            try { inst.onConnectionChange(newState); } catch (e) {}
        }
    }

    function clearAllTimers() {
        if (pingTimer)      { clearInterval(pingTimer); pingTimer = null; }
        if (pongTimer)      { clearTimeout(pongTimer);  pongTimer = null; }
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    }

    function startHeartbeat() {
        if (pingTimer) clearInterval(pingTimer);
        pingTimer = setInterval(sendPing, PING_INTERVAL_MS);
    }

    function sendPing() {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        try {
            ws.send(JSON.stringify({ type: "ping" }));
        } catch (e) {
            killSocket();
            return;
        }
        if (pongTimer) clearTimeout(pongTimer);
        pongTimer = setTimeout(function() {
            // No pong within the window: connection is dead.
            killSocket();
        }, PONG_TIMEOUT_MS);
    }

    function killSocket() {
        if (!ws) return;
        // Pong timeout or forced kill — we are actively reconnecting.
        setConnectionState(STATE_RECONNECTING);
        clearAllTimers();
        try { ws.close(); } catch (e) {}
        if (ws.readyState === WebSocket.CLOSED) {
            // Already closed: onclose won't fire again, so schedule ourselves.
            scheduleReconnect();
        }
        // else: onclose will fire and call scheduleReconnect().
    }

    function buildWsUrl(code) {
        return WORKER_URL + "/room/" + encodeURIComponent(code) + "/websocket";
    }

    function connect() {
        if (!opCode || !role) return;
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

        var url = buildWsUrl(opCode);
        try {
            ws = new WebSocket(url);
        } catch (e) {
            if (inst.onError) inst.onError("Failed to open WebSocket");
            setConnectionState(STATE_DISCONNECTED);
            scheduleReconnect();
            return;
        }

        ws.onopen = function() {
            reconnectAttempt = 0;
            setConnectionState(STATE_CONNECTED);
            try {
                ws.send(JSON.stringify({ type: "join", role: role }));
                if (role === "artillery" && batteryOnline && batteryGrid != null) {
                    // Re-register the battery so spotters see it after a
                    // worker restart or transient drop. Callsign is sticky
                    // for the life of the session.
                    ws.send(JSON.stringify({
                        type: "battery_online",
                        grid: batteryGrid,
                        altitude: batteryAlt,
                        callsign: batteryCallsign,
                    }));
                }
            } catch (e) {
                killSocket();
                return;
            }
            startHeartbeat();
        };

        ws.onmessage = function(event) {
            // Any inbound traffic counts as liveness.
            if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }

            var msg;
            try { msg = JSON.parse(event.data); } catch (e) { return; }

            switch (msg.type) {
                case "pong":
                    return;
                case "batteries":
                    batteries = msg.batteries || [];
                    if (inst.onBatteriesUpdate) {
                        try { inst.onBatteriesUpdate(batteries); } catch (e) {}
                    }
                    return;
                case "fire_mission":
                    if (inst.onFireMission) {
                        try { inst.onFireMission(msg); } catch (e) {}
                    }
                    return;
                case "fire_mission_resend":
                    if (inst.onFireMissionResend) {
                        try { inst.onFireMissionResend(msg); } catch (e) {}
                    }
                    return;
                case "fire_mission_adjust":
                    if (inst.onFireMissionAdjust) {
                        try { inst.onFireMissionAdjust(msg); } catch (e) {}
                    }
                    return;
                case "fire_mission_ack":
                    if (inst.onFireMissionAck) {
                        try { inst.onFireMissionAck(msg); } catch (e) {}
                    }
                    return;
                case "fire_mission_delivered":
                    if (inst.onFireMissionDelivered) {
                        try { inst.onFireMissionDelivered(msg); } catch (e) {}
                    }
                    return;
                case "fire_mission_batch":
                    if (inst.onFireMissionBatch) {
                        try { inst.onFireMissionBatch(msg); } catch (e) {}
                    }
                    return;
                case "fire_mission_batch_ack":
                    if (inst.onFireMissionBatchAck) {
                        try { inst.onFireMissionBatchAck(msg); } catch (e) {}
                    }
                    return;
                case "fire_mission_batch_delivered":
                    if (inst.onFireMissionBatchDelivered) {
                        try { inst.onFireMissionBatchDelivered(msg); } catch (e) {}
                    }
                    return;
                case "error":
                    if (inst.onError) {
                        try { inst.onError(msg.message, msg.clientRef || null); } catch (e) {}
                    }
                    return;
            }
        };

        ws.onclose = function() {
            clearAllTimers();
            if (intentionallyClosing) {
                intentionallyClosing = false;
                setConnectionState(STATE_DISCONNECTED);
                return;
            }
            // Any unexpected close means we are actively reconnecting (yellow).
            // This also transitions back from the brief red set by onerror.
            setConnectionState(STATE_RECONNECTING);
            scheduleReconnect();
        };

        ws.onerror = function() {
            // A connection attempt failed — show red until onclose fires and
            // schedules the next attempt (which transitions back to yellow).
            setConnectionState(STATE_DISCONNECTED);
        };
    }

    function scheduleReconnect() {
        if (!opCode || !role) return;
        reconnectAttempt++;
        var base = Math.min(1000 * Math.pow(2, reconnectAttempt - 1), MAX_RECONNECT_DELAY_MS);
        var delay = base + Math.floor(Math.random() * 500);
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, delay);
    }

    inst.join = function(code, selectedRole) {
        intentionallyClosing = true;
        clearAllTimers();
        if (ws) { try { ws.close(); } catch (e) {} ws = null; }

        opCode = code;
        role = selectedRole;
        batteries = [];
        batteryOnline = false;
        batteryGrid = null;
        batteryAlt = null;
        batteryCallsign = null;
        reconnectAttempt = 0;
        intentionallyClosing = false;
        setConnectionState(STATE_RECONNECTING);
        connect();
    };

    inst.leave = function() {
        intentionallyClosing = true;
        clearAllTimers();
        if (ws) { try { ws.close(); } catch (e) {} ws = null; }
        opCode = null;
        role = null;
        batteries = [];
        batteryOnline = false;
        batteryGrid = null;
        batteryAlt = null;
        batteryCallsign = null;
        reconnectAttempt = 0;
        setConnectionState(STATE_DISCONNECTED);
    };

    /**
     * Force-restart the WebSocket connection while preserving room + role +
     * battery state. Use this when the status indicator shows Disconnected
     * and you want to retry immediately without losing entered data.
     */
    inst.reconnect = function() {
        if (!opCode || !role) return;
        intentionallyClosing = true;
        clearAllTimers();
        if (ws) { try { ws.close(); } catch (e) {} ws = null; }
        intentionallyClosing = false;
        reconnectAttempt = 0;
        setConnectionState(STATE_RECONNECTING);
        connect();
    };

    /**
     * Register an artillery battery as online.
     * @param callsign optional display name (<= 18 chars). Once set on the
     *   first call it sticks for the life of the session — subsequent calls
     *   re-use the previously-set callsign for re-registration.
     */
    inst.batteryOnline = function(grid, altitude, callsign) {
        if (role !== "artillery") return;
        batteryOnline = true;
        batteryGrid = grid;
        batteryAlt = Number(altitude);
        if (callsign !== undefined) {
            batteryCallsign = (callsign == null || callsign === "") ? null : String(callsign);
        }
        if (ws && ws.readyState === WebSocket.OPEN) {
            try {
                ws.send(JSON.stringify({
                    type: "battery_online",
                    grid: grid,
                    altitude: batteryAlt,
                    callsign: batteryCallsign,
                }));
            } catch (e) {}
        }
    };

    inst.batteryOffline = function() {
        if (role !== "artillery") return;
        batteryOnline = false;
        batteryGrid = null;
        batteryAlt = null;
        // Note: batteryCallsign is intentionally retained so it survives
        // stand-down -> go-online cycles in the same session.
        if (ws && ws.readyState === WebSocket.OPEN) {
            try { ws.send(JSON.stringify({ type: "battery_offline" })); }
            catch (e) {}
        }
    };

    /**
     * Send a fresh fire mission. Returns true if it was queued for transmission.
     * The worker will reply with fire_mission_ack carrying the assigned UUID
     * and the clientRef passed here so the caller can correlate.
     */
    inst.sendFireMission = function(batteryId, distance, direction, targetAltitude, clientRef) {
        if (!ws || ws.readyState !== WebSocket.OPEN || role !== "spotter") return false;
        try {
            ws.send(JSON.stringify({
                type: "fire_mission",
                batteryId: batteryId,
                distance: Number(distance),
                direction: Number(direction),
                targetAltitude: (targetAltitude == null || isNaN(Number(targetAltitude)))
                    ? null
                    : Number(targetAltitude),
                clientRef: clientRef == null ? null : String(clientRef),
            }));
            return true;
        } catch (e) {
            return false;
        }
    };

    /**
     * Resend an existing fire mission, reusing its UUID. The worker forwards
     * with the same UUID so the artillery client can update its existing
     * record in place (clearing any Outdated state) rather than minting a
     * duplicate card. Returns true if queued for transmission.
     */
    inst.sendFireMissionResend = function(batteryId, fireMissionUuid, distance, direction, targetAltitude, clientRef) {
        if (!ws || ws.readyState !== WebSocket.OPEN || role !== "spotter") return false;
        if (!fireMissionUuid) return false;
        try {
            ws.send(JSON.stringify({
                type: "fire_mission_resend",
                batteryId: batteryId,
                fireMissionUuid: String(fireMissionUuid),
                distance: Number(distance),
                direction: Number(direction),
                targetAltitude: (targetAltitude == null || isNaN(Number(targetAltitude)))
                    ? null
                    : Number(targetAltitude),
                clientRef: clientRef == null ? null : String(clientRef),
            }));
            return true;
        } catch (e) {
            return false;
        }
    };

    /**
     * Send an adjustment for an existing fire mission.
     * fireMissionUuid is the stable UUID assigned at mission creation — it never changes.
     */
    inst.sendFireMissionAdjust = function(batteryId, distance, direction, targetAltitude, fireMissionUuid, clientRef, adjustmentNumber) {
        if (!ws || ws.readyState !== WebSocket.OPEN || role !== "spotter") return false;
        if (!fireMissionUuid) return false;
        try {
            ws.send(JSON.stringify({
                type: "fire_mission_adjust",
                batteryId: batteryId,
                distance: Number(distance),
                direction: Number(direction),
                targetAltitude: (targetAltitude == null || isNaN(Number(targetAltitude)))
                    ? null
                    : Number(targetAltitude),
                fireMissionUuid: String(fireMissionUuid),
                clientRef: clientRef == null ? null : String(clientRef),
                adjustmentNumber: adjustmentNumber == null ? null : Number(adjustmentNumber),
            }));
            return true;
        } catch (e) {
            return false;
        }
    };

    /**
     * Send an application-level delivery receipt for a fire mission (artillery side).
     * The worker forwards this to the originating spotter as fire_mission_delivered.
     */
    inst.sendFireMissionReceipt = function(fireMissionUuid, spotterSessionId) {
        if (!ws || ws.readyState !== WebSocket.OPEN || role !== "artillery") return;
        if (!fireMissionUuid) return;
        try {
            ws.send(JSON.stringify({
                type: "fire_mission_receipt",
                fireMissionUuid: String(fireMissionUuid),
                spotterSessionId: spotterSessionId ? String(spotterSessionId) : null,
            }));
        } catch (e) {}
    };

    /**
     * Send a batch of fresh fire missions to one battery in a single message.
     * `missions` is [{distance, direction, targetAltitude}, ...].
     * The server's ack carries fireMissionUuids in the same order.
     */
    inst.sendFireMissionBatch = function(batteryId, missions, clientRef) {
        if (!ws || ws.readyState !== WebSocket.OPEN || role !== "spotter") return false;
        if (!batteryId) return false;
        if (!Array.isArray(missions) || missions.length === 0) return false;
        try {
            ws.send(JSON.stringify({
                type: "fire_mission_batch",
                batteryId: batteryId,
                clientRef: clientRef == null ? null : String(clientRef),
                missions: missions.map(function(m) {
                    return {
                        distance: Number(m.distance),
                        direction: Number(m.direction),
                        targetAltitude: (m.targetAltitude == null || isNaN(Number(m.targetAltitude)))
                            ? null
                            : Number(m.targetAltitude),
                    };
                }),
            }));
            return true;
        } catch (e) {
            return false;
        }
    };

    /**
     * Artillery-side batch receipt: a single message confirming receipt of every
     * fireMissionUuid in the batch. The worker forwards as fire_mission_batch_delivered.
     */
    inst.sendFireMissionBatchReceipt = function(fireMissionUuids, spotterSessionId) {
        if (!ws || ws.readyState !== WebSocket.OPEN || role !== "artillery") return;
        if (!Array.isArray(fireMissionUuids) || fireMissionUuids.length === 0) return;
        try {
            ws.send(JSON.stringify({
                type: "fire_mission_batch_receipt",
                fireMissionUuids: fireMissionUuids.map(String),
                spotterSessionId: spotterSessionId ? String(spotterSessionId) : null,
            }));
        } catch (e) {}
    };

    // When the tab regains focus, validate the socket. Browsers (especially
    // Chrome's tab freezing) can silently drop sockets without firing onclose,
    // so force a re-check immediately so we never appear "connected" when
    // we're not.
    document.addEventListener("visibilitychange", function() {
        if (document.hidden) return;
        if (!opCode || !role) return;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            if (!reconnectTimer) {
                reconnectAttempt = 0;
                connect();
            }
            return;
        }
        sendPing();
    });

    window.addEventListener("beforeunload", function() {
        intentionallyClosing = true;
        if (ws) { try { ws.close(); } catch (e) {} }
    });

    return inst;
}());