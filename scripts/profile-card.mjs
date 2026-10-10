// Generates assets/profile-details.svg: a copy of the github-profile-summary-cards
// "profile-details" card (github_dark theme) whose yearly chart is split into
// hand-written commits vs. commits made with Claude Code.
//
// A commit counts as "Claude Code" when its message carries the attribution Claude Code adds
// by default: a `Co-Authored-By: Claude ... <noreply@anthropic.com>` trailer or the
// "Generated with [Claude Code]" line. Everything else counts as hand-written.
//
// Usage: GH_TOKEN=<classic PAT with `repo` scope> node scripts/profile-card.mjs
// Zero dependencies; needs Node 18+.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const OUT_FILE = process.env.OUT_FILE || 'assets/profile-details.svg';
const CLAUDE_RE = /noreply@anthropic\.com|generated with \[?claude code/i;

if (!TOKEN) {
  console.error('Set GH_TOKEN to a classic PAT with the `repo` scope.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

async function gql(query, variables = {}) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: { Authorization: `bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && !body.errors) return body.data;
    if (attempt < 3 && (res.status >= 500 || res.status === 403)) {
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      continue;
    }
    throw new Error(`GraphQL ${res.status}: ${JSON.stringify(body.errors ?? body)}`);
  }
}

async function getProfile() {
  const { viewer } = await gql(`{ viewer {
    id login createdAt location
    repositories(privacy: PUBLIC, isFork: false, ownerAffiliations: OWNER) { totalCount }
    contributionsCollection { contributionYears }
  } }`);

  // Same total the original card shows: every contribution year, summed.
  let contributions = 0;
  for (const year of viewer.contributionsCollection.contributionYears) {
    const data = await gql(
      `query($from: DateTime!, $to: DateTime!) { viewer { contributionsCollection(from: $from, to: $to) {
        contributionCalendar { totalContributions } } } }`,
      { from: `${year}-01-01T00:00:00Z`, to: `${year}-12-31T23:59:59Z` },
    );
    contributions += data.viewer.contributionsCollection.contributionCalendar.totalContributions;
  }
  return { ...viewer, publicRepos: viewer.repositories.totalCount, contributions };
}

async function listRepos() {
  const repos = new Set();
  for (const field of ['repositories', 'repositoriesContributedTo']) {
    const args =
      field === 'repositories'
        ? 'affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]'
        : 'contributionTypes: [COMMIT], includeUserRepositories: true';
    let after = null;
    do {
      const data = await gql(
        `query($after: String) { viewer { ${field}(first: 100, after: $after, ${args}) {
          pageInfo { hasNextPage endCursor } nodes { nameWithOwner defaultBranchRef { name } } } } }`,
        { after },
      );
      const page = data.viewer[field];
      for (const repo of page.nodes) if (repo.defaultBranchRef) repos.add(repo.nameWithOwner);
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after);
  }
  return [...repos];
}

async function listCommits(nameWithOwner, authorId, since) {
  const [owner, name] = nameWithOwner.split('/');
  const commits = [];
  let after = null;
  do {
    const data = await gql(
      `query($owner: String!, $name: String!, $author: ID!, $since: GitTimestamp!, $after: String) {
        repository(owner: $owner, name: $name) { defaultBranchRef { target { ... on Commit {
          history(first: 100, after: $after, since: $since, author: { id: $author }) {
            pageInfo { hasNextPage endCursor }
            nodes { oid authoredDate message parents { totalCount } }
          } } } } } }`,
      { owner, name, author: authorId, since, after },
    );
    const history = data.repository?.defaultBranchRef?.target?.history;
    if (!history) break;
    commits.push(...history.nodes);
    after = history.pageInfo.hasNextPage ? history.pageInfo.endCursor : null;
  } while (after);
  return commits;
}

// Commits per month for the 13 months the original card plots (same month last year → now).
async function monthlyCommits(authorId) {
  const now = new Date();
  const months = [];
  for (let i = 12; i >= 0; i--) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    months.push({ key: date.toISOString().slice(0, 7), date, manual: 0, claude: 0 });
  }
  const index = new Map(months.map((m) => [m.key, m]));
  const since = months[0].date.toISOString();

  const seen = new Set(); // forks share commits with their parent; count each once
  for (const repo of await listRepos()) {
    let found;
    try {
      found = await listCommits(repo, authorId, since);
    } catch (err) {
      console.warn(`  skip ${repo}: ${err.message}`);
      continue;
    }
    for (const c of found) {
      if (seen.has(c.oid) || c.parents.totalCount > 1) continue; // skip duplicates and merges
      seen.add(c.oid);
      const m = index.get(c.authoredDate.slice(0, 7));
      if (m) m[CLAUDE_RE.test(c.message) ? 'claude' : 'manual']++;
    }
  }
  return months;
}

// ---------------------------------------------------------------------------
// Rendering (layout, colors and icons copied from the github_dark profile-details card)
// ---------------------------------------------------------------------------

const C = {
  bg: '#0d1117', border: '#2e343b', title: '#0366d6', text: '#77909c', icon: '#8b949e',
  manual: '#3987e5', claude: '#d95926',
};
const CHART_W = 380;
const CHART_H = 110;

const ICONS = {
  contributions: 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z',
  repos: 'M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 110-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9zm10.5-1V9h-8c-.356 0-.694.074-1 .208V2.5a1 1 0 011-1h8zM5 12.25v3.25a.25.25 0 00.4.2l1.45-1.087a.25.25 0 01.3 0L8.6 15.7a.25.25 0 00.4-.2v-3.25a.25.25 0 00-.25-.25h-3.5a.25.25 0 00-.25.25z',
  joined: 'M1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0zM8 0a8 8 0 100 16A8 8 0 008 0zm.5 4.75a.75.75 0 00-1.5 0v3.5a.75.75 0 00.471.696l2.5 1a.75.75 0 00.557-1.392L8.5 7.742V4.75z',
  location: 'M11.536 3.464a5 5 0 010 7.072L8 14.07l-3.536-3.535a5 5 0 117.072-7.072v.001zm1.06 8.132a6.5 6.5 0 10-9.192 0l3.535 3.536a1.5 1.5 0 002.122 0l3.535-3.536zM8 9a2 2 0 100-4 2 2 0 000 4z',
};

const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
const r2 = (n) => Math.round(n * 100) / 100;

// "1150" → "1.15k", like js-abbreviation-number with 2 digits.
function abbreviate(n) {
  for (const [div, suffix] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']]) {
    if (n >= div) return `${Number((n / div).toFixed(2))}${suffix}`;
  }
  return String(n);
}

function joinedAgo(createdAt) {
  const years = Math.floor((Date.now() - new Date(createdAt)) / (365.25 * 864e5));
  return years >= 1 ? `${years} year${years > 1 ? 's' : ''} ago` : 'this year';
}

// d3-style tick step for ~5 ticks.
function tickStep(max) {
  const raw = Math.max(1, max / 5);
  const power = 10 ** Math.floor(Math.log10(raw));
  const err = raw / power;
  return Math.max(1, (err >= 7.07 ? 10 : err >= 3.16 ? 5 : err >= 1.41 ? 2 : 1) * power);
}

// Monotone cubic interpolation (same as d3.curveMonotoneX), as Bézier segments.
function monotoneSegments(pts) {
  const n = pts.length;
  const sign = (v) => (v < 0 ? -1 : 1);
  const t = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
    const h0 = x1 - x0, h1 = x2 - x1;
    const s0 = (y1 - y0) / h0, s1 = (y2 - y1) / h1;
    const p = (s0 * h1 + s1 * h0) / (h0 + h1);
    t[i] = (sign(s0) + sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p)) || 0;
  }
  if (n > 1) {
    const end = (a, b, tb) => (3 * (b[1] - a[1])) / (b[0] - a[0]) / 2 - tb / 2;
    t[0] = n > 2 ? end(pts[0], pts[1], t[1]) : (pts[1][1] - pts[0][1]) / (pts[1][0] - pts[0][0]);
    t[n - 1] = n > 2 ? end(pts[n - 2], pts[n - 1], t[n - 2]) : t[0];
  }
  const segs = [];
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    const dx = (x1 - x0) / 3;
    segs.push([[x0, y0], [x0 + dx, y0 + dx * t[i]], [x1 - dx, y1 - dx * t[i + 1]], [x1, y1]]);
  }
  return segs;
}

const pt = ([x, y]) => `${r2(x)},${r2(y)}`;
const forward = (segs) => segs.map(([, c1, c2, p]) => `C${pt(c1)} ${pt(c2)} ${pt(p)}`).join('');
const backward = (segs) => [...segs].reverse().map(([p, c1, c2]) => `C${pt(c2)} ${pt(c1)} ${pt(p)}`).join('');

function renderChart(months) {
  const t0 = months[0].date.getTime();
  const t1 = months[months.length - 1].date.getTime();
  const x = (d) => ((d.getTime() - t0) / (t1 - t0)) * CHART_W;
  const peak = Math.max(1, ...months.map((m) => m.manual + m.claude));
  const step = tickStep(peak);
  const max = Math.ceil(peak / step) * step;
  const y = (v) => CHART_H - (v / max) * CHART_H;

  const base = monotoneSegments(months.map((m) => [x(m.date), CHART_H]));
  const mid = monotoneSegments(months.map((m) => [x(m.date), y(m.manual)]));
  const top = monotoneSegments(months.map((m) => [x(m.date), y(m.manual + m.claude)]));
  const start = (segs) => `M${pt(segs[0][0])}`;
  const end = (segs) => pt(segs[segs.length - 1][3]);

  // Hand-written fills baseline → mid; Claude stacks mid → top; a 1px background line separates them.
  let out = `<g transform="translate(-30,0)">
<path fill="${C.manual}" d="${start(mid)}${forward(mid)}L${end(base)}${backward(base)}Z"/>
<path fill="${C.claude}" d="${start(top)}${forward(top)}L${end(mid)}${backward(mid)}Z"/>
<path fill="none" stroke="${C.bg}" stroke-width="1" d="${start(mid)}${forward(mid)}"/>
</g>`;

  // X axis: a tick every other month, labelled YY/MM.
  out += `<g color="${C.text}" transform="translate(-30,${CHART_H})" fill="none" font-size="10" font-family="sans-serif" text-anchor="middle">
<path stroke="currentColor" d="M0.5,6V0.5H${CHART_W + 0.5}V6"/>`;
  months.forEach((m, i) => {
    if (i % 2) return;
    const label = `${String(m.date.getUTCFullYear()).slice(2)}/${String(m.date.getUTCMonth() + 1).padStart(2, '0')}`;
    out += `<g transform="translate(${r2(x(m.date) + 0.5)},0)"><line stroke="currentColor" y2="6"/><text fill="currentColor" y="9" dy="0.71em">${label}</text></g>`;
  });
  out += '</g>';

  // Y axis on the right.
  out += `<g color="${C.text}" transform="translate(${CHART_W - 30},0)" fill="none" font-size="10" font-family="sans-serif" text-anchor="start">
<path stroke="currentColor" d="M6,${CHART_H + 0.5}H0.5V0.5H6"/>`;
  for (let v = 0; v <= max; v += step) {
    out += `<g transform="translate(0,${r2(y(v) + 0.5)})"><line stroke="currentColor" x2="6"/><text fill="currentColor" x="9" dy="0.32em">${v}</text></g>`;
  }
  out += '</g>';

  // Title on the right (where "contributions in the last year" sat), legend to its left.
  out += `<g font-size="10" fill="${C.text}">
<text x="${CHART_W - 30}" y="-15" text-anchor="end" style="fill: ${C.text};">commits in the last year</text>
<rect x="-30" y="-23" width="9" height="9" rx="2" fill="${C.manual}"/><text x="-17" y="-15">hand-written</text>
<rect x="52" y="-23" width="9" height="9" rx="2" fill="${C.claude}"/><text x="65" y="-15">Claude Code</text>
</g>`;
  return out;
}

function renderCard(profile, months) {
  const rows = [
    { icon: ICONS.contributions, text: `${abbreviate(profile.contributions)} Contributions on GitHub` },
    { icon: ICONS.repos, text: `${abbreviate(profile.publicRepos)} Public Repos` },
    { icon: ICONS.joined, text: `Joined GitHub ${joinedAgo(profile.createdAt)}` },
  ];
  if (profile.location) rows.push({ icon: ICONS.location, text: profile.location });

  const details = rows
    .map((r, i) => `<g transform="translate(0,${i * 28})" fill="${C.icon}"><path fill-rule="evenodd" d="${r.icon}"/></g>
<text x="21" y="${14 + i * 28}" style="fill: ${C.text}; font-size: 14px;">${esc(r.text)}</text>`)
    .join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="700" height="200" viewBox="0 0 700 200">
<style>* { font-family: 'Segoe UI', Ubuntu, "Helvetica Neue", Sans-Serif }</style>
<rect x="1" y="1" rx="5" ry="5" height="99%" width="99.71428571428571%" stroke="${C.border}" stroke-width="1" fill="${C.bg}" stroke-opacity="1"/>
<text x="30" y="40" style="font-size: 22px; fill: ${C.title};">${esc(profile.login)}</text>
<g transform="translate(0,40)">
<g transform="translate(30,30)">
${details}
</g>
<g transform="translate(295,10)">
${renderChart(months)}
</g>
</g>
</svg>
`;
}

// ---------------------------------------------------------------------------

const profile = await getProfile();
const months = await monthlyCommits(profile.id);
await mkdir(dirname(OUT_FILE), { recursive: true });
await writeFile(OUT_FILE, renderCard(profile, months));

const manual = months.reduce((s, m) => s + m.manual, 0);
const claude = months.reduce((s, m) => s + m.claude, 0);
console.log(`${profile.login}: ${profile.contributions} contributions; last 13 months ${manual} hand-written, ${claude} Claude Code commits → ${OUT_FILE}`);
