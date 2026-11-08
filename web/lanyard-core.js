const API = "https://api.lanyard.rest";
const SOCKET = "wss://api.lanyard.rest/socket";

export function normalizePresence(input) {
    const data = input?.data || input || {};
    const user = data.discord_user || {};
    const spotify = data.spotify || null;

    const activities = (data.activities || [])
        .filter(activity =>
            activity.type !== 4 &&
            activity.name !== "Spotify"
        );

    const activity = activities[0] || null;

    const avatar = user.avatar
        ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${user.avatar.startsWith("a_") ? "gif" : "png"}?size=256`
        : `https://cdn.discordapp.com/embed/avatars/0.png`;

    return {
        user: {
            id: user.id || "",
            username: user.username || "Unknown",
            displayName: user.global_name || user.username || "Unknown",
            avatar,
            discriminator: user.discriminator || "0"
        },

        status: data.discord_status || "offline",

        activity: activity ? {
            name: activity.name || "",
            details: activity.details || "",
            state: activity.state || "",
            type: activity.type,
            applicationId: activity.application_id || null,
            assets: activity.assets || {}
        } : null,

        customStatus: (data.activities || [])
            .find(item => item.type === 4)?.state || null,

        spotify: spotify ? {
            song: spotify.song || "",
            artist: spotify.artist || "",
            album: spotify.album || "",
            albumArt: spotify.album_art_url || "",
            trackId: spotify.track_id || "",
            start: spotify.timestamps?.start || null,
            end: spotify.timestamps?.end || null
        } : null,

        listeningToSpotify: Boolean(data.listening_to_spotify),

        receivedAt: Date.now()
    };
}

export async function fetchPresence(userId) {
    const response = await fetch(
        `${API}/v1/users/${encodeURIComponent(userId)}`
    );

    if (!response.ok) {
        throw new Error(`Lanyard API error: ${response.status}`);
    }

    const result = await response.json();

    if (!result.success || !result.data) {
        throw new Error("Lanyard returned no presence data.");
    }

    return normalizePresence(result.data);
}

function escapeXML(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;"
    })[char]);
}

function color(value, fallback) {
    const result = String(value || fallback).replace(/^#/, "");

    return /^[0-9a-fA-F]{6}$/.test(result)
        ? result
        : fallback;
}

function formatTime(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(seconds / 60);

    return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export function createDiscordSVG(presence, options = {}) {
    const theme = options.theme || {};

    const bg = color(theme.background, "161B22");
    const card = color(theme.card, "0D1117");
    const text = color(theme.text, "E6EDF3");
    const muted = color(theme.muted, "8B949E");
    const accent = color(theme.accent, "5865F2");
    const border = color(theme.border, "30363D");

    const show = {
        avatar: options.show_avatar !== false,
        displayName: options.show_display_name !== false,
        username: options.show_username !== false,
        status: options.show_status !== false,
        activity: options.show_activity !== false,
        spotify: options.show_spotify !== false,
        timestamp: options.show_timestamp !== false,
        progress: options.show_progress !== false
    };

    const p = presence;

    const user = p?.user || {
        displayName: "Discord Presence",
        username: "Waiting for Lanyard",
        avatar: ""
    };

    const spotify = p?.spotify;
    const activity = p?.activity;

    const statusColors = {
        online: "23A55A",
        idle: "F0B232",
        dnd: "F23F43",
        offline: "80848E"
    };

    const statusColor = statusColors[p?.status] || statusColors.offline;

    const spotifyProgress = spotify?.start && spotify?.end
        ? Math.max(
            0,
            Math.min(
                100,
                ((Date.now() - spotify.start) /
                    (spotify.end - spotify.start)) * 100
            )
        )
        : 0;

    const activityText = activity
        ? [
            activity.name,
            activity.details,
            activity.state
        ].filter(Boolean).join(" · ")
        : p?.customStatus || "No current activity";

    const spotifySection = show.spotify && spotify ? `
        <rect x="18" y="154" width="444" height="106" rx="13" fill="#${card}" stroke="#${border}"/>

        <image
            href="${escapeXML(spotify.albumArt)}"
            x="30" y="166" width="82" height="82"
            preserveAspectRatio="xMidYMid slice"
            clip-path="url(#albumClip)"
        />

        <text x="125" y="183" fill="#${muted}" font-size="9" font-family="Arial" letter-spacing="1.2">NOW PLAYING</text>

        <text x="125" y="205" fill="#${text}" font-size="14" font-weight="700" font-family="Arial">${escapeXML(spotify.song.slice(0, 38))}</text>

        <text x="125" y="225" fill="#${muted}" font-size="11" font-family="Arial">${escapeXML(spotify.artist.slice(0, 48))}</text>

        ${show.progress ? `
            <rect x="125" y="239" width="320" height="4" rx="2" fill="#${border}"/>
            <rect x="125" y="239" width="${320 * spotifyProgress / 100}" height="4" rx="2" fill="#1DB954"/>
        ` : ""}
    ` : "";

    const avatarSection = show.avatar ? `
        <image
            href="${escapeXML(user.avatar)}"
            x="24" y="24" width="76" height="76"
            clip-path="url(#avatarClip)"
        />
    ` : "";

    const displayName = show.displayName
        ? `<text x="116" y="48" fill="#${text}" font-size="19" font-weight="700" font-family="Arial">${escapeXML(user.displayName)}</text>`
        : "";

    const username = show.username
        ? `<text x="116" y="70" fill="#${muted}" font-size="12" font-family="Arial">@${escapeXML(user.username)}</text>`
        : "";

    const status = show.status ? `
        <circle cx="116" cy="88" r="5" fill="#${statusColor}"/>
        <text x="128" y="92" fill="#${muted}" font-size="10" font-family="Arial">${escapeXML(p?.status || "offline").toUpperCase()}</text>
    ` : "";

    const activitySection = show.activity ? `
        <rect x="18" y="112" width="444" height="32" rx="9" fill="#${card}"/>
        <text x="30" y="132" fill="#${muted}" font-size="10" font-family="Arial">${escapeXML(activityText.slice(0, 70))}</text>
    ` : "";

    const spotifyTimes = show.timestamp && spotify?.start && spotify?.end
        ? `
            <text x="125" y="254" fill="#${muted}" font-size="8" font-family="Arial">${formatTime(Date.now() - spotify.start)}</text>
            <text x="445" y="254" fill="#${muted}" font-size="8" text-anchor="end" font-family="Arial">${formatTime(spotify.end - spotify.start)}</text>
        `
        : "";

    return `
<svg xmlns="http://www.w3.org/2000/svg" width="480" height="${show.spotify && spotify ? 280 : 170}" viewBox="0 0 480 ${show.spotify && spotify ? 280 : 170}">
    <defs>
        <linearGradient id="accent" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#${accent}"/>
            <stop offset="100%" stop-color="#8B5CF6"/>
        </linearGradient>

        <clipPath id="avatarClip">
            <circle cx="62" cy="62" r="38"/>
        </clipPath>

        <clipPath id="albumClip">
            <rect x="30" y="166" width="82" height="82" rx="9"/>
        </clipPath>
    </defs>

    <rect width="480" height="${show.spotify && spotify ? 280 : 170}" rx="17" fill="#${bg}" stroke="#${border}"/>

    <rect x="18" y="18" width="444" height="84" rx="13" fill="#${card}" stroke="#${border}"/>

    ${avatarSection}
    ${displayName}
    ${username}
    ${status}
    ${activitySection}
    ${spotifySection}
    ${spotifyTimes}
</svg>
`.trim();
}