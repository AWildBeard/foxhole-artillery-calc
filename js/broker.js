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
    var ws = null;
    var opCode = null;
    var role = null;
    var connected = false;
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
    inst.onConnectionChange  = null; // function(connected:boolean)
    inst.onBatteriesUpdate   = null; // function(batteries)
    // Initial fire mission delivered TO this artillery client.
    inst.onFireMission       = null; // function({uuid, from, distance, direction, targetAltitude})
    // Adjustment delivered TO this artillery client (updates a prior mission by previousUuid).
    inst.onFireMissionAdjust = null; // function({uuid, previousUuid, from, distance, direction, targetAltitude, adjustmentNumber})
    // Server confirmed delivery of a send/adjust we made (spotter side).
    inst.onFireMissionAck    = null; // function({uuid, clientRef, previousUuid?})
    inst.onError             = null; // function(message)

    inst.isConnected  = function() { return connected; };
    inst.getRole      = function() { return role; };
    inst.getOpCode    = function() { return opCode; };
    inst.getBatteries = function() { return batteries; };

    function setConnected(state) {
        if (connected === state) return;
        connected = state;
        if (inst.onConnectionChange) {
            try { inst.onConnectionChange(state); } catch (e) {}
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
        try { ws.close(); } catch (e) {}
        if (ws.readyState === WebSocket.CLOSED) {
            // Already closed: onclose won't fire again, so do the work here.
            setConnected(false);
            scheduleReconnect();
        }
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
            scheduleReconnect();
            return;
        }

        ws.onopen = function() {
            reconnectAttempt = 0;
            setConnected(true);
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
                case "error":
                    if (inst.onError) {
                        try { inst.onError(msg.message); } catch (e) {}
                    }
                    return;
            }
        };

        ws.onclose = function() {
            setConnected(false);
            clearAllTimers();
            if (intentionallyClosing) {
                intentionallyClosing = false;
                return;
            }
            scheduleReconnect();
        };

        ws.onerror = function() {
            setConnected(false);
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
        setConnected(false);
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
     * Send an adjustment for an existing, already-delivered fire mission.
     * previousUuid must be the most recently delivered UUID for the mission.
     */
    inst.sendFireMissionAdjust = function(batteryId, distance, direction, targetAltitude, previousUuid, clientRef, adjustmentNumber) {
        if (!ws || ws.readyState !== WebSocket.OPEN || role !== "spotter") return false;
        if (!previousUuid) return false;
        try {
            ws.send(JSON.stringify({
                type: "fire_mission_adjust",
                batteryId: batteryId,
                distance: Number(distance),
                direction: Number(direction),
                targetAltitude: (targetAltitude == null || isNaN(Number(targetAltitude)))
                    ? null
                    : Number(targetAltitude),
                previousUuid: String(previousUuid),
                clientRef: clientRef == null ? null : String(clientRef),
                adjustmentNumber: adjustmentNumber == null ? null : Number(adjustmentNumber),
            }));
            return true;
        } catch (e) {
            return false;
        }
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