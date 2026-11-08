#!/usr/bin/env node
/**
 * GitHub Profile README Generator
 * Node.js 22+
 * ESM
 *
 * npm install js-yaml
 * npm run generate
 */
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
function encode(value) {
    return encodeURIComponent(String(value ?? ""));
}
function getColor(config, key, fallback) {
    return String(
        config.theme?.[key] || fallback
    ).replace(/^#/, "");
}
function center(content) {
    return [
        '<div align="center">',
        content,
        "</div>"
    ].join("\n");
}
function separator() {
    return "\n---\n";
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
    // Limit concurrent requests to reduce API pressure.
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
    for (const repo of repositories) {
        stats.stars += repo.stargazers_count || 0;
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
            result.errors.map(error => error.message).join("; ")
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
// CONTRIBUTION STREAK
// ============================================================
function calculateStreak(days) {
    if (!days?.length) {
        return { current: 0, longest: 0 };
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
    return { current, longest };
}
// ============================================================
// SKILL ICONS
// ============================================================
const SKILL_ICON_ALIASES = {
    "javascript": "js",
    "typescript": "ts",
    "next.js": "nextjs",
    "tailwind css": "tailwind",
    "node.js": "nodejs",
    "visual studio code": "vscode",
    "vs code": "vscode",
    "c++": "cpp",
    "c#": "cs",
    "html": "html",
    "css": "css",
    "express": "express",
    "mongodb": "mongodb",
    "firebase": "firebase",
    "supabase": "supabase",
    "github": "github",
    "windows": "windows",
    "linux": "linux",
    "npm": "npm",
    "bun": "bun",
    "deno": "deno",
    "react": "react",
    "vite": "vite",
    "git": "git",
    "python": "python",
    "java": "java",
    "php": "php",
    "mysql": "mysql",
    "postgresql": "postgres",
    "redis": "redis",
    "docker": "docker",
    "figma": "figma"
};
function getSkillIcon(item) {
    const key = String(item).toLowerCase();
    return SKILL_ICON_ALIASES[key] || null;
}
function generateSkillIcons(items) {
    const icons = items
        .map(getSkillIcon)
        .filter(Boolean);
    if (!icons.length) {
        return items.map(item => `\`${item}\``).join(" ");
    }
    return `<img src="https://skillicons.dev/icons?i=${icons.join(",")}" alt="${escapeHTML(items.join(", "))}" />`;
}
// ============================================================
// TYPING HEADER
// ============================================================
function generateTypingHeader(profile) {
    const typing = profile.typing || {};
    const output = [];
    if (enabled(typing.enabled, true) && typing.lines?.length) {
        const lines = typing.lines
            .map(line => encode(line))
            .join(";");
        const color = String(
            typing.color || "FFFFFF"
        ).replace(/^#/, "");
        const typingURL =
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
            `<p align="center"><img src="${typingURL}" alt="Typing SVG" /></p>`
        );
    } else if (profile.display_name) {
        output.push(
            `<h1 align="center">Hi, I'm ${escapeHTML(profile.display_name)}!</h1>`
        );
    }
    if (profile.role) {
        output.push(
            `<p align="center"><strong>${escapeHTML(profile.role)}</strong></p>`
        );
    }
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
        output.push(`<p>${generateSkillIcons(items)}</p>`);
    }
    return output.length > 1
        ? output.join("\n")
        : "";
}
// ============================================================
// GITHUB STATISTICS
// ============================================================
function generateGithub(config, github, contributions) {
    const settings = config.github || {};
    const username = settings.username || config.profile?.username;
    if (!username) return "";
    const output = ["## 📊 GitHub Statistics"];
    const stats = settings.stats || {};
    if (enabled(stats.enabled, true)) {
        const params = new URLSearchParams({
            username,
            show_icons: "true",
            theme: "transparent",
            hide_border: "true",
            rank_icon: "github"
        });
        const statsURL =
            `https://github-readme-stats.vercel.app/api?${params}`;
        const languageParams = new URLSearchParams({
            username,
            layout: "compact",
            theme: "transparent",
            hide_border: "true"
        });
        const languageURL =
            `https://github-readme-stats.vercel.app/api/top-langs/?${languageParams}`;
        const cards = [];
        if (
            enabled(stats.show_repositories, true) ||
            enabled(stats.show_followers, true) ||
            enabled(stats.show_stars, true)
        ) {
            cards.push(
                `<img src="${statsURL}" height="165" alt="GitHub Statistics" />`
            );
        }
        if (enabled(settings.languages?.enabled, true)) {
            cards.push(
                `<img src="${languageURL}" height="165" alt="Top Languages" />`
            );
        }
        if (cards.length) {
            output.push("");
            output.push(center(cards.join("\n")));
        }
    }
    const contributionSettings =
        settings.contributions || {};
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
        if (enabled(contributionSettings.show_streak, true)) {
            const streak = calculateStreak(
                contributions.days
            );
            output.push("");
            output.push("### 🔥 Contribution Streak");
            output.push("");
            output.push(center(
                `<img src="https://streak-stats.demolab.com?user=${encode(username)}&theme=transparent&hide_border=true" alt="Contribution Streak" />`
            ));
            output.push("");
            output.push(
                `Current streak: **${streak.current} days** · Longest streak: **${streak.longest} days**`
            );
        }
        if (enabled(contributionSettings.show_graph, true)) {
            output.push("");
            output.push("### 📈 Contribution Graph");
            output.push("");
            const graphURL =
                "https://github-readme-activity-graph.vercel.app/graph?" +
                new URLSearchParams({
                    username,
                    theme: "github-compact",
                    hide_border: "true",
                    area: "true"
                });
            output.push(center(
                `<img src="${graphURL}" width="100%" alt="Contribution Activity Graph" />`
            ));
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
        encode(discord.user_id)
    );
    return [
        "## 🎮 Discord",
        "",
        center(
            `<a href="https://discord.com/users/${encode(discord.user_id)}"><img src="${image}" alt="Discord Presence" /></a>`
        )
    ].join("\n");
}
// ============================================================
// SOCIAL LINKS
// ============================================================
const SOCIAL_ICON_ALIASES = {
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
            const icon = SOCIAL_ICON_ALIASES[
                String(link.label).toLowerCase()
            ];
            if (!icon) {
                return `[${escapeHTML(link.label)}](${link.url})`;
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
        center(links.join("\n"))
    ].join("\n");
}
// ============================================================
// FOOTER
// ============================================================
function generateFooter() {
    return center(
        "<i>Code • Learn • Build • Improve</i>"
    );
}
// ============================================================
// README
// ============================================================
function generateSections(config, github, contributions) {
    const profile = config.profile || {};
    const sections = {
        typing: generateTypingHeader(profile),
        about: generateAbout(config),
        tech_stack: generateTechStack(config),
        github: generateGithub(config, github, contributions),
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
    return order
        .map(name => {
            if (!(name in sections)) {
                console.warn(
                    `Unknown section in config.yml: ${name}`
                );
                return "";
            }
            return sections[name];
        })
        .filter(Boolean)
        .join("\n\n---\n\n");
}
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
    fs.writeFileSync(README_PATH, output, "utf8");
}
// ============================================================
// MAIN
// ============================================================
async function main() {
    console.log("GitHub Profile Generator");
    const config = loadConfig();
    const username =
        config.github?.username ||
        config.profile?.username;
    if (!username) {
        throw new Error("github.username is required.");
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