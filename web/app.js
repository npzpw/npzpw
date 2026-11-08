import { fetchPresence, normalizePresence } from "./lanyard-core.js";
const config = window.DISCORD_CONFIG || {};
const userId = config.userId;
if (!userId || userId === "YOUR_DISCORD_USER_ID") {
    document.getElementById("connection-text").textContent =
        "Missing Discord ID";
    throw new Error("Set discord.user_id in config.yml");
}
const settings = config.ui || {};
const elements = {
    avatar: document.getElementById("avatar"),
    displayName: document.getElementById("display-name"),
    username: document.getElementById("username"),
    status: document.getElementById("status-label"),
    statusIndicator: document.getElementById("status-indicator"),
    activity: document.getElementById("activity-content"),
    spotifySection: document.getElementById("spotify-section"),
    albumArt: document.getElementById("album-art"),
    song: document.getElementById("song-name"),
    artist: document.getElementById("artist-name"),
    album: document.getElementById("album-name"),
    progress: document.getElementById("progress-bar"),
    currentTime: document.getElementById("current-time"),
    totalTime: document.getElementById("total-time"),
    connectionDot: document.getElementById("connection-dot"),
    connectionText: document.getElementById("connection-text"),
    lastUpdated: document.getElementById("last-updated")
};
let presence = null;
let socket = null;
let heartbeat = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
const STATUS_COLORS = {
    online: "#23A55A",
    idle: "#F0B232",
    dnd: "#F23F43",
    offline: "#80848E"
};
function setConnection(connected, message) {
    elements.connectionDot.classList.toggle(
        "connected",
        connected
    );
    elements.connectionText.textContent = message;
}
function formatTime(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(seconds / 60)}:${String(
        seconds % 60
    ).padStart(2, "0")}`;
}
function setText(element, value) {
    element.textContent = value || "";
}
function renderProfile(data) {
    const user = data.user;
    if (settings.show_avatar !== false) {
        elements.avatar.src = user.avatar;
        elements.avatar.style.display = "";
    } else {
        elements.avatar.style.display = "none";
    }
    setText(
        elements.displayName,
        settings.show_display_name !== false
            ? user.displayName
            : ""
    );
    setText(
        elements.username,
        settings.show_username !== false
            ? `@${user.username}`
            : ""
    );
    const status = data.status || "offline";
    if (settings.show_status !== false) {
        setText(elements.status, status.toUpperCase());
        elements.statusIndicator.style.display = "";
        elements.statusIndicator.style.background =
            STATUS_COLORS[status] || STATUS_COLORS.offline;
    } else {
        elements.status.style.display = "none";
        elements.statusIndicator.style.display = "none";
    }
}
function renderActivity(data) {
    if (settings.show_activity === false) {
        elements.activity.style.display = "none";
        return;
    }
    elements.activity.style.display = "";
    const activity = data.activity;
    if (!activity) {
        elements.activity.innerHTML =
            '<p class="empty">No current activity.</p>';
        return;
    }
    const wrapper = document.createElement("div");
    wrapper.className = "activity-content";
    const icon = document.createElement("div");
    icon.className = "activity-icon";
    const info = document.createElement("div");
    const name = document.createElement("div");
    name.className = "activity-name";
    name.textContent = activity.name;
    const detail = document.createElement("div");
    detail.className = "activity-detail";
    detail.textContent = [
        activity.details,
        activity.state
    ].filter(Boolean).join(" · ");
    info.append(name, detail);
    wrapper.append(icon, info);
    elements.activity.replaceChildren(wrapper);
}
function renderSpotify(data) {
    if (settings.show_spotify === false) {
        elements.spotifySection.style.display = "none";
        return;
    }
    const spotify = data.spotify;
    elements.spotifySection.style.display = "";
    if (!spotify) {
        elements.song.textContent = "Not playing";
        elements.artist.textContent = "Spotify is currently inactive";
        elements.album.textContent = "";
        elements.albumArt.removeAttribute("src");
        elements.progress.style.width = "0%";
        elements.currentTime.textContent = "0:00";
        elements.totalTime.textContent = "0:00";
        return;
    }
    elements.albumArt.src = spotify.albumArt;
    setText(elements.song, spotify.song);
    setText(elements.artist, spotify.artist);
    setText(elements.album, spotify.album);
    updateProgress();
}
function render(data) {
    presence = data;
    renderProfile(data);
    renderActivity(data);
    renderSpotify(data);
    elements.lastUpdated.textContent =
        `Updated ${new Date().toLocaleTimeString()}`;
}
function updateProgress() {
    const spotify = presence?.spotify;
    if (!spotify?.start || !spotify?.end) return;
    const elapsed = Date.now() - spotify.start;
    const duration = spotify.end - spotify.start;
    const percentage = Math.max(
        0,
        Math.min(100, elapsed / duration * 100)
    );
    elements.progress.style.width = `${percentage}%`;
    elements.currentTime.textContent =
        formatTime(elapsed);
    elements.totalTime.textContent =
        formatTime(duration);
}
async function loadInitialData() {
    try {
        const data = await fetchPresence(userId);
        render(data);
    } catch (error) {
        console.error("Initial Lanyard fetch failed:", error);
    }
}
function connect() {
    clearTimeout(reconnectTimer);
    setConnection(false, "Connecting");
    socket = new WebSocket(
        "wss://api.lanyard.rest/socket"
    );
    socket.addEventListener("open", () => {
        reconnectAttempts = 0;
    });
    socket.addEventListener("message", event => {
        let message;
        try {
            message = JSON.parse(event.data);
        } catch {
            return;
        }
        // Opcode 1: HELLO
        if (message.op === 1) {
            const interval =
                message.d?.heartbeat_interval || 30000;
            clearInterval(heartbeat);
            heartbeat = setInterval(() => {
                if (socket?.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify({
                        op: 3
                    }));
                }
            }, interval);
            // Opcode 2: Initialize subscription
            socket.send(JSON.stringify({
                op: 2,
                d: {
                    subscribe_to_ids: [userId]
                }
            }));
            return;
        }
        // Opcode 0: Event
        if (message.op === 0) {
            if (message.t === "INIT_STATE") {
                const initial = message.d?.[userId];
                if (initial) {
                    render(normalizePresence(initial));
                    setConnection(true, "Connected");
                }
                return;
            }
            if (message.t === "PRESENCE_UPDATE") {
                if (message.d?.discord_user?.id !== userId) {
                    return;
                }
                render(normalizePresence(message.d));
                setConnection(true, "Live");
            }
        }
    });
    socket.addEventListener("error", () => {
        setConnection(false, "Connection error");
    });
    socket.addEventListener("close", () => {
        clearInterval(heartbeat);
        setConnection(false, "Reconnecting");
        const delay = Math.min(
            1000 * 2 ** reconnectAttempts,
            30000
        );
        reconnectAttempts++;
        reconnectTimer = setTimeout(
            connect,
            delay
        );
    });
}
loadInitialData();
connect();
setInterval(updateProgress, 1000);