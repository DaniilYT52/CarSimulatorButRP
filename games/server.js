/*
  PRO 3D Car Simulator - Multiplayer Server (Socket.io)
  ------------------------------------------------------
  Fixed for Render.com deployment
*/

const fs = require("fs");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");

// Render сам назначит PORT, если нет - используем 8080
const PORT = process.env.PORT || 8080;
const MAX_PLAYERS = 20;
const SAVE_FILE = path.join(__dirname, "player-data.json");

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sanitizeName(name) {
  const clean = String(name || "")
    .replace(/[^\w\s\-.\[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 20);
  return clean || `Driver${Math.floor(Math.random() * 900 + 100)}`;
}

function sanitizeRoom(room) {
  const clean = String(room || "open_world")
    .replace(/[^\w\-]/g, "")
    .slice(0, 24);
  return clean || "open_world";
}

function sanitizeChat(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 140);
}

function safeCopyObject(value, fallback = {}) {
  if (!value || typeof value !== "object") return { ...fallback };
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return { ...fallback };
  }
}

function sanitizeGarageLocation(location) {
  const x = Number(location?.x);
  const z = Number(location?.z);
  return {
    x: Number.isFinite(x) ? clamp(x, -520, 520) : 0,
    z: Number.isFinite(z) ? clamp(z, -520, 520) : -500
  };
}

function sanitizeProfile(input, playerID, nickname) {
  const profile = input && typeof input === "object" ? input : {};
  const moneyRaw = Number(profile.money);
  return {
    playerID: String(playerID || profile.playerID || ""),
    nickname: sanitizeName(nickname || profile.nickname),
    money: Number.isFinite(moneyRaw) ? Math.max(0, Math.round(moneyRaw)) : 0,
    ownedCars: safeCopyObject(profile.ownedCars, { starter: true }),
    carUpgrades: safeCopyObject(profile.carUpgrades, { starter: { upgrades: {}, custom: {} } }),
    garageLocation: sanitizeGarageLocation(profile.garageLocation)
  };
}

function sanitizeStatePacket(meta, msg) {
  const x = Number(msg.x);
  const y = Number(msg.y);
  const z = Number(msg.z);
  const rotationRaw = Number.isFinite(Number(msg.rotation)) ? Number(msg.rotation) : Number(msg.yaw);
  const speed = Number(msg.speed);
  const drift = Number(msg.drift);
  const carId = String(msg.carId || "starter").slice(0, 40);
  const color = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(msg.color || "")) ? String(msg.color) : "#4ca6ff";

  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;

  return {
    t: "state",
    id: meta.socketId,
    playerID: meta.playerID,
    name: meta.name,
    room: meta.room,
    x: clamp(x, -2000, 2000),
    y: Number.isFinite(y) ? clamp(y, -50, 80) : 0,
    z: clamp(z, -2000, 2000),
    rotation: Number.isFinite(rotationRaw) ? rotationRaw : 0,
    yaw: Number.isFinite(rotationRaw) ? rotationRaw : 0,
    speed: Number.isFinite(speed) ? clamp(speed, 0, 250) : 0,
    carId,
    color,
    drift: Number.isFinite(drift) ? Math.max(0, Math.round(drift)) : 0,
    ts: Date.now()
  };
}

function loadProfiles() {
  try {
    if (!fs.existsSync(SAVE_FILE)) return {};
    const raw = fs.readFileSync(SAVE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    console.error("Failed to load profile store:", err.message);
    return {};
  }
}

const profiles = loadProfiles();
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(SAVE_FILE, JSON.stringify(profiles, null, 2), "utf8");
    } catch (err) {
      console.error("Failed to save profile store:", err.message);
    }
  }, 350);
}

const httpServer = http.createServer();
const io = new Server(httpServer, {
  cors: { origin: "*" }
});

const clients = new Map(); 
const states = new Map(); 

function emitRoom(room, payload, exceptSocketId = null) {
  if (exceptSocketId) {
    io.to(room).except(exceptSocketId).emit("msg", payload);
  } else {
    io.to(room).emit("msg", payload);
  }
}

io.on("connection", (socket) => {
  if (clients.size >= MAX_PLAYERS) {
    socket.emit("msg", { t: "server_full", maxPlayers: MAX_PLAYERS });
    socket.disconnect(true);
    return;
  }

  const meta = {
    socketId: socket.id,
    playerID: `guest-${socket.id.slice(0, 8)}`,
    name: sanitizeName("Driver"),
    room: "open_world",
    lastChatAt: 0
  };
  clients.set(socket.id, meta);

  socket.on("msg", (msg) => {
    if (!msg || typeof msg !== "object") return;
    const t = String(msg.t || "");

    if (t === "hello") {
      const room = sanitizeRoom(msg.room || "open_world");
      const nickname = sanitizeName(msg.name);
      const playerID = String(msg.playerID || msg.playerId || "").trim() || `p-${socket.id}`;
      const incomingProfile = sanitizeProfile(msg.profile || {}, playerID, nickname);
      const saved = profiles[playerID] ? sanitizeProfile(profiles[playerID], playerID, nickname) : null;
      const profile = saved || incomingProfile;
      profile.nickname = nickname;

      meta.room = room;
      meta.name = nickname;
      meta.playerID = playerID;
      clients.set(socket.id, meta);
      profiles[playerID] = profile;
      scheduleSave();

      socket.join(room);

      socket.emit("msg", {
        t: "welcome",
        id: socket.id,
        playerID,
        profile,
        maxPlayers: MAX_PLAYERS
      });

      for (const [otherId, state] of states) {
        if (otherId === socket.id) continue;
        if (state.room !== room) continue;
        socket.emit("msg", state);
      }

      emitRoom(room, { t: "join", id: socket.id, name: meta.name, playerID: meta.playerID }, socket.id);
      return;
    }

    if (t === "state") {
      const packet = sanitizeStatePacket(meta, msg);
      if (!packet) return;
      states.set(socket.id, packet);
      emitRoom(meta.room, packet, socket.id);
      return;
    }

    if (t === "chat" || t === "message") {
      const now = Date.now();
      if (now - meta.lastChatAt < 1000) return; 
      meta.lastChatAt = now;
      clients.set(socket.id, meta);

      const text = sanitizeChat(msg.text || msg.message);
      if (!text) return;
      emitRoom(meta.room, {
        t: "chat",
        id: socket.id,
        playerID: meta.playerID,
        name: meta.name,
        text
      });
      return;
    }

    if (t === "save_profile") {
      const playerID = String(msg.playerID || meta.playerID || "").trim();
      if (!playerID) return;
      const profile = sanitizeProfile(msg.profile || {}, playerID, meta.name);
      profile.nickname = meta.name;
      profiles[playerID] = profile;
      scheduleSave();
      return;
    }

    if (t === "race_start") {
      emitRoom(meta.room, {
        t: "race_start",
        id: socket.id,
        name: meta.name,
        startedAt: Number(msg.startedAt) || Date.now()
      }, socket.id);
      return;
    }

    if (t === "race_finish") {
      const time = Number(msg.time);
      if (!Number.isFinite(time) || time <= 0) return;
      emitRoom(meta.room, {
        t: "race_finish",
        id: socket.id,
        name: meta.name,
        time
      }, socket.id);
    }
  });

  socket.on("disconnect", () => {
    const m = clients.get(socket.id);
    if (m) {
      emitRoom(m.room, { t: "leave", id: socket.id, name: m.name, playerID: m.playerID }, socket.id);
    }
    clients.delete(socket.id);
    states.delete(socket.id);
  });
});

// --- СЕКЦИЯ ЗАПУСКА ---
httpServer.listen(PORT, () => {
  console.log(`[server] Running on port ${PORT}`);
  console.log(`[server] Max players: ${MAX_PLAYERS}`);
});

// Сохранение при выключении
process.on("SIGINT", () => {
  try {
    fs.writeFileSync(SAVE_FILE, JSON.stringify(profiles, null, 2), "utf8");
    console.log("Profiles saved.");
  } catch (e) {}
  process.exit(0);
});
});

