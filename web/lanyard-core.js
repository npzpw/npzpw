const API = "https://api.lanyard.rest";
const REQUEST_TIMEOUT = 8000;

export function normalizePresence(input) {
    const data = input?.data || input || {};
    const user = data.discord_user || {};

    return {
        user: {
            id: user.id || "",
            username: user.username || "Unknown",
            displayName: user.global_name || user.username || "Unknown",
            avatar: user.avatar && user.id
                ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${user.avatar.startsWith("a_") ? "gif" : "png"}?size=256`
                : "https://cdn.discordapp.com/embed/avatars/0.png"
        },
        status: data.discord_status || "offline",
        activities: Array.isArray(data.activities)
            ? data.activities
            : [],
        spotify: data.spotify || null,
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

export function createDiscordSVG(presence, options = {}) {
    const userId = presence?.user?.id || options.user_id || "";

    const border = String(
        options.theme?.border || "30363D"
    ).replace(/^#/, "");

    const borderColor = /^[0-9a-fA-F]{6}$/.test(border)
        ? border
        : "30363D";

    const url = `https://lanyard.cnrad.dev/api/${encodeURIComponent(userId)}?theme=dark&borderRadius=12px&bg=0d1117&idleMessage=Not%20currently%20doing%20anything`;

    return `
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="500"
            height="200"
            viewBox="0 0 500 200"
        >
            <image
                href="${url}"
                width="500"
                height="200"
                preserveAspectRatio="xMidYMid meet"
            />

            <rect
                x="1"
                y="1"
                width="498"
                height="198"
                rx="12"
                fill="none"
                stroke="#${borderColor}"
                stroke-width="2"
            />
        </svg>
    `.trim();
}