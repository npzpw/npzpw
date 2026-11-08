#!/usr/bin/env node
"use strict";
/**
 * GitHub Profile README Generator
 *
 * Node.js 22+
 * npm dependency: js-yaml
 *
 * Run:
 * npm install
 * npm run generate
 */
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import process from "node:process";
// ============================================================
// PATHS
// ============================================================
const ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "config.yml");
const README_PATH = path.join(ROOT, "README.md");
const ASSETS_PATH = path.join(ROOT, "assets");
const START_MARKER = "<!-- PROFILE-GENERATOR:START -->";
const END_MARKER = "<!-- PROFILE-GENERATOR:END -->";
// ============================================================
// CONFIG
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
        character => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&apos;"
        })[character]
    );
}
function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function getColor(config, key, fallback) {
    return String(config.theme?.[key] || fallback).replace(/^#/, "");
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
// ============================================================
// HTTP
// ============================================================
async function fetchJSON(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: {
            "User-Agent": "GitHub-Profile-Generator",
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
// GITHUB REST API
// ============================================================
async function getGithubProfile(username, token) {
    const headers = token
        ? { Authorization: `Bearer ${token}` }
        : {};
    const user = await fetchJSON(
        `https://api.github.com/users/${encodeURIComponent(username)}`,
        { headers }
    );
    const repositories = [];
    for (let page = 1; page <= 3; page++) {
        const items = await fetchJSON(
            `https://api.github.com/users/${encodeURIComponent(username)}/repos?per_page=100&page=${page}&type=owner`,
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
        if (repo.fork) continue;
        try {
            const data = await fetchJSON(
                repo.languages_url,
                { headers }
            );
            for (const [name, bytes] of Object.entries(data)) {
                languages[name] = (languages[name] || 0) + bytes;
            }
        } catch (error) {
            console.warn(
                `Skipping language data: ${repo.full_name}`
            );
        }
    }
    const totalBytes = Object.values(languages)
        .reduce((sum, bytes) => sum + bytes, 0);
    const languageList = Object.entries(languages)
        .map(([name, bytes]) => ({
            name,
            percentage: totalBytes
                ? (bytes / totalBytes) * 100
                : 0
        }))
        .sort((a, b) => b.percentage - a.percentage);
    return {
        ...stats,
        languages: languageList
    };
}
// ============================================================
// GITHUB CONTRIBUTIONS GRAPHQL
// ============================================================
async function getContributions(username, token, includePrivate) {
    if (!token) {
        console.warn("GITHUB_TOKEN is missing.");
        return null;
    }
    const query = `
        query($login: String!, $from: DateTime!, $to: DateTime!) {
            user(login: $login) {
                contributionsCollection(
                    from: $from,
                    to: $to
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
                    to: now.toISOString()
                }
            })
        }
    );
    if (result.errors?.length) {
        throw new Error(
            result.errors.map(error => error.message).join("; ")
        );
    }
    const calendar =
        result.data?.user?.contributionsCollection?.contributionCalendar;
    if (!calendar) return null;
    const days = calendar.weeks.flatMap(
        week => week.contributionDays
    );
    return {
        total: calendar.totalContributions,
        days,
        includePrivate
    };
}
// ============================================================
// CONTRIBUTION STREAK
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
    const today = new Date();
    const todayString = today.toISOString().slice(0, 10);
    // Ignore today if it has not yet received contributions.
    if (
        days[index].date === todayString &&
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
    return { current, longest };
}
// ============================================================
// SVG GENERATOR
// ============================================================
function createCard(title, rows, config) {
    const background = getColor(config, "card", "161B22");
    const text = getColor(config, "text", "E6EDF3");
    const muted = getColor(config, "muted", "8B949E");
    const accent = getColor(config, "accent", "58A6FF");
    const border = getColor(config, "border", "30363D");
    const showBorder = enabled(
        config.theme?.show_border,
        true
    );
    const rowHeight = 29;
    const height = 55 + rows.length * rowHeight;
    const rowContent = rows.map((row, index) => {
        const y = 58 + index * rowHeight;
        return `
            <text x="22" y="${y}" fill="#${muted}" font-size="13">
                ${escapeHTML(row.label)}
            </text>
            <text x="478" y="${y}" text-anchor="end"
                  fill="#${text}" font-size="13" font-weight="600">
                ${escapeHTML(row.value)}
            </text>
        `;
    }).join("");
    return `
<svg xmlns="http://www.w3.org/2000/svg"
     width="500"
     height="${height}"
     viewBox="0 0 500 ${height}">
    <rect width="500" height="${height}" rx="12"
          fill="#${background}"
          ${showBorder ? `stroke="#${border}"` : ""}/>
    <rect x="0" y="0" width="4" height="${height}"
          rx="2" fill="#${accent}"/>
    <text x="22" y="30"
          fill="#${text}"
          font-size="16"
          font-weight="700">
        ${escapeHTML(title)}
    </text>
    ${rowContent}
</svg>
`.trim();
}
// ============================================================
// CONTRIBUTION GRAPH
// ============================================================
function createContributionGraph(days, config) {
    if (!days?.length) return null;
    const accent = getColor(config, "accent", "58A6FF");
    const background = getColor(config, "background", "0D1117");
    const cell = 11;
    const gap = 3;
    const firstDate = new Date(`${days[0].date}T00:00:00Z`);
    const offset = firstDate.getUTCDay();
    const columns = Math.ceil((offset + days.length) / 7);
    const width = 24 + columns * (cell + gap);
    const height = 125;
    const max = Math.max(
        1,
        ...days.map(day => day.contributionCount)
    );
    const rectangles = days.map((day, index) => {
        const date = new Date(`${day.date}T00:00:00Z`);
        const position = offset + index;
        const x = 12 + Math.floor(position / 7) * (cell + gap);
        const y = 30 + date.getUTCDay() * (cell + gap);
        const count = day.contributionCount;
        const opacity = count === 0
            ? 0.12
            : 0.25 + (count / max) * 0.75;
        return `
            <rect x="${x}" y="${y}"
                  width="${cell}" height="${cell}"
                  rx="2" fill="#${accent}"
                  opacity="${opacity.toFixed(2)}">
                <title>${escapeHTML(day.date)}: ${count} contributions</title>
            </rect>
        `;
    }).join("");
    return `
<svg xmlns="http://www.w3.org/2000/svg"
     width="${width}"
     height="${height}"
     viewBox="0 0 ${width} ${height}">
    <rect width="100%" height="100%" rx="10"
          fill="#${background}"/>
    <text x="12" y="18"
          fill="#${getColor(config, "text", "E6EDF3")}"
          font-size="12" font-weight="600">
        Contribution Activity
    </text>
    ${rectangles}
</svg>
`.trim();
}
// ============================================================
// PROFILE SECTIONS
// ============================================================
function generateTyping(profile) {
    const typing = profile.typing || {};
    if (!enabled(typing.enabled, false)) return "";
    const lines = typing.lines || [];
    if (!lines.length) return "";
    const color = String(
        typing.color || "58A6FF"
    ).replace(/^#/, "");
    return `
<p>
    <strong style="color:#${escapeHTML(color)}">
        ${lines.map(escapeHTML).join(" • ")}
    </strong>
</p>
`.trim();
}
function generateAbout(config) {
    const about = config.about || {};
    if (!enabled(about.enabled, true)) return "";
    const items = about.items || [];
    if (!items.length) return "";
    return [
        "## About Me",
        "",
        ...items.map(item => `- ${item}`)
    ].join("\n");
}
function generateTechStack(config) {
    const stack = config.tech_stack || {};
    if (!enabled(stack.enabled, true)) return "";
    const categories = stack.categories || [];
    const output = ["## Tech Stack"];
    for (const category of categories) {
        const items = category.items || [];
        if (!items.length) continue;
        output.push("");
        output.push(`**${category.title || "Technologies"}**`);
        output.push("");
        output.push(
            items.map(item => `\`${escapeHTML(item)}\``).join(" ")
        );
    }
    return output.join("\n");
}
function generateGithub(config, github, contributions) {
    const settings = config.github || {};
    const output = ["## GitHub"];
    if (enabled(settings.stats?.enabled, true)) {
        const rows = [];
        if (enabled(settings.stats.show_repositories, true)) {
            rows.push({
                label: "Public Repositories",
                value: github?.repositories ?? "Unavailable"
            });
        }
        if (enabled(settings.stats.show_followers, true)) {
            rows.push({
                label: "Followers",
                value: github?.followers ?? "Unavailable"
            });
        }
        if (enabled(settings.stats.show_stars, true)) {
            rows.push({
                label: "Total Stars",
                value: github?.stars ?? "Unavailable"
            });
        }
        if (rows.length) {
            writeAsset(
                "github-stats.svg",
                createCard("GitHub Overview", rows, config)
            );
            output.push("");
            output.push(
                '<img src="./assets/github-stats.svg" alt="GitHub Stats" />'
            );
        }
    }
    if (enabled(settings.languages?.enabled, true)) {
        const limit = Math.max(
            1,
            Number(settings.languages.limit || 8)
        );
        const languages = (github?.languages || [])
            .slice(0, limit)
            .map(item => ({
                label: item.name,
                value: `${item.percentage.toFixed(1)}%`
            }));
        if (languages.length) {
            writeAsset(
                "top-languages.svg",
                createCard("Top Languages", languages, config)
            );
            output.push("");
            output.push(
                '<img src="./assets/top-languages.svg" alt="Top Languages" />'
            );
        }
    }
    const contributionSettings = settings.contributions || {};
    if (
        enabled(contributionSettings.enabled, true) &&
        contributions
    ) {
        if (enabled(contributionSettings.show_total, true)) {
            output.push("");
            output.push(
                `**Total Contributions:** ${contributions.total}`
            );
        }
        if (enabled(contributionSettings.show_graph, true)) {
            const graph = createContributionGraph(
                contributions.days,
                config
            );
            if (graph) {
                writeAsset("contributions.svg", graph);
                output.push("");
                output.push(
                    '<img src="./assets/contributions.svg" alt="Contribution Graph" />'
                );
            }
        }
        if (enabled(contributionSettings.show_streak, true)) {
            const streak = calculateStreak(
                contributions.days
            );
            output.push("");
            output.push(
                `**Current Streak:** ${streak.current} days`
            );
            output.push(
                `**Longest Streak:** ${streak.longest} days`
            );
        }
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
    const imageTemplate =
        discord.image_style ||
        "https://lanyard.cnrad.dev/api/{id}?theme=dark";
    const image = imageTemplate.replaceAll(
        "{id}",
        encodeURIComponent(discord.user_id)
    );
    return [
        "## Discord",
        "",
        `[![Discord Presence](${image})](https://discord.com/users/${encodeURIComponent(discord.user_id)})`
    ].join("\n");
}
// ============================================================
// SOCIAL LINKS
// ============================================================
function generateSocials(config) {
    const socials = config.socials || {};
    if (!enabled(socials.enabled, true)) return "";
    const links = (socials.links || [])
        .filter(link => link.label && link.url)
        .map(link => `[${link.label}](${link.url})`);
    if (!links.length) return "";
    return [
        "## Connect",
        "",
        links.join(" · ")
    ].join("\n");
}
// ============================================================
// README
// ============================================================
function generateSections(config, github, contributions) {
    const profile = config.profile || {};
    const displayName =
        profile.display_name ||
        profile.username ||
        "GitHub Profile";
    const sections = {
        typing: [
            `<div align="center">`,
            `<h1>${escapeHTML(displayName)}</h1>`,
            profile.role
                ? `<h3>${escapeHTML(profile.role)}</h3>`
                : "",
            profile.intro
                ? `<p>${escapeHTML(profile.intro)}</p>`
                : "",
            generateTyping(profile),
            `</div>`
        ].filter(Boolean).join("\n"),
        about: generateAbout(config),
        tech_stack: generateTechStack(config),
        github: generateGithub(
            config,
            github,
            contributions
        ),
        discord: generateDiscord(config),
        socials: generateSocials(config)
    };
    const order = config.sections?.order || [
        "typing",
        "about",
        "tech_stack",
        "github",
        "discord",
        "socials"
    ];
    return order
        .map(name => {
            if (!sections[name]) {
                console.warn(
                    `Unknown section in config.yml: ${name}`
                );
            }
            return sections[name] || "";
        })
        .filter(Boolean)
        .join("\n\n");
}
function updateReadme(content) {
    const existing = fs.existsSync(README_PATH)
        ? fs.readFileSync(README_PATH, "utf8")
        : "";
    const block = [
        START_MARKER,
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
    console.log("GitHub Profile Generator");
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
    console.log(`GitHub: ${username}`);
    try {
        console.log("Fetching GitHub profile...");
        github = await getGithubProfile(
            username,
            token
        );
        console.log("GitHub profile loaded.");
    } catch (error) {
        console.error(
            "GitHub REST API:",
            error.message
        );
    }
    if (
        enabled(config.github?.contributions?.enabled, true)
    ) {
        try {
            console.log("Fetching contributions...");
            contributions = await getContributions(
                username,
                token,
                config.github.contributions.include_private
            );
            console.log(
                contributions
                    ? `Contributions: ${contributions.total}`
                    : "Contribution data unavailable."
            );
        } catch (error) {
            console.error(
                "GitHub GraphQL:",
                error.message
            );
        }
    }
    console.log("Generating README...");
    const content = generateSections(
        config,
        github,
        contributions
    );
    updateReadme(content);
    console.log("README updated successfully.");
}
main().catch(error => {
    console.error("Generation failed:");
    console.error(error.stack || error.message);
    process.exitCode = 1;
});