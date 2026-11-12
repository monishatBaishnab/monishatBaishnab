#!/usr/bin/env node
/*
 * Collects a GitHub user's contribution calendar - the rolling last year plus
 * every calendar year since the account was created - and writes it as one
 * compact JSON file.
 *
 * It reads the same public calendar that github.com shows on the profile
 * (including private contributions, when the profile is set to show them), so
 * it needs no token. Used in two places:
 *   - the portfolio's prebuild, writing src/data/github-stats.json
 *   - a scheduled Action in the profile repo, writing github-stats.json there,
 *     which the portfolio fetches at runtime to stay current between deploys
 *
 * Usage: node github-stats.mjs <user> <out.json>
 * Never fails a build: on any error it keeps the existing file (or writes an
 * empty one), prints a warning and exits 0.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const [user = "monishatBaishnab", out = "github-stats.json"] = process.argv.slice(2);
const UA = { "User-Agent": "github-stats-script" };

/** One calendar page: [{ date, count, level }] in date order. */
async function calendar(query = "") {
  const res = await fetch(`https://github.com/users/${user}/contributions${query}`, { headers: UA });
  if (!res.ok) throw new Error(`calendar ${query || "(last year)"}: HTTP ${res.status}`);
  const html = await res.text();

  // counts live in tooltips keyed by the day cell's id
  const counts = new Map();
  for (const [, id, text] of html.matchAll(/<tool-tip[^>]*for="([^"]+)"[^>]*>([^<]*)/g)) {
    const match = text.trim().match(/^([\d,]+|No) contributions?/);
    if (match) counts.set(id, match[1] === "No" ? 0 : Number(match[1].replace(/,/g, "")));
  }

  const days = [];
  for (const [cell] of html.matchAll(/<td[^>]*data-date="[^"]+"[^>]*>/g)) {
    const date = cell.match(/data-date="([^"]+)"/)[1];
    const id = cell.match(/id="([^"]+)"/)?.[1];
    const level = Number(cell.match(/data-level="(\d)"/)?.[1] ?? 0);
    days.push({ date, count: counts.get(id) ?? 0, level });
  }
  if (days.length === 0) throw new Error(`calendar ${query}: no days found - markup changed?`);
  return days.sort((a, b) => a.date.localeCompare(b.date));
}

/** Compact form: first date, then one count and one level per day. */
function pack(days) {
  return {
    start: days[0].date,
    total: days.reduce((sum, day) => sum + day.count, 0),
    counts: days.map((day) => day.count),
    levels: days.map((day) => day.level).join(""),
  };
}

async function main() {
  const profile = await fetch(`https://api.github.com/users/${user}`, { headers: UA });
  if (!profile.ok) throw new Error(`profile: HTTP ${profile.status}`);
  const { created_at: createdAt, login } = await profile.json();

  const firstYear = Number(createdAt.slice(0, 4));
  const thisYear = new Date().getUTCFullYear();
  const years = {};
  for (let year = thisYear; year >= firstYear; year--) {
    const days = await calendar(`?from=${year}-01-01&to=${year}-12-31`);
    years[year] = pack(days.filter((day) => day.date.startsWith(String(year))));
  }

  const data = {
    user: login,
    url: `https://github.com/${login}`,
    joined: createdAt.slice(0, 10),
    fetchedAt: new Date().toISOString(),
    lastYear: pack(await calendar()),
    years,
  };

  mkdirSync(dirname(out) || ".", { recursive: true });
  writeFileSync(out, `${JSON.stringify(data)}\n`);
  console.log(
    `github-stats: ${login}, ${data.lastYear.total} in the last year, ${Object.keys(years).length} years -> ${out}`,
  );
}

main().catch((error) => {
  console.warn(`github-stats: ${error.message}`);
  if (!existsSync(out)) {
    mkdirSync(dirname(out) || ".", { recursive: true });
    writeFileSync(out, "null\n");
    console.warn(`github-stats: wrote an empty ${out}; the section stays hidden until data loads`);
  } else {
    console.warn(`github-stats: kept the existing ${out}`);
  }
});
