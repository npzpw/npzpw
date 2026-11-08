#!/usr/bin/env node
/**
 * Modern GitHub Profile README Generator
 *
 * Node.js 22+
 * ES Module
 *
 * npm install js-yaml
 * npm run generate
 */
import {
    fetchPresence,
    createDiscordSVG
} from "../web/lanyard-core.js";

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import process from "node:process";
import { fileURLToPath } from "node:url";
// ============================================================
// PATHS
// ============================================================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "config.yml");
const README_PATH = path.join(ROOT, "README.md");
const ASSETS_PATH = path.join(ROOT, "assets");
const START_MARKER = "<!-- PROFILE-GENERATOR:START -->";
const END_MARKER = "<!-- PROFILE-GENERATOR:END -->";
// ============================================================
// CONFIGURATION
// ============================================================
function loadConfig() {
    if (!fs.existsSync(CONFIG_PATH)) {
        throw new Error("config.yml was not found.");
    }
    const config = yaml.load(
        fs.readFileSync(CONFIG_PATH, "utf8")
    );
    if (!config || typeof config !== "object") {
        throw new Error("Invalid config.yml");
    }
    return config;
}
function enabled(value, fallback = true) {
    return typeof value === "boolean" ? value : fallback;
}
function escapeHTML(value) {
    return String(value ?? "").replace(
        /[&<>"']/g,
        char => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&apos;"
        })[char]
    );
}
function escapeMarkdown(value) {
    return String(value ?? "").replace(
        /([\\`*_{}[\]()#+\-.!|])/g,
        "\\$1"
    );
}
function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function encode(value) {
    return encodeURIComponent(String(value ?? ""));
}
function getColor(config, key, fallback) {
    const value = String(
        config.theme?.[key] || fallback
    ).replace(/^#/, "");
    return /^[0-9a-fA-F]{6}$/.test(value)
        ? value
        : fallback;
}
function ensureDirectories() {
    fs.mkdirSync(ASSETS_PATH, { recursive: true });
}
function writeAsset(filename, content) {
    fs.writeFileSync(
        path.join(ASSETS_PATH, filename),
        content,
        "utf8"
    );
}
function removeAsset(filename) {
    const file = path.join(ASSETS_PATH, filename);
    if (fs.existsSync(file)) {
        fs.unlinkSync(file);
    }
}
// ============================================================
// THEME
// ============================================================
function getTheme(config) {
    return {
        background: getColor(config, "background", "0D1117"),
        card: getColor(config, "card", "161B22"),
        text: getColor(config, "text", "E6EDF3"),
        muted: getColor(config, "muted", "8B949E"),
        accent: getColor(config, "accent", "58A6FF"),
        border: getColor(config, "border", "30363D"),
        showBorder: enabled(
            config.theme?.show_border,
            true
        )
    };
}
function svgStart(width, height) {
    return `
<svg
    xmlns="http://www.w3.org/2000/svg"
    width="${width}"
    height="${height}"
    viewBox="0 0 ${width} ${height}"
    fill="none"
>
`.trim();
}
function svgEnd() {
    return "</svg>";
}
function fontFamily() {
    return "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
}
function monoFont() {
    return "'JetBrains Mono', 'SFMono-Regular', Consolas, monospace";
}
function cardBackground(theme, width, height, radius = 16) {
    return `
<rect
    x="0.5"
    y="0.5"
    width="${width - 1}"
    height="${height - 1}"
    rx="${radius}"
    fill="#${theme.card}"
    stroke="#${theme.border}"
    stroke-opacity="${theme.showBorder ? 1 : 0}"
/>
`;
}
function gradientDefinitions(theme, id = "accent") {
    return `
<defs>
    <linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#${theme.accent}"/>
        <stop offset="100%" stop-color="#8B5CF6"/>
    </linearGradient>
    <linearGradient id="${id}-soft" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#${theme.accent}" stop-opacity="0.20"/>
        <stop offset="100%" stop-color="#8B5CF6" stop-opacity="0.05"/>
    </linearGradient>
</defs>
`;
}
// ============================================================
// HTTP
// ============================================================
async function fetchJSON(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: {
            "User-Agent": "Modern-GitHub-Profile-Generator",
            "Accept": "application/vnd.github+json",
            ...options.headers
        }
    });
    if (!response.ok) {
        throw new Error(
            `HTTP ${response.status}: ${url}`
        );
    }
    return response.json();
}
// ============================================================
// GITHUB DATA
// ============================================================
async function getGithubProfile(username, token) {
    const headers = token
        ? { Authorization: `Bearer ${token}` }
        : {};
    const user = await fetchJSON(
        `https://api.github.com/users/${encode(username)}`,
        { headers }
    );
    const repositories = [];
    for (let page = 1; page <= 3; page++) {
        const items = await fetchJSON(
            `https://api.github.com/users/${encode(username)}/repos?per_page=100&page=${page}&type=owner`,
            { headers }
        );
        repositories.push(...items);
        if (items.length < 100) break;
    }
    const stats = {
        repositories: user.public_repos || 0,
        followers: user.followers || 0,
        stars: 0
    };
    const languages = {};
    for (const repo of repositories) {
        stats.stars += repo.stargazers_count || 0;
    }
    // Fetch language statistics with limited concurrency.
    const languageRepos = repositories.filter(
        repo => !repo.fork
    );
    const concurrency = 8;
    for (
        let i = 0;
        i < languageRepos.length;
        i += concurrency
    ) {
        const batch = languageRepos.slice(
            i,
            i + concurrency
        );
        const results = await Promise.allSettled(
            batch.map(repo =>
                fetchJSON(repo.languages_url, { headers })
            )
        );
        for (const result of results) {
            if (result.status !== "fulfilled") continue;
            for (const [name, bytes] of Object.entries(result.value)) {
                languages[name] =
                    (languages[name] || 0) + bytes;
            }
        }
    }
    const totalBytes = Object.values(languages)
        .reduce((sum, bytes) => sum + bytes, 0);
    const languageList = Object.entries(languages)
        .map(([name, bytes]) => ({
            name,
            bytes,
            percentage: totalBytes
                ? (bytes / totalBytes) * 100
                : 0
        }))
        .sort((a, b) => b.bytes - a.bytes);
    return {
        ...stats,
        languages: languageList
    };
}
// ============================================================
// CONTRIBUTIONS GRAPHQL
// ============================================================
async function getContributions(username, token, includePrivate) {
    if (!token) {
        console.warn("GITHUB_TOKEN is missing.");
        return null;
    }
    const query = `
        query(
            $login: String!,
            $from: DateTime!,
            $to: DateTime!,
            $includePrivate: Boolean!
        ) {
            user(login: $login) {
                contributionsCollection(
                    from: $from,
                    to: $to,
                    includePrivate: $includePrivate
                ) {
                    contributionCalendar {
                        totalContributions
                        weeks {
                            contributionDays {
                                date
                                contributionCount
                            }
                        }
                    }
                }
            }
        }
    `;
    const now = new Date();
    const from = new Date(now);
    from.setUTCFullYear(
        from.getUTCFullYear() - 1
    );
    const result = await fetchJSON(
        "https://api.github.com/graphql",
        {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                query,
                variables: {
                    login: username,
                    from: from.toISOString(),
                    to: now.toISOString(),
                    includePrivate: Boolean(includePrivate)
                }
            })
        }
    );
    if (result.errors?.length) {
        throw new Error(
            result.errors.map(e => e.message).join("; ")
        );
    }
    const calendar =
        result.data?.user?.contributionsCollection?.contributionCalendar;
    if (!calendar) return null;
    return {
        total: calendar.totalContributions,
        days: calendar.weeks.flatMap(
            week => week.contributionDays
        )
    };
}
// ============================================================
// STREAK CALCULATION
// ============================================================
function calculateStreak(days) {
    if (!days?.length) {
        return {
            current: 0,
            longest: 0
        };
    }
    let longest = 0;
    let running = 0;
    for (const day of days) {
        if (day.contributionCount > 0) {
            running++;
            longest = Math.max(longest, running);
        } else {
            running = 0;
        }
    }
    let current = 0;
    let index = days.length - 1;
    const today = new Date()
        .toISOString()
        .slice(0, 10);
    if (
        days[index].date === today &&
        days[index].contributionCount === 0
    ) {
        index--;
    }
    for (; index >= 0; index--) {
        if (days[index].contributionCount > 0) {
            current++;
        } else {
            break;
        }
    }
    return {
        current,
        longest
    };
}
// ============================================================
// SVG: GITHUB STATISTICS
// ============================================================
function createGithubStats(github, contributions, config) {
    const theme = getTheme(config);
    const settings = config.github?.stats || {};
    const metrics = [];
    if (enabled(settings.show_repositories, true)) {
        metrics.push({
            label: "PUBLIC REPOSITORIES",
            value: github?.repositories ?? "—",
            icon: "01"
        });
    }
    if (enabled(settings.show_followers, true)) {
        metrics.push({
            label: "FOLLOWERS",
            value: github?.followers ?? "—",
            icon: "02"
        });
    }
    if (enabled(settings.show_stars, true)) {
        metrics.push({
            label: "TOTAL STARS",
            value: github?.stars ?? "—",
            icon: "03"
        });
    }
    if (enabled(config.github?.contributions?.enabled, true)) {
        metrics.push({
            label: "CONTRIBUTIONS",
            value: contributions?.total ?? "—",
            icon: "04"
        });
    }
    const columns = 2;
    const cellWidth = 270;
    const cellHeight = 94;
    const gap = 12;
    const padding = 20;
    const rows = Math.ceil(metrics.length / columns);
    const width = padding * 2 + columns * cellWidth + gap;
    const height = padding * 2 + rows * cellHeight + (rows - 1) * gap + 42;
    const cards = metrics.map((metric, index) => {
        const col = index % columns;
        const row = Math.floor(index / columns);
        const x = padding + col * (cellWidth + gap);
        const y = 56 + row * (cellHeight + gap);
        return `
            <g>
                <rect
                    x="${x}"
                    y="${y}"
                    width="${cellWidth}"
                    height="${cellHeight}"
                    rx="12"
                    fill="#${theme.background}"
                    stroke="#${theme.border}"
                    stroke-opacity="0.8"
                />
                <rect
                    x="${x + 14}"
                    y="${y + 14}"
                    width="3"
                    height="66"
                    rx="2"
                    fill="url(#stats-accent)"
                />
                <text
                    x="${x + 29}"
                    y="${y + 35}"
                    fill="#${theme.muted}"
                    font-family="${fontFamily()}"
                    font-size="10"
                    font-weight="700"
                    letter-spacing="1.1"
                >${escapeHTML(metric.label)}</text>
                <text
                    x="${x + 29}"
                    y="${y + 68}"
                    fill="#${theme.text}"
                    font-family="${monoFont()}"
                    font-size="25"
                    font-weight="700"
                >${escapeHTML(metric.value)}</text>
                <text
                    x="${x + cellWidth - 17}"
                    y="${y + 28}"
                    text-anchor="end"
                    fill="#${theme.muted}"
                    opacity="0.55"
                    font-family="${monoFont()}"
                    font-size="10"
                >${metric.icon}</text>
            </g>
        `;
    }).join("");
    return [
        svgStart(width, height),
        gradientDefinitions(theme, "stats-accent"),
        cardBackground(theme, width, height),
        `
        <text
            x="22"
            y="34"
            fill="#${theme.text}"
            font-family="${fontFamily()}"
            font-size="15"
            font-weight="700"
        >GitHub Overview</text>
        <text
            x="${width - 22}"
            y="34"
            text-anchor="end"
            fill="#${theme.muted}"
            font-family="${monoFont()}"
            font-size="10"
        >PROFILE / 01</text>
        ${cards}
        `,
        svgEnd()
    ].join("\n");
}
// ============================================================
// SVG: TOP LANGUAGES
// ============================================================
function createTopLanguages(github, config) {
    const theme = getTheme(config);
    const limit = Math.max(
        1,
        Math.min(
            15,
            Number(config.github?.languages?.limit || 8)
        )
    );
    const languages = (github?.languages || [])
        .slice(0, limit);
    if (!languages.length) return null;
    const width = 600;
    const rowHeight = 48;
    const height = 70 + languages.length * rowHeight + 18;
    const palette = [
        theme.accent,
        "A78BFA",
        "34D399",
        "FBBF24",
        "F472B6",
        "22D3EE",
        "FB923C",
        "818CF8",
        "4ADE80",
        "E879F9"
    ];
    const rows = languages.map((language, index) => {
        const y = 73 + index * rowHeight;
        const percentage = Math.max(
            0,
            Math.min(100, language.percentage)
        );
        const barWidth = 340;
        const color = palette[index % palette.length];
        return `
            <g>
                <text
                    x="22"
                    y="${y}"
                    fill="#${theme.text}"
                    font-family="${fontFamily()}"
                    font-size="12"
                    font-weight="600"
                >${escapeHTML(language.name)}</text>
                <text
                    x="${width - 22}"
                    y="${y}"
                    text-anchor="end"
                    fill="#${theme.muted}"
                    font-family="${monoFont()}"
                    font-size="11"
                >${percentage.toFixed(1)}%</text>
                <rect
                    x="22"
                    y="${y + 10}"
                    width="${barWidth}"
                    height="7"
                    rx="4"
                    fill="#${theme.border}"
                />
                <rect
                    x="22"
                    y="${y + 10}"
                    width="${barWidth * percentage / 100}"
                    height="7"
                    rx="4"
                    fill="#${color}"
                />
            </g>
        `;
    }).join("");
    return [
        svgStart(width, height),
        gradientDefinitions(theme, "languages-accent"),
        cardBackground(theme, width, height),
        `
        <text
            x="22"
            y="34"
            fill="#${theme.text}"
            font-family="${fontFamily()}"
            font-size="15"
            font-weight="700"
        >Most Used Languages</text>
        <text
            x="${width - 22}"
            y="34"
            text-anchor="end"
            fill="#${theme.muted}"
            font-family="${monoFont()}"
            font-size="10"
        >LANGUAGE DISTRIBUTION</text>
        ${rows}
        `,
        svgEnd()
    ].join("\n");
}
// ============================================================
// SVG: CONTRIBUTION HEATMAP
// ============================================================
function createContributionGraph(days, config) {
    if (!days?.length) return null;
    const theme = getTheme(config);
    const cell = 11;
    const gap = 3;
    const step = cell + gap;
    const firstDate = new Date(
        `${days[0].date}T00:00:00Z`
    );
    const offset = firstDate.getUTCDay();
    const columns = Math.ceil(
        (offset + days.length) / 7
    );
    const left = 22;
    const top = 56;
    const width = Math.max(
        600,
        left * 2 + columns * step
    );
    const height = 165;
    const max = Math.max(
        1,
        ...days.map(day => day.contributionCount)
    );
    const monthLabels = [];
    const seenMonths = new Set();
    const cells = days.map((day, index) => {
        const date = new Date(
            `${day.date}T00:00:00Z`
        );
        const position = offset + index;
        const column = Math.floor(position / 7);
        const weekday = date.getUTCDay();
        const x = left + column * step;
        const y = top + weekday * step;
        const count = day.contributionCount;
        const intensity = count === 0
            ? 0
            : Math.min(
                1,
                0.25 + (count / max) * 0.75
            );
        const opacity = count === 0
            ? 0.13
            : intensity;
        const monthKey =
            `${date.getUTCFullYear()}-${date.getUTCMonth()}`;
        if (
            date.getUTCDate() <= 7 &&
            !seenMonths.has(monthKey)
        ) {
            seenMonths.add(monthKey);
            monthLabels.push(`
                <text
                    x="${x}"
                    y="45"
                    fill="#${theme.muted}"
                    font-family="${fontFamily()}"
                    font-size="10"
                >${date.toLocaleString("en-US", {
                    month: "short",
                    timeZone: "UTC"
                })}</text>
            `);
        }
        return `
            <rect
                x="${x}"
                y="${y}"
                width="${cell}"
                height="${cell}"
                rx="3"
                fill="#${theme.accent}"
                opacity="${opacity.toFixed(2)}"
            >
                <title>${escapeHTML(day.date)}: ${count} contributions</title>
            </rect>
        `;
    }).join("");
    const weekdays = [
        { label: "Mon", day: 1 },
        { label: "Wed", day: 3 },
        { label: "Fri", day: 5 }
    ].map(item => `
        <text
            x="22"
            y="${top + item.day * step + 9}"
            fill="#${theme.muted}"
            font-family="${fontFamily()}"
            font-size="9"
        >${item.label}</text>
    `).join("");
    return [
        svgStart(width, height),
        gradientDefinitions(theme, "contribution-accent"),
        cardBackground(theme, width, height),
        `
        <text
            x="22"
            y="25"
            fill="#${theme.text}"
            font-family="${fontFamily()}"
            font-size="15"
            font-weight="700"
        >Contribution Activity</text>
        <text
            x="${width - 22}"
            y="25"
            text-anchor="end"
            fill="#${theme.muted}"
            font-family="${monoFont()}"
            font-size="10"
        >LAST 12 MONTHS</text>
        ${monthLabels.join("")}
        ${weekdays}
        ${cells}
        <text
            x="${width - 150}"
            y="${height - 13}"
            fill="#${theme.muted}"
            font-family="${fontFamily()}"
            font-size="9"
        >Less</text>
        ${[0.13, 0.4, 0.6, 0.8, 1].map((opacity, index) => `
            <rect
                x="${width - 112 + index * 17}"
                y="${height - 22}"
                width="11"
                height="11"
                rx="3"
                fill="#${theme.accent}"
                opacity="${opacity}"
            />
        `).join("")}
        <text
            x="${width - 15}"
            y="${height - 13}"
            text-anchor="end"
            fill="#${theme.muted}"
            font-family="${fontFamily()}"
            font-size="9"
        >More</text>
        `,
        svgEnd()
    ].join("\n");
}
// ============================================================
// SVG: CONTRIBUTION STREAK
// ============================================================
function createStreakCard(contributions, config) {
    const theme = getTheme(config);
    const streak = calculateStreak(
        contributions?.days || []
    );
    const metrics = [
        {
            label: "CURRENT STREAK",
            value: streak.current,
            suffix: "DAYS",
            icon: "01"
        },
        {
            label: "LONGEST STREAK",
            value: streak.longest,
            suffix: "DAYS",
            icon: "02"
        },
        {
            label: "TOTAL CONTRIBUTIONS",
            value: contributions?.total ?? 0,
            suffix: "LAST YEAR",
            icon: "03"
        }
    ];
    const width = 600;
    const height = 135;
    const gap = 10;
    const padding = 16;
    const cardWidth = (width - padding * 2 - gap * 2) / 3;
    const cards = metrics.map((metric, index) => {
        const x = padding + index * (cardWidth + gap);
        return `
            <g>
                <rect
                    x="${x}"
                    y="52"
                    width="${cardWidth}"
                    height="67"
                    rx="10"
                    fill="#${theme.background}"
                    stroke="#${theme.border}"
                />
                <text
                    x="${x + 12}"
                    y="70"
                    fill="#${theme.muted}"
                    font-family="${fontFamily()}"
                    font-size="8"
                    font-weight="700"
                    letter-spacing="0.5"
                >${metric.label}</text>
                <text
                    x="${x + 12}"
                    y="99"
                    fill="#${theme.text}"
                    font-family="${monoFont()}"
                    font-size="22"
                    font-weight="700"
                >${escapeHTML(metric.value)}</text>
                <text
                    x="${x + cardWidth - 10}"
                    y="101"
                    text-anchor="end"
                    fill="#${theme.accent}"
                    font-family="${monoFont()}"
                    font-size="8"
                >${metric.suffix}</text>
            </g>
        `;
    }).join("");
    return [
        svgStart(width, height),
        gradientDefinitions(theme, "streak-accent"),
        cardBackground(theme, width, height),
        `
        <text
            x="18"
            y="30"
            fill="#${theme.text}"
            font-family="${fontFamily()}"
            font-size="15"
            font-weight="700"
        >Contribution Streak</text>
        <text
            x="${width - 18}"
            y="30"
            text-anchor="end"
            fill="#${theme.muted}"
            font-family="${monoFont()}"
            font-size="10"
        >ACTIVITY / 01</text>
        ${cards}
        `,
        svgEnd()
    ].join("\n");
}
// ============================================================
// SKILL ICONS
// ============================================================
const SKILL_ICON_ALIASES = {
    javascript: "js",
    typescript: "ts",
    "next.js": "nextjs",
    "tailwind css": "tailwind",
    "node.js": "nodejs",
    "visual studio code": "vscode",
    "vs code": "vscode",
    "c++": "cpp",
    "c#": "cs",
    html: "html",
    css: "css",
    express: "express",
    mongodb: "mongodb",
    firebase: "firebase",
    supabase: "supabase",
    github: "github",
    windows: "windows",
    linux: "linux",
    npm: "npm",
    bun: "bun",
    deno: "deno",
    react: "react",
    vite: "vite",
    git: "git",
    python: "python",
    java: "java",
    php: "php",
    mysql: "mysql",
    postgresql: "postgres",
    redis: "redis",
    docker: "docker",
    figma: "figma"
};
function getSkillIcon(item) {
    return SKILL_ICON_ALIASES[
        String(item).toLowerCase()
    ] || null;
}
function generateSkillIcons(items) {
    const icons = items
        .map(getSkillIcon)
        .filter(Boolean);
    if (!icons.length) {
        return items
            .map(item => `\`${escapeMarkdown(item)}\``)
            .join(" ");
    }
    return `<img src="https://skillicons.dev/icons?i=${icons.join(",")}" alt="${escapeHTML(items.join(", "))}" />`;
}
// ============================================================
// TYPING HEADER
// ============================================================
function generateTypingHeader(profile) {
    const typing = profile.typing || {};
    const output = [];

    // Main Display Name
    if (profile.display_name) {
        output.push(
            `<h1 align="center">${escapeHTML(profile.display_name)}</h1>`
        );
    }

    // Typing Animation
    if (
        enabled(typing.enabled, true) &&
        typing.lines?.length
    ) {
        const lines = typing.lines
            .map(line => encode(line))
            .join(";");

        const color = String(
            typing.color || "FFFFFF"
        ).replace(/^#/, "");

        const url =
            "https://readme-typing-svg.demolab.com/?" +
            "font=Fira+Code" +
            "&weight=500" +
            "&size=22" +
            "&pause=1000" +
            "&color=" + encode(color) +
            "&center=true" +
            "&vCenter=true" +
            "&width=600" +
            "&lines=" + lines;

        output.push(
            `<p align="center"><img src="${url}" alt="Typing Animation" /></p>`
        );
    }

    // Role
    if (profile.role) {
        output.push(
            `<p align="center"><strong>${escapeHTML(profile.role)}</strong></p>`
        );
    }

    // Introduction
    if (profile.intro) {
        output.push(
            `<p align="center">${escapeHTML(profile.intro)}</p>`
        );
    }

    return output.join("\n");
}
// ============================================================
// ABOUT ME
// ============================================================
function generateAbout(config) {
    const about = config.about || {};
    if (!enabled(about.enabled, true)) return "";
    const items = about.items || [];
    if (!items.length) return "";
    return [
        "## 👨‍💻 About Me",
        "",
        ...items.map(item => `- ${item}`)
    ].join("\n");
}
// ============================================================
// TECH STACK
// ============================================================
function generateTechStack(config) {
    const stack = config.tech_stack || {};
    if (!enabled(stack.enabled, true)) return "";
    const output = ["## 🛠️ Tech Stack"];
    for (const category of stack.categories || []) {
        const items = category.items || [];
        if (!items.length) continue;
        output.push("");
        output.push(`### ${escapeHTML(category.title || "Technologies")}`);
        output.push("");
        output.push(
            `<p>${generateSkillIcons(items)}</p>`
        );
    }
    return output.length > 1
        ? output.join("\n")
        : "";
}
// ============================================================
// GITHUB ASSETS + README SECTION
// ============================================================
function generateGithub(config, github, contributions) {
    const settings = config.github || {};
    const statsSettings = settings.stats || {};
    const languageSettings = settings.languages || {};
    const contributionSettings = settings.contributions || {};
    const output = ["## 📊 GitHub Statistics"];
    if (enabled(statsSettings.enabled, true)) {
        const stats = createGithubStats(
            github,
            contributions,
            config
        );
        writeAsset("github-stats.svg", stats);
        output.push("");
        output.push(
            '<p align="center"><img src="./assets/github-stats.svg" width="100%" alt="GitHub Statistics" /></p>'
        );
    } else {
        removeAsset("github-stats.svg");
    }
    if (enabled(languageSettings.enabled, true)) {
        const languages = createTopLanguages(
            github,
            config
        );
        if (languages) {
            writeAsset("top-languages.svg", languages);
            output.push("");
            output.push(
                '<p align="center"><img src="./assets/top-languages.svg" width="100%" alt="Top Languages" /></p>'
            );
        } else {
            removeAsset("top-languages.svg");
        }
    } else {
        removeAsset("top-languages.svg");
    }
    if (enabled(contributionSettings.enabled, true)) {
        if (enabled(contributionSettings.show_graph, true)) {
            const graph = createContributionGraph(
                contributions?.days,
                config
            );
            if (graph) {
                writeAsset("contributions.svg", graph);
                output.push("");
                output.push("### 📈 Contribution Activity");
                output.push("");
                output.push(
                    '<p align="center"><img src="./assets/contributions.svg" width="100%" alt="Contribution Activity" /></p>'
                );
            } else {
                removeAsset("contributions.svg");
            }
        } else {
            removeAsset("contributions.svg");
        }
        if (enabled(contributionSettings.show_streak, true)) {
            const streak = createStreakCard(
                contributions,
                config
            );
            writeAsset("streak.svg", streak);
            output.push("");
            output.push("### 🔥 Contribution Streak");
            output.push("");
            output.push(
                '<p align="center"><img src="./assets/streak.svg" width="100%" alt="Contribution Streak" /></p>'
            );
        } else {
            removeAsset("streak.svg");
        }
        if (
            enabled(contributionSettings.show_total, true) &&
            contributions
        ) {
            output.push("");
            output.push(
                `**Total Contributions:** ${contributions.total.toLocaleString("en-US")}`
            );
        }
    } else {
        removeAsset("contributions.svg");
        removeAsset("streak.svg");
    }
    return output.length > 1
        ? output.join("\n")
        : "";
}
// ============================================================
// DISCORD LANYARD
// ============================================================
function generateDiscord(config) {
    const discord = config.discord || {};

    if (!enabled(discord.enabled, true)) return "";

    if (
        discord.provider !== "lanyard" ||
        !discord.user_id ||
        discord.user_id === "YOUR_DISCORD_USER_ID"
    ) {
        return "";
    }

    const template =
        discord.image_style ||
        "https://lanyard.cnrad.dev/api/{id}?theme=dark";

    const imageUrl = template.replaceAll(
        "{id}",
        encode(discord.user_id)
    );

    const url = new URL(imageUrl);

    // Display Discord global display name.
    if (enabled(discord.show_display_name, true)) {
        url.searchParams.set("showDisplayName", "true");
    }

    // Control Discord activities.
    if (!enabled(discord.show_activity, true)) {
        url.searchParams.set("hideActivity", "true");
    }

    // Control Spotify visibility.
    if (!enabled(discord.show_spotify, true)) {
        url.searchParams.set("hideSpotify", "true");
    } else {
        url.searchParams.delete("hideSpotify");
    }

    return [
        "## 🎮 Discord",
        "",
        `<p align="center">`,
        `<a href="https://discord.com/users/${encode(discord.user_id)}">`,
        `<img src="${escapeHTML(url.toString())}" alt="Discord Presence" />`,
        `</a>`,
        `</p>`
    ].join("\n");
}
// ============================================================
// SOCIAL LINKS
// ============================================================
const SOCIAL_ICONS = {
    github: "github",
    facebook: "facebook",
    discord: "discord",
    gmail: "gmail",
    email: "gmail",
    youtube: "youtube",
    instagram: "instagram",
    twitter: "twitter",
    x: "x",
    linkedin: "linkedin",
    twitch: "twitch"
};
function generateSocials(config) {
    const socials = config.socials || {};
    if (!enabled(socials.enabled, true)) return "";
    const links = (socials.links || [])
        .filter(link => link.label && link.url)
        .map(link => {
            const icon = SOCIAL_ICONS[
                String(link.label).toLowerCase()
            ];
            if (!icon) {
                return `[${escapeMarkdown(link.label)}](${link.url})`;
            }
            return [
                `<a href="${escapeHTML(link.url)}">`,
                `<img src="https://skillicons.dev/icons?i=${icon}" height="42" alt="${escapeHTML(link.label)}" />`,
                "</a>"
            ].join("");
        });
    if (!links.length) return "";
    return [
        "## 🔗 Connect",
        "",
        `<p align="center">${links.join(" ")}</p>`
    ].join("\n");
}
// ============================================================
// FOOTER
// ============================================================
function generateFooter() {
    return [
        '<p align="center">',
        "<i>Code • Learn • Build • Improve</i>",
        "</p>"
    ].join("\n");
}
// ============================================================
// README GENERATOR
// ============================================================
function generateSections(config, github, contributions) {
    const profile = config.profile || {};
    const sections = {
        typing: generateTypingHeader(profile),
        about: generateAbout(config),
        tech_stack: generateTechStack(config),
        github: generateGithub(
            config,
            github,
            contributions
        ),
        discord: generateDiscord(config),
        socials: generateSocials(config),
        footer: generateFooter()
    };
    const order = config.sections?.order || [
        "typing",
        "about",
        "tech_stack",
        "github",
        "discord",
        "socials",
        "footer"
    ];
    const selected = order
        .map(name => {
            if (!(name in sections)) {
                console.warn(
                    `Unknown section in config.yml: ${name}`
                );
                return "";
            }
            return sections[name];
        })
        .filter(Boolean);
    // Always append the footer unless explicitly included.
    if (
        !order.includes("footer") &&
        sections.footer
    ) {
        selected.push(sections.footer);
    }
    return selected.join("\n\n---\n\n");
}
// ============================================================
// README UPDATE
// ============================================================
function updateReadme(content) {
    const existing = fs.existsSync(README_PATH)
        ? fs.readFileSync(README_PATH, "utf8")
        : "";
    const block = [
        START_MARKER,
        "",
        "<!-- Generated automatically. Edit config.yml instead. -->",
        "",
        content,
        "",
        END_MARKER
    ].join("\n");
    const pattern = new RegExp(
        `${escapeRegex(START_MARKER)}[\\s\\S]*?${escapeRegex(END_MARKER)}`
    );
    let output;
    if (
        existing.includes(START_MARKER) &&
        existing.includes(END_MARKER)
    ) {
        output = existing.replace(pattern, block);
    } else {
        output = `${existing.trim()}\n\n${block}\n`;
    }
    fs.writeFileSync(
        README_PATH,
        output,
        "utf8"
    );
}
// ============================================================
// MAIN
// ============================================================
async function main() {
    console.log("==================================");
    console.log(" Modern GitHub Profile Generator");
    console.log("==================================");
    ensureDirectories();
    const config = loadConfig();
    const username =
        config.github?.username ||
        config.profile?.username;
    if (!username) {
        throw new Error(
            "github.username is required."
        );
    }
    const tokenEnv =
        config.github?.token_env || "GITHUB_TOKEN";
    const token = process.env[tokenEnv] || "";
    let github = null;
    let contributions = null;
    console.log(`GitHub user: ${username}`);
    try {
        console.log("[1/3] Fetching GitHub profile...");
        github = await getGithubProfile(
            username,
            token
        );
        console.log("GitHub profile loaded.");
    } catch (error) {
        console.error(
            "GitHub REST API error:",
            error.message
        );
    }
    if (
        enabled(config.github?.contributions?.enabled, true)
    ) {
        try {
            console.log("[2/3] Fetching contributions...");
            contributions = await getContributions(
                username,
                token,
                config.github?.contributions?.include_private
            );
            console.log(
                contributions
                    ? `Contributions: ${contributions.total}`
                    : "Contribution data unavailable."
            );
        } catch (error) {
            console.error(
                "GitHub GraphQL error:",
                error.message
            );
        }
    }
    console.log("[3/3] Generating assets and README...");
    const content = generateSections(
        config,
        github,
        contributions
    );
    updateReadme(content);
    console.log("");
    console.log("Generation completed.");
    console.log(`README: ${README_PATH}`);
    console.log(`Assets: ${ASSETS_PATH}`);
}
main().catch(error => {
    console.error("Generation failed:");
    console.error(error.stack || error.message);
    process.exitCode = 1;
});