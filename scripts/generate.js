#!/usr/bin/env node
"use strict";

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import yaml from "js-yaml";
import { fileURLToPath } from "node:url";

import {
    fetchPresence,
    createDiscordSVG
} from "../web/lanyard-core.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const CONFIG_PATH = path.join(ROOT, "config.yml");
const README_PATH = path.join(ROOT, "README.md");
const ASSETS_DIR = path.join(ROOT, "assets");

const START_MARKER = "<!-- PROFILE-GENERATOR:START -->";
const END_MARKER = "<!-- PROFILE-GENERATOR:END -->";

const DEFAULT_THEME = {
    background: "0D1117",
    card: "161B22",
    text: "E6EDF3",
    muted: "8B949E",
    accent: "58A6FF",
    border: "30363D",
    show_border: true
};

function log(message) {
    console.log(`[Profile Generator] ${message}`);
}

function warn(message) {
    console.warn(`[Warning] ${message}`);
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

function escapeHTML(value) {
    return escapeXML(value);
}

function hex(value, fallback) {
    const result = String(value || fallback).replace(/^#/, "");

    return /^[0-9a-fA-F]{6}$/.test(result)
        ? result
        : fallback;
}

function enabled(value, fallback = true) {
    return value === undefined ? fallback : Boolean(value);
}

function ensureDirectories() {
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
}

function writeAsset(filename, content) {
    const target = path.join(ASSETS_DIR, filename);

    fs.writeFileSync(
        target,
        content.trim() + "\n",
        "utf8"
    );
}

function removeAsset(filename) {
    const target = path.join(ASSETS_DIR, filename);

    if (fs.existsSync(target)) {
        fs.unlinkSync(target);
    }
}

function loadConfig() {
    if (!fs.existsSync(CONFIG_PATH)) {
        throw new Error("config.yml was not found.");
    }

    const config = yaml.load(
        fs.readFileSync(CONFIG_PATH, "utf8")
    );

    if (!config || typeof config !== "object") {
        throw new Error("Invalid config.yml.");
    }

    config.profile ||= {};
    config.github ||= {};
    config.theme ||= {};
    config.discord ||= {};
    config.socials ||= {};
    config.about ||= {};
    config.tech_stack ||= {};
    config.sections ||= {};

    config.theme = {
        ...DEFAULT_THEME,
        ...config.theme
    };

    config.github.username ||= config.profile.username;
    config.profile.username ||= config.github.username;

    return config;
}

function theme(config) {
    const t = config.theme;

    return {
        background: hex(t.background, DEFAULT_THEME.background),
        card: hex(t.card, DEFAULT_THEME.card),
        text: hex(t.text, DEFAULT_THEME.text),
        muted: hex(t.muted, DEFAULT_THEME.muted),
        accent: hex(t.accent, DEFAULT_THEME.accent),
        border: hex(t.border, DEFAULT_THEME.border)
    };
}

async function fetchJSON(url, token) {
    const response = await fetch(url, {
        headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            ...(token
                ? { Authorization: `Bearer ${token}` }
                : {})
        }
    });

    if (!response.ok) {
        const body = await response.text().catch(() => "");

        throw new Error(
            `GitHub API ${response.status}: ${body.slice(0, 180)}`
        );
    }

    return response.json();
}

async function getGithubProfile(username, token) {
    if (!username) {
        throw new Error("GitHub username is missing.");
    }

    const user = await fetchJSON(
        `https://api.github.com/users/${encodeURIComponent(username)}`,
        token
    );

    const repositories = [];

    for (let page = 1; page <= 3; page++) {
        const items = await fetchJSON(
            `https://api.github.com/users/${encodeURIComponent(username)}/repos?per_page=100&page=${page}&type=owner`,
            token
        );

        if (!Array.isArray(items) || items.length === 0) {
            break;
        }

        repositories.push(...items);

        if (items.length < 100) {
            break;
        }
    }

    const languages = {};

    for (let i = 0; i < repositories.length; i += 8) {
        const batch = repositories.slice(i, i + 8);

        const results = await Promise.all(
            batch.map(async repo => {
                try {
                    return await fetchJSON(repo.languages_url, token);
                } catch {
                    return {};
                }
            })
        );

        for (const result of results) {
            for (const [name, bytes] of Object.entries(result)) {
                languages[name] = (languages[name] || 0) + bytes;
            }
        }
    }

    const stars = repositories.reduce(
        (total, repo) => total + (repo.stargazers_count || 0),
        0
    );

    return {
        user,
        repositories,
        followers: user.followers || 0,
        stars,
        languages
    };
}

async function getContributions(username, token, includePrivate = false) {
    if (!token) {
        warn("GITHUB_TOKEN is missing. Contributions will be unavailable.");
        return null;
    }

    const query = `
        query(
            $username: String!,
            $from: DateTime!,
            $to: DateTime!,
            $includePrivate: Boolean!
        ) {
            user(login: $username) {
                contributionsCollection(
                    from: $from
                    to: $to
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

    from.setUTCFullYear(from.getUTCFullYear() - 1);
    from.setUTCHours(0, 0, 0, 0);

    const response = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            query,
            variables: {
                username,
                from: from.toISOString(),
                to: now.toISOString(),
                includePrivate
            }
        })
    });

    if (!response.ok) {
        throw new Error(
            `GitHub GraphQL error: ${response.status}`
        );
    }

    const result = await response.json();

    if (result.errors?.length) {
        throw new Error(result.errors[0].message);
    }

    const calendar =
        result.data?.user?.contributionsCollection?.contributionCalendar;

    if (!calendar) {
        return null;
    }

    const days = calendar.weeks.flatMap(
        week => week.contributionDays
    );

    return {
        total: calendar.totalContributions || 0,
        days
    };
}

function calculateStreak(days = []) {
    if (!days.length) {
        return { current: 0, longest: 0 };
    }

    const active = new Set(
        days
            .filter(day => day.contributionCount > 0)
            .map(day => day.date)
    );

    let longest = 0;
    let run = 0;

    for (const day of days) {
        if (active.has(day.date)) {
            run++;
            longest = Math.max(longest, run);
        } else {
            run = 0;
        }
    }

    const today = new Date().toISOString().slice(0, 10);

    const yesterdayDate = new Date();
    yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);

    const yesterday = yesterdayDate.toISOString().slice(0, 10);

    let cursor = active.has(today) ? today : yesterday;
    let current = 0;

    while (active.has(cursor)) {
        current++;

        const date = new Date(`${cursor}T00:00:00Z`);
        date.setUTCDate(date.getUTCDate() - 1);

        cursor = date.toISOString().slice(0, 10);
    }

    return { current, longest };
}

function svgShell(width, height, config, content) {
    const t = theme(config);

    const border = config.theme.show_border
        ? `stroke="#${t.border}" stroke-width="1"`
        : "";

    return `
<svg xmlns="http://www.w3.org/2000/svg"
     width="${width}"
     height="${height}"
     viewBox="0 0 ${width} ${height}">
    <rect width="${width}"
          height="${height}"
          rx="14"
          fill="#${t.background}"
          ${border}/>
    ${content}
</svg>
`;
}

function createGithubStats(github, contributions, config) {
    const t = theme(config);
    const stats = config.github.stats || {};
    const items = [];

    if (enabled(stats.show_repositories)) {
        items.push({
            label: "Repositories",
            value: github.repositories.length,
            icon: "⌘"
        });
    }

    if (enabled(stats.show_followers)) {
        items.push({
            label: "Followers",
            value: github.followers,
            icon: "◎"
        });
    }

    if (enabled(stats.show_stars)) {
        items.push({
            label: "Total Stars",
            value: github.stars,
            icon: "☆"
        });
    }

    if (
        contributions &&
        enabled(config.github.contributions?.show_total)
    ) {
        items.push({
            label: "Contributions",
            value: contributions.total,
            icon: "▦"
        });
    }

    const width = 560;
    const height = 112;
    const gap = 10;
    const cardWidth = (
        width - 36 - gap * (items.length - 1)
    ) / Math.max(items.length, 1);

    const cards = items.map((item, index) => {
        const x = 18 + index * (cardWidth + gap);

        return `
            <rect x="${x}" y="17"
                  width="${cardWidth}" height="78"
                  rx="11"
                  fill="#${t.card}"
                  stroke="#${t.border}"/>

            <text x="${x + 16}" y="43"
                  font-size="17"
                  fill="#${t.accent}"
                  font-family="Arial">${escapeXML(item.icon)}</text>

            <text x="${x + 43}" y="43"
                  font-size="19"
                  font-weight="700"
                  fill="#${t.text}"
                  font-family="Arial">${escapeXML(item.value)}</text>

            <text x="${x + 16}" y="72"
                  font-size="10"
                  fill="#${t.muted}"
                  font-family="Arial">${escapeXML(item.label)}</text>
        `;
    }).join("");

    return svgShell(width, height, config, cards);
}

function createTopLanguages(github, config) {
    const t = theme(config);

    const limit = Math.max(
        1,
        Number(config.github.languages?.limit) || 8
    );

    const languages = Object.entries(github.languages)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit);

    const total = languages.reduce(
        (sum, item) => sum + item[1],
        0
    ) || 1;

    const palette = [
        "#58A6FF",
        "#A371F7",
        "#3FB950",
        "#D29922",
        "#F778BA",
        "#79C0FF",
        "#FFA657",
        "#56D4DD"
    ];

    let offset = 0;

    const bars = languages.map(([name, bytes], index) => {
        const percent = bytes / total * 100;
        const barWidth = 520 * percent / 100;
        const x = 20 + offset;

        offset += barWidth;

        return `
            <rect x="${x}" y="19"
                  width="${barWidth}" height="9"
                  fill="${palette[index % palette.length]}"/>
        `;
    }).join("");

    const rows = languages.map(([name, bytes], index) => {
        const percent = (bytes / total * 100).toFixed(1);
        const y = 57 + Math.floor(index / 2) * 27;
        const x = index % 2 === 0 ? 22 : 286;

        return `
            <circle cx="${x}" cy="${y - 4}" r="4"
                    fill="${palette[index % palette.length]}"/>

            <text x="${x + 12}" y="${y}"
                  fill="#${t.text}"
                  font-size="11"
                  font-family="Arial">${escapeXML(name)}</text>

            <text x="${x + 245}" y="${y}"
                  fill="#${t.muted}"
                  font-size="10"
                  text-anchor="end"
                  font-family="Arial">${percent}%</text>
        `;
    }).join("");

    const height = 75 + Math.ceil(languages.length / 2) * 27;

    return svgShell(560, height, config, `
        <text x="20" y="13"
              fill="#${t.muted}"
              font-size="9"
              font-family="Arial">MOST USED LANGUAGES</text>

        <clipPath id="languageBar">
            <rect x="20" y="19"
                  width="520" height="9"
                  rx="4"/>
        </clipPath>

        <g clip-path="url(#languageBar)">
            ${bars}
        </g>

        ${rows}
    `);
}

function createContributionGraph(days, config) {
    const t = theme(config);

    const cell = 10;
    const gap = 3;
    const startX = 22;
    const startY = 38;

    const max = Math.max(
        1,
        ...days.map(day => day.contributionCount)
    );

    const cells = days.map((day, index) => {
        const date = new Date(`${day.date}T00:00:00Z`);
        const week = Math.floor(index / 7);
        const weekday = date.getUTCDay();

        const x = startX + week * (cell + gap);
        const y = startY + weekday * (cell + gap);

        const count = day.contributionCount;
        const ratio = count / max;

        let fill = `#${t.card}`;

        if (count > 0) {
            fill = ratio > 0.75
                ? "#1F6FEB"
                : ratio > 0.5
                    ? "#388BFD"
                    : ratio > 0.25
                        ? "#58A6FF"
                        : "#A5D6FF";
        }

        return `
            <rect x="${x}" y="${y}"
                  width="${cell}" height="${cell}"
                  rx="2"
                  fill="${fill}">
                <title>${escapeXML(day.date)}: ${count} contributions</title>
            </rect>
        `;
    }).join("");

    const width = Math.max(
        560,
        startX * 2 + 53 * (cell + gap)
    );

    return svgShell(width, 140, config, `
        <text x="20" y="20"
              fill="#${t.text}"
              font-size="12"
              font-weight="600"
              font-family="Arial">Contribution Activity</text>

        ${cells}

        <text x="20" y="130"
              fill="#${t.muted}"
              font-size="9"
              font-family="Arial">Less</text>

        <rect x="48" y="122" width="9" height="9"
              rx="2" fill="#${t.card}"/>
        <rect x="61" y="122" width="9" height="9"
              rx="2" fill="#A5D6FF"/>
        <rect x="74" y="122" width="9" height="9"
              rx="2" fill="#58A6FF"/>
        <rect x="87" y="122" width="9" height="9"
              rx="2" fill="#388BFD"/>
        <rect x="100" y="122" width="9" height="9"
              rx="2" fill="#1F6FEB"/>

        <text x="117" y="130"
              fill="#${t.muted}"
              font-size="9"
              font-family="Arial">More</text>
    `);
}

function createStreakCard(contributions, config) {
    const t = theme(config);
    const streak = calculateStreak(contributions?.days || []);

    return svgShell(560, 112, config, `
        <rect x="288" y="17"
              width="254" height="78"
              rx="11"
              fill="#${t.card}"
              stroke="#${t.border}"/>

        <text x="36" y="43"
              fill="#${t.accent}"
              font-size="11"
              font-family="Arial">CURRENT STREAK</text>

        <text x="36" y="76"
              fill="#${t.text}"
              font-size="26"
              font-weight="700"
              font-family="Arial">${streak.current} days</text>

        <text x="306" y="43"
              fill="#${t.accent}"
              font-size="11"
              font-family="Arial">LONGEST STREAK</text>

        <text x="306" y="76"
              fill="#${t.text}"
              font-size="26"
              font-weight="700"
              font-family="Arial">${streak.longest} days</text>
    `);
}

const SKILL_ICON_ALIASES = {
    JavaScript: "js",
    TypeScript: "ts",
    "C++": "cpp",
    C: "c",
    HTML: "html",
    CSS: "css",
    React: "react",
    "Next.js": "nextjs",
    "Tailwind CSS": "tailwind",
    Vite: "vite",
    "Node.js": "nodejs",
    Express: "express",
    Bun: "bun",
    Supabase: "supabase",
    MongoDB: "mongodb",
    Firebase: "firebase",
    Git: "git",
    GitHub: "github",
    "VS Code": "vscode",
    Windows: "windows",
    Linux: "linux"
};

function generateSkillIcons(items) {
    const icons = items
        .map(item => SKILL_ICON_ALIASES[item])
        .filter(Boolean);

    if (!icons.length) {
        return "";
    }

    return `
        <img
            src="https://skillicons.dev/icons?i=${icons.join(",")}&theme=dark"
            alt="${escapeHTML(items.join(", "))}"
        />
    `;
}

function generateProfileHeader(profile) {
    const name = profile.display_name || profile.username || "Developer";
    const role = profile.role || "";

    return `
<h1 align="center">${escapeHTML(name)}</h1>
${role ? `<p align="center"><strong>${escapeHTML(role)}</strong></p>` : ""}
`;
}

function generateTypingHeader(profile) {
    const typing = profile.typing || {};

    if (!enabled(typing.enabled) || !typing.lines?.length) {
        return "";
    }

    const lines = typing.lines
        .map(line => encodeURIComponent(line))
        .join(";");

    const color = hex(typing.color, "58A6FF");

    return `
<p align="center">
    <img
        src="https://readme-typing-svg.demolab.com?font=JetBrains+Mono&weight=500&size=19&pause=1000&color=${color}&center=true&vCenter=true&width=650&lines=${lines}"
        alt="Typing introduction"
    />
</p>
`;
}

function generateAbout(config) {
    if (!enabled(config.about.enabled)) {
        return "";
    }

    const items = config.about.items || [];

    return `
## About Me

${items.map(item => `- ${item}`).join("\n")}
`;
}

function generateTechStack(config) {
    if (!enabled(config.tech_stack.enabled)) {
        return "";
    }

    const categories = config.tech_stack.categories || [];

    const output = categories.map(category => `
### ${escapeHTML(category.title)}

<p>
    ${generateSkillIcons(category.items || [])}
</p>
`).join("\n");

    return `
## Tech Stack

${output}
`;
}

function generateGithub(config, github, contributions) {
    const settings = config.github;

    if (!enabled(settings.stats?.enabled)) {
        removeAsset("github-stats.svg");
    } else {
        writeAsset(
            "github-stats.svg",
            createGithubStats(github, contributions, config)
        );
    }

    if (!enabled(settings.languages?.enabled)) {
        removeAsset("top-languages.svg");
    } else {
        writeAsset(
            "top-languages.svg",
            createTopLanguages(github, config)
        );
    }

    if (!enabled(settings.contributions?.enabled) || !contributions) {
        removeAsset("contributions.svg");
        removeAsset("streak.svg");
    } else {
        if (enabled(settings.contributions.show_graph)) {
            writeAsset(
                "contributions.svg",
                createContributionGraph(contributions.days, config)
            );
        } else {
            removeAsset("contributions.svg");
        }

        if (enabled(settings.contributions.show_streak)) {
            writeAsset(
                "streak.svg",
                createStreakCard(contributions, config)
            );
        } else {
            removeAsset("streak.svg");
        }
    }

    const output = [];

    if (enabled(settings.stats?.enabled)) {
        output.push(`
<p align="center">
    <img src="./assets/github-stats.svg" alt="GitHub Statistics"/>
</p>
`);
    }

    if (enabled(settings.languages?.enabled)) {
        output.push(`
<p align="center">
    <img src="./assets/top-languages.svg" alt="Top Languages"/>
</p>
`);
    }

    if (enabled(settings.contributions?.enabled) && contributions) {
        if (enabled(settings.contributions.show_graph)) {
            output.push(`
<p align="center">
    <img src="./assets/contributions.svg" alt="Contribution Graph"/>
</p>
`);
        }

        if (enabled(settings.contributions.show_streak)) {
            output.push(`
<p align="center">
    <img src="./assets/streak.svg" alt="Contribution Streak"/>
</p>
`);
        }
    }

    return `
## GitHub Analytics

${output.join("\n")}
`;
}

async function generateDiscord(config, presence) {
    const discord = config.discord;

    if (!enabled(discord.enabled)) {
        removeAsset("discord.svg");
        return "";
    }

    const ui = discord.ui || {};

    if (!enabled(ui.enabled)) {
        removeAsset("discord.svg");
        return "";
    }

    const svg = createDiscordSVG(presence, {
        theme: theme(config),
        show_avatar: ui.show_avatar,
        show_display_name: ui.show_display_name,
        show_username: ui.show_username,
        show_status: ui.show_status,
        show_activity: enabled(discord.show_activity),
        show_spotify: enabled(discord.show_spotify),
        show_timestamp: ui.show_timestamp,
        show_progress: ui.show_progress
    });

    writeAsset("discord.svg", svg);

    return `
## Discord Presence

<p align="center">
    <img src="./assets/discord.svg" alt="Discord Presence"/>
</p>
`;
}

function generateSocials(config) {
    if (!enabled(config.socials.enabled)) {
        return "";
    }

    const links = config.socials.links || [];

    const items = links.map(link => {
        const label = escapeHTML(link.label);
        const url = String(link.url || "");

        if (!/^https:\/\/|^mailto:/.test(url)) {
            warn(`Skipped invalid social URL: ${label}`);
            return "";
        }

        return `<a href="${escapeHTML(url)}">${label}</a>`;
    }).filter(Boolean);

    return `
## Connect With Me

<p align="center">
    ${items.join(" &nbsp; • &nbsp; ")}
</p>
`;
}

function generateFooter() {
    return `
<p align="center">
    <sub>Generated automatically with GitHub Actions.</sub>
</p>
`;
}

async function generateSections(config, github, contributions, presence) {
    const generators = {
        typing: () => generateTypingHeader(config.profile),
        about: () => generateAbout(config),
        tech_stack: () => generateTechStack(config),
        github: () => generateGithub(config, github, contributions),
        discord: () => generateDiscord(config, presence),
        socials: () => generateSocials(config)
    };

    const order = Array.isArray(config.sections.order)
        ? config.sections.order
        : [
            "typing",
            "about",
            "tech_stack",
            "github",
            "discord",
            "socials"
        ];

    const output = [
        generateProfileHeader(config.profile)
    ];

    for (const section of order) {
        const generator = generators[section];

        if (!generator) {
            warn(`Unknown section: ${section}`);
            continue;
        }

        const content = await generator();

        if (content) {
            output.push(content);
        }
    }

    output.push(generateFooter());

    return output.join("\n");
}

function updateReadme(content) {
    const generated = `${START_MARKER}\n${content}\n${END_MARKER}`;

    if (!fs.existsSync(README_PATH)) {
        fs.writeFileSync(
            README_PATH,
            `${generated}\n`,
            "utf8"
        );

        return;
    }

    const current = fs.readFileSync(README_PATH, "utf8");

    const start = current.indexOf(START_MARKER);
    const end = current.indexOf(END_MARKER);

    if (start !== -1 && end !== -1 && end > start) {
        const before = current.slice(0, start);
        const after = current.slice(end + END_MARKER.length);

        fs.writeFileSync(
            README_PATH,
            `${before}${generated}${after}`,
            "utf8"
        );
    } else {
        const separator = current.trim()
            ? `${current.trim()}\n\n`
            : "";

        fs.writeFileSync(
            README_PATH,
            `${separator}${generated}\n`,
            "utf8"
        );
    }
}

async function main() {
    log("Starting...");

    ensureDirectories();

    const config = loadConfig();

    const username = config.github.username;
    const tokenName = config.github.token_env || "GITHUB_TOKEN";
    const token = process.env[tokenName];

    if (!username) {
        throw new Error("github.username is missing in config.yml.");
    }

    if (!token) {
        warn(`${tokenName} is not configured. Public GitHub data only.`);
    }

    log(`Loading GitHub profile: ${username}`);

    const github = await getGithubProfile(username, token);

    let contributions = null;

    if (enabled(config.github.contributions?.enabled)) {
        try {
            contributions = await getContributions(
                username,
                token,
                enabled(
                    config.github.contributions?.include_private,
                    false
                )
            );
        } catch (error) {
            warn(`Contributions unavailable: ${error.message}`);
        }
    }

    let presence = null;

    if (enabled(config.discord.enabled)) {
        try {
            log("Fetching Discord presence...");

            presence = await fetchPresence(config.discord.user_id);
        } catch (error) {
            warn(`Discord unavailable: ${error.message}`);
        }
    }

    const content = await generateSections(
        config,
        github,
        contributions,
        presence
    );

    updateReadme(content);

    log("README updated successfully.");
}

main().catch(error => {
    console.error("\n[Generator Error]", error);
    process.exitCode = 1;
});