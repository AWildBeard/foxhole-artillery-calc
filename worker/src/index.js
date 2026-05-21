/**
 * Artillery Broker - Cloudflare Worker with Durable Objects
 *
 * Uses the WebSocket Hibernation API so connections survive Durable Object
 * eviction. The DO can hibernate while idle and resume on the next message
 * without disconnecting clients. An auto-response is configured for
 * application-level ping/pong so heartbeats don't wake the DO.
 *
 * Protocol messages (JSON):
 *   Client -> Server:
 *     { type: "join", role: "artillery" | "spotter" }
 *     { type: "battery_online", grid: "1234567890", altitude: 123, callsign?: "Bravo-6" }
 *     { type: "battery_offline" }
 *     { type: "fire_mission", batteryId, distance, direction, targetAltitude, clientRef }
 *     { type: "fire_mission_adjust", batteryId, distance, direction, targetAltitude,
 *                                    fireMissionUuid, clientRef, adjustmentNumber }
 *     { type: "fire_mission_receipt", fireMissionUuid, spotterSessionId }
 *     { type: "ping" }                       // auto-responded with "pong"
 *
 *   Server -> Client:
 *     { type: "batteries", batteries: [ { id, grid, altitude, callsign } ] }
 *     // Sent to artillery — fireMissionUuid is stable for the life of this mission.
 *     { type: "fire_mission", fireMissionUuid, from, distance, direction, targetAltitude }
 *     // Sent to artillery — same stable fireMissionUuid, no UUID rotation.
 *     { type: "fire_mission_adjust", fireMissionUuid, from, distance, direction,
 *                                    targetAltitude, adjustmentNumber }
 *     // Sent to spotter after the message has been queued for delivery to artillery.
 *     // clientRef is the spotter's local correlation id from the original send.
 *     { type: "fire_mission_ack", fireMissionUuid, clientRef }
 *     // Sent to spotter when artillery explicitly receipts the fire mission.
 *     { type: "fire_mission_delivered", fireMissionUuid }
 *     { type: "pong" }                       // auto-response
 *     { type: "error", message: "...", clientRef? }
 *
 * Per-WebSocket state is stored via ws.serializeAttachment so it survives
 * hibernation. Live WebSockets are enumerated via state.getWebSockets().
 */

// RFC 4122 UUID format check. crypto.randomUUID() always produces v4 UUIDs,
// but we accept any v1-v5 variant for forward-compat.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isUuid(s) {
  return typeof s === "string" && UUID_RE.test(s);
}

export class ArtilleryRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;

    // Auto-respond to application-level ping without waking the DO.
    // Clients use this to detect dead connections quickly.
    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(
        JSON.stringify({ type: "ping" }),
        JSON.stringify({ type: "pong" })
      )
    );
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/websocket") {
      return new Response("Not found", { status: 404 });
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Hibernation API: lets the DO sleep while WebSockets stay open.
    this.state.acceptWebSocket(server);

    // Per-WS state that survives hibernation.
    server.serializeAttachment({
      id: crypto.randomUUID(),
      role: null,
      grid: null,
      altitude: null,
      callsign: null,
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  // ----- Hibernation event handlers -----

  webSocketMessage(ws, message) {
    let msg;
    try {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      msg = JSON.parse(text);
    } catch (e) {
      this.send(ws, { type: "error", message: "Invalid message format" });
      return;
    }
    this.handleMessage(ws, msg);
  }

  webSocketClose(ws, code, reason, wasClean) {
    this.handleDisconnect(ws);
  }

  webSocketError(ws, error) {
    this.handleDisconnect(ws);
  }

  // ----- Protocol -----

  handleMessage(ws, msg) {
    const session = ws.deserializeAttachment() || {};

    switch (msg.type) {
      case "join": {
        if (msg.role !== "artillery" && msg.role !== "spotter") {
          this.send(ws, { type: "error", message: "Invalid role" });
          return;
        }
        session.role = msg.role;
        // Clear any stale battery state. An artillery client that's
        // reconnecting will re-send battery_online (with the same callsign)
        // immediately after join.
        session.grid = null;
        session.altitude = null;
        session.callsign = null;
        ws.serializeAttachment(session);
        if (msg.role === "spotter") {
          this.sendBatteryList(ws);
        }
        return;
      }

      case "battery_online": {
        if (session.role !== "artillery") {
          this.send(ws, { type: "error", message: "Only artillery can go online" });
          return;
        }
        if (typeof msg.grid !== "string" || !/^\d{10}$/.test(msg.grid)) {
          this.send(ws, { type: "error", message: "Grid must be exactly 10 digits" });
          return;
        }
        if (msg.altitude == null || isNaN(Number(msg.altitude))) {
          this.send(ws, { type: "error", message: "Altitude is required" });
          return;
        }
        // Callsign is optional. When provided, it must be a string of
        // letters / numbers / hyphens / underscores, up to 18 chars.
        let callsign = null;
        if (msg.callsign != null) {
          if (typeof msg.callsign !== "string") {
            this.send(ws, { type: "error", message: "Callsign must be a string" });
            return;
          }
          const trimmed = msg.callsign.trim();
          if (trimmed.length > 18) {
            this.send(ws, { type: "error", message: "Callsign must be at most 18 characters" });
            return;
          }
          if (trimmed.length > 0 && !/^[A-Za-z0-9_-]+$/.test(trimmed)) {
            this.send(ws, {
              type: "error",
              message: "Callsign may only contain letters, numbers, hyphens, and underscores",
            });
            return;
          }
          callsign = trimmed.length > 0 ? trimmed : null;
        }
        session.grid = msg.grid;
        session.altitude = Number(msg.altitude);
        session.callsign = callsign;
        ws.serializeAttachment(session);
        this.broadcastBatteryList();
        return;
      }

      case "battery_offline": {
        if (session.role !== "artillery") return;
        const wasOnline = session.grid != null;
        session.grid = null;
        session.altitude = null;
        // Note: callsign is preserved across stand-down so a re-online uses
        // the same name. It's cleared only when the session itself ends
        // (handled in "join").
        ws.serializeAttachment(session);
        if (wasOnline) this.broadcastBatteryList();
        return;
      }

      case "fire_mission": {
        if (session.role !== "spotter") {
          this.send(ws, { type: "error", message: "Only spotters can send fire missions" });
          return;
        }
        if (!msg.batteryId) {
          this.send(ws, { type: "error", message: "Battery id is required" });
          return;
        }
        const target = this.findBatteryById(msg.batteryId);
        if (!target) {
          this.send(ws, { type: "error", message: "Battery is not online", clientRef: msg.clientRef || null });
          return;
        }
        // One UUID assigned at mission creation; stable for the entire lifetime.
        const fireMissionUuid = crypto.randomUUID();
        const distance = Number(msg.distance);
        const direction = Number(msg.direction);
        const targetAltitude = msg.targetAltitude == null || isNaN(Number(msg.targetAltitude))
          ? null
          : Number(msg.targetAltitude);

        // 1) Deliver to artillery.
        this.send(target.ws, {
          type: "fire_mission",
          fireMissionUuid,
          from: session.id,
          distance,
          direction,
          targetAltitude,
        });
        // 2) Ack the spotter (sent confirmation; delivery confirmed via fire_mission_receipt).
        this.send(ws, {
          type: "fire_mission_ack",
          fireMissionUuid,
          clientRef: msg.clientRef == null ? null : String(msg.clientRef),
        });
        return;
      }

      case "fire_mission_adjust": {
        if (session.role !== "spotter") {
          this.send(ws, { type: "error", message: "Only spotters can adjust fire missions" });
          return;
        }
        if (!msg.batteryId) {
          this.send(ws, { type: "error", message: "Battery id is required" });
          return;
        }
        if (!isUuid(msg.fireMissionUuid)) {
          this.send(ws, {
            type: "error",
            message: "fireMissionUuid must be a valid UUID",
            clientRef: msg.clientRef || null,
          });
          return;
        }
        const target = this.findBatteryById(msg.batteryId);
        if (!target) {
          this.send(ws, { type: "error", message: "Battery is not online", clientRef: msg.clientRef || null });
          return;
        }
        // Re-use the stable fireMissionUuid — no new UUID is generated.
        const fireMissionUuid = msg.fireMissionUuid;
        const distance = Number(msg.distance);
        const direction = Number(msg.direction);
        const targetAltitude = msg.targetAltitude == null || isNaN(Number(msg.targetAltitude))
          ? null
          : Number(msg.targetAltitude);
        const adjustmentNumber = msg.adjustmentNumber == null || isNaN(Number(msg.adjustmentNumber))
          ? null
          : Number(msg.adjustmentNumber);

        this.send(target.ws, {
          type: "fire_mission_adjust",
          fireMissionUuid,
          from: session.id,
          distance,
          direction,
          targetAltitude,
          adjustmentNumber,
        });
        this.send(ws, {
          type: "fire_mission_ack",
          fireMissionUuid,
          clientRef: msg.clientRef == null ? null : String(msg.clientRef),
        });
        return;
      }

      case "fire_mission_receipt": {
        if (session.role !== "artillery") return;
        if (!isUuid(msg.fireMissionUuid)) return;
        const spotterId = msg.spotterSessionId;
        if (!spotterId || typeof spotterId !== "string") return;
        // Find the originating spotter WebSocket and send a delivery notification.
        for (const w of this.state.getWebSockets()) {
          let a;
          try { a = w.deserializeAttachment(); } catch (e) { continue; }
          if (a && a.id === spotterId && a.role === "spotter") {
            this.send(w, { type: "fire_mission_delivered", fireMissionUuid: msg.fireMissionUuid });
            break;
          }
        }
        return;
      }

      default:
        return;
    }
  }

  handleDisconnect(ws) {
    let session;
    try { session = ws.deserializeAttachment(); } catch (e) { session = null; }
    // Pass the disconnecting ws explicitly so it is excluded from the battery
    // list even if getWebSockets() hasn't removed it yet (e.g. error events).
    if (session && session.role === "artillery" && session.grid) {
      this.broadcastBatteryList(ws);
    }
  }

  // ----- Helpers -----

  findBatteryById(id) {
    for (const ws of this.state.getWebSockets()) {
      let a;
      try { a = ws.deserializeAttachment(); } catch (e) { continue; }
      if (a && a.id === id && a.role === "artillery" && a.grid) {
        return { ws, attachment: a };
      }
    }
    return null;
  }

  getBatteryList(excludeWs = null) {
    const seen = new Set();
    const batteries = [];
    for (const ws of this.state.getWebSockets()) {
      if (excludeWs && ws === excludeWs) continue;
      let a;
      try { a = ws.deserializeAttachment(); } catch (e) { continue; }
      if (a && a.role === "artillery" && a.grid && !seen.has(a.id)) {
        seen.add(a.id);
        batteries.push({
          id: a.id,
          grid: a.grid,
          altitude: a.altitude,
          callsign: a.callsign || null,
        });
      }
    }
    return batteries;
  }

  sendBatteryList(ws) {
    this.send(ws, { type: "batteries", batteries: this.getBatteryList() });
  }

  broadcastBatteryList(excludeWs = null) {
    const payload = { type: "batteries", batteries: this.getBatteryList(excludeWs) };
    for (const ws of this.state.getWebSockets()) {
      let a;
      try { a = ws.deserializeAttachment(); } catch (e) { continue; }
      if (a && a.role === "spotter") {
        this.send(ws, payload);
      }
    }
  }

  send(ws, obj) {
    try {
      ws.send(JSON.stringify(obj));
    } catch (e) {
      // Connection may already be closed; ignore.
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "https://arty.byte.farm",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Upgrade, Connection, Sec-WebSocket-Key, Sec-WebSocket-Version, Sec-WebSocket-Protocol",
      "Vary": "Origin",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const match = url.pathname.match(/^\/room\/([A-Za-z0-9_-]{1,32})\/websocket$/);
    if (!match) {
      return new Response("Not found. Use /room/<opCode>/websocket", {
        status: 404,
        headers: corsHeaders,
      });
    }

    const opCode = match[1];
    const roomId = env.ARTILLERY_ROOM.idFromName(opCode);
    const room = env.ARTILLERY_ROOM.get(roomId);

    const newUrl = new URL(request.url);
    newUrl.pathname = "/websocket";
    const newRequest = new Request(newUrl.toString(), request);
    const response = await room.fetch(newRequest);

    const newResponse = new Response(response.body, response);
    for (const [key, value] of Object.entries(corsHeaders)) {
      newResponse.headers.set(key, value);
    }
    // WebSocket upgrades require the special `webSocket` property to be
    // preserved on the response.
    if (response.webSocket) {
      return new Response(null, {
        status: 101,
        webSocket: response.webSocket,
        headers: newResponse.headers,
      });
    }
    return newResponse;
  },
};