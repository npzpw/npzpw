const API = "https://api.lanyard.rest";
const REQUEST_TIMEOUT = 8000;

export function normalizePresence(input) {
    const data = input?.data || input || {};
    const user = data.discord_user || {};
    const activities = Array.isArray(data.activities)
        ? data.activities
        : [];

    const spotify = data.spotify || null;

    const avatar = user.avatar && user.id
        ? `https://cdn.discordapp.com/avatars/${encodeURIComponent(user.id)}/${encodeURIComponent(user.avatar)}.${user.avatar.startsWith("a_") ? "gif" : "png"}?size=256`
        : "https://cdn.discordapp.com/embed/avatars/0.png";

    const activity = activities.find(item =>
        item.type !== 4 && item.name !== "Spotify"
    );

    const customStatus = activities.find(item => item.type === 4);

    return {
        user: {
            id: user.id || "",
            username: user.username || "Unknown",
            displayName: user.global_name || user.username || "Unknown",
            avatar
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

        customStatus: customStatus?.state || null,

        spotify: spotify ? {
            song: spotify.song || "Unknown Track",
            artist: spotify.artist || "Unknown Artist",
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
    if (!userId || !/^\d{17,20}$/.test(String(userId))) {
        throw new Error("Invalid Discord user ID.");
    }

    const controller = new AbortController();

    const timeout = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT
    );

    try {
        const response = await fetch(
            `${API}/v1/users/${encodeURIComponent(userId)}`,
            {
                headers: {
                    Accept: "application/json"
                },
                signal: controller.signal
            }
        );

        if (!response.ok) {
            throw new Error(`Lanyard API error: ${response.status}`);
        }

        const result = await response.json();

        if (!result?.success || !result?.data) {
            throw new Error("Lanyard returned no presence data.");
        }

        return normalizePresence(result.data);
    } catch (error) {
        if (error.name === "AbortError") {
            throw new Error("Lanyard API request timed out.");
        }

        throw error;
    } finally {
        clearTimeout(timeout);
    }
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

function safeImageURL(value) {
    try {
        const url = new URL(String(value || ""));

        const allowedHosts = [
            "cdn.discordapp.com",
            "media.discordapp.net",
            "i.scdn.co"
        ];

        return url.protocol === "https:" &&
            allowedHosts.includes(url.hostname)
            ? url.href
            : "";
    } catch {
        return "";
    }
}

function truncate(value, max = 50) {
    const chars = Array.from(String(value ?? ""));

    return chars.length > max
        ? chars.slice(0, max - 1).join("") + "…"
        : chars.join("");
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

    const user = presence?.user || {
        displayName: "Discord Presence",
        username: "Waiting for Lanyard",
        avatar: ""
    };

    const spotify = presence?.spotify || null;
    const activity = presence?.activity || null;

    const statusColors = {
        online: "23A55A",
        idle: "F0B232",
        dnd: "F23F43",
        offline: "80848E"
    };

    const status = presence?.status || "offline";
    const statusColor = statusColors[status] || statusColors.offline;

    const height = show.spotify ? 280 : 170;
    const hasSpotify = show.spotify && Boolean(spotify);

    let progress = 0;
    let elapsed = 0;
    let duration = 0;

    if (
        spotify?.start &&
        spotify?.end &&
        spotify.end > spotify.start
    ) {
        duration = spotify.end - spotify.start;

        elapsed = Math.max(
            0,
            Math.min(Date.now() - spotify.start, duration)
        );

        progress = Math.min(100, (elapsed / duration) * 100);
    }

    const activityText = truncate(
        activity
            ? [
                activity.name,
                activity.details,
                activity.state
            ].filter(Boolean).join(" · ")
            : presence?.customStatus || "No current activity",
        70
    );

    const avatarURL = safeImageURL(user.avatar);

    const avatar = show.avatar
        ? avatarURL
            ? `
                <image
                    href="${escapeXML(avatarURL)}"
                    x="24"
                    y="24"
                    width="76"
                    height="76"
                    preserveAspectRatio="xMidYMid slice"
                    clip-path="url(#avatarClip)"
                />
            `
            : `
                <circle
                    cx="62"
                    cy="62"
                    r="38"
                    fill="#${border}"
                />

                <text
                    x="62"
                    y="69"
                    fill="#${text}"
                    font-size="24"
                    text-anchor="middle"
                    font-family="Arial"
                >
                    ${escapeXML((user.username || "?")[0].toUpperCase())}
                </text>
            `
        : "";

    const displayName = show.displayName
        ? `
            <text
                x="116"
                y="48"
                fill="#${text}"
                font-size="19"
                font-weight="700"
                font-family="Arial"
            >
                ${escapeXML(truncate(user.displayName, 30))}
            </text>
        `
        : "";

    const username = show.username
        ? `
            <text
                x="116"
                y="70"
                fill="#${muted}"
                font-size="12"
                font-family="Arial"
            >
                @${escapeXML(truncate(user.username, 32))}
            </text>
        `
        : "";

    const statusSection = show.status
        ? `
            <circle
                cx="116"
                cy="88"
                r="5"
                fill="#${statusColor}"
            />

            <text
                x="128"
                y="92"
                fill="#${muted}"
                font-size="10"
                font-family="Arial"
            >
                ${escapeXML(status.toUpperCase())}
            </text>
        `
        : "";

    const activitySection = show.activity
        ? `
            <rect
                x="18"
                y="112"
                width="444"
                height="32"
                rx="9"
                fill="#${card}"
                stroke="#${border}"
            />

            <circle
                cx="31"
                cy="128"
                r="3"
                fill="#${accent}"
            />

            <text
                x="42"
                y="132"
                fill="#${muted}"
                font-size="10"
                font-family="Arial"
            >
                ${escapeXML(activityText)}
            </text>
        `
        : "";

    let spotifySection = "";

    if (show.spotify) {
        if (hasSpotify) {
            const albumURL = safeImageURL(spotify.albumArt);

            const album = albumURL
                ? `
                    <image
                        href="${escapeXML(albumURL)}"
                        x="30"
                        y="166"
                        width="82"
                        height="82"
                        preserveAspectRatio="xMidYMid slice"
                        clip-path="url(#albumClip)"
                    />
                `
                : `
                    <rect
                        x="30"
                        y="166"
                        width="82"
                        height="82"
                        rx="9"
                        fill="#${border}"
                    />

                    <text
                        x="71"
                        y="216"
                        fill="#${muted}"
                        font-size="27"
                        text-anchor="middle"
                    >♫</text>
                `;

            spotifySection = `
                <rect
                    x="18"
                    y="154"
                    width="444"
                    height="106"
                    rx="13"
                    fill="#${card}"
                    stroke="#${border}"
                />

                ${album}

                <text
                    x="125"
                    y="183"
                    fill="#1DB954"
                    font-size="9"
                    font-weight="700"
                    font-family="Arial"
                    letter-spacing="1.2"
                >
                    NOW PLAYING
                </text>

                <text
                    x="125"
                    y="205"
                    fill="#${text}"
                    font-size="14"
                    font-weight="700"
                    font-family="Arial"
                >
                    ${escapeXML(truncate(spotify.song, 38))}
                </text>

                <text
                    x="125"
                    y="225"
                    fill="#${muted}"
                    font-size="11"
                    font-family="Arial"
                >
                    ${escapeXML(truncate(spotify.artist, 48))}
                </text>

                ${show.progress ? `
                    <rect
                        x="125"
                        y="239"
                        width="320"
                        height="4"
                        rx="2"
                        fill="#${border}"
                    />

                    <rect
                        x="125"
                        y="239"
                        width="${320 * progress / 100}"
                        height="4"
                        rx="2"
                        fill="#1DB954"
                    />
                ` : ""}

                ${show.timestamp && duration > 0 ? `
                    <text
                        x="125"
                        y="254"
                        fill="#${muted}"
                        font-size="8"
                        font-family="Arial"
                    >
                        ${formatTime(elapsed)}
                    </text>

                    <text
                        x="445"
                        y="254"
                        fill="#${muted}"
                        font-size="8"
                        text-anchor="end"
                        font-family="Arial"
                    >
                        ${formatTime(duration)}
                    </text>
                ` : ""}
            `;
        } else {
            spotifySection = `
                <rect
                    x="18"
                    y="154"
                    width="444"
                    height="106"
                    rx="13"
                    fill="#${card}"
                    stroke="#${border}"
                />

                <circle
                    cx="71"
                    cy="207"
                    r="27"
                    fill="#${border}"
                />

                <text
                    x="71"
                    y="216"
                    fill="#1DB954"
                    font-size="27"
                    text-anchor="middle"
                >♫</text>

                <text
                    x="116"
                    y="199"
                    fill="#${text}"
                    font-size="13"
                    font-weight="700"
                    font-family="Arial"
                >
                    Not listening to Spotify
                </text>

                <text
                    x="116"
                    y="219"
                    fill="#${muted}"
                    font-size="10"
                    font-family="Arial"
                >
                    Spotify activity will appear here.
                </text>
            `;
        }
    }

    return `
        <svg
            xmlns="http://www.w3.org/2000/svg"
            xmlns:xlink="http://www.w3.org/1999/xlink"
            width="480"
            height="${height}"
            viewBox="0 0 480 ${height}"
            role="img"
            aria-label="Discord presence card"
        >
            <defs>
                <clipPath id="avatarClip">
                    <circle cx="62" cy="62" r="38"/>
                </clipPath>

                <clipPath id="albumClip">
                    <rect
                        x="30"
                        y="166"
                        width="82"
                        height="82"
                        rx="9"
                    />
                </clipPath>
            </defs>

            <rect
                width="480"
                height="${height}"
                rx="17"
                fill="#${bg}"
                stroke="#${border}"
            />

            <rect
                x="18"
                y="18"
                width="444"
                height="84"
                rx="13"
                fill="#${card}"
                stroke="#${border}"
            />

            ${avatar}
            ${displayName}
            ${username}
            ${statusSection}
            ${activitySection}
            ${spotifySection}
        </svg>
    `.trim();
}