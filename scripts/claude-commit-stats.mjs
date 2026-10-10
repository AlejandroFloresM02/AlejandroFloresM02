// Generates SVG charts that split your commits into hand-written vs. made with Claude Code.
//
// A commit counts as "Claude Code" when its message carries the attribution Claude Code adds
// by default: a `Co-Authored-By: Claude ... <noreply@anthropic.com>` trailer or the
// "Generated with [Claude Code]" line. Everything else counts as hand-written.
//
// Usage: GH_TOKEN=<token with `repo` scope> node scripts/claude-commit-stats.mjs
// Zero dependencies; needs Node 18+.

import { mkdir, writeFile } from 'node:fs/promises';

const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const OUT_DIR = process.env.OUT_DIR || 'assets/claude-stats';
const MONTHS = Number(process.env.MONTHS || 12);
const TOP_REPOS = Number(process.env.TOP_REPOS || 8);
// Private repos are always counted, but their names are hidden unless this is "true".
const SHOW_PRIVATE_NAMES = process.env.SHOW_PRIVATE_NAMES === 'true';

const CLAUDE_RE = /noreply@anthropic\.com|generated with \[?claude code/i;

if (!TOKEN) {
  console.error('Set GH_TOKEN to a token with the `repo` scope.');
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

const REPO_FIELDS = 'nameWithOwner isPrivate defaultBranchRef { name }';

async function listRepos() {
  const repos = new Map();
  for (const field of ['repositories', 'repositoriesContributedTo']) {
    const args =
      field === 'repositories'
        ? 'affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]'
        : 'contributionTypes: [COMMIT], includeUserRepositories: true';
    let after = null;
    do {
      const data = await gql(
        `query($after: String) { viewer { ${field}(first: 100, after: $after, ${args}) {
          pageInfo { hasNextPage endCursor } nodes { ${REPO_FIELDS} } } } }`,
        { after },
      );
      const page = data.viewer[field];
      for (const repo of page.nodes) if (repo.defaultBranchRef) repos.set(repo.nameWithOwner, repo);
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after);
  }
  return [...repos.values()];
}

async function listCommits(repo, authorId) {
  const [owner, name] = repo.nameWithOwner.split('/');
  const commits = [];
  let after = null;
  do {
    const data = await gql(
      `query($owner: String!, $name: String!, $author: ID!, $after: String) {
        repository(owner: $owner, name: $name) { defaultBranchRef { target { ... on Commit {
          history(first: 100, after: $after, author: { id: $author }) {
            pageInfo { hasNextPage endCursor }
            nodes { oid authoredDate message additions deletions parents { totalCount } }
          } } } } } }`,
      { owner, name, author: authorId, after },
    );
    const history = data.repository?.defaultBranchRef?.target?.history;
    if (!history) break;
    commits.push(...history.nodes);
    after = history.pageInfo.hasNextPage ? history.pageInfo.endCursor : null;
  } while (after);
  return commits;
}

async function collect() {
  const { viewer } = await gql('{ viewer { id login } }');
  const repos = await listRepos();
  console.log(`${viewer.login}: scanning ${repos.length} repos`);

  const seen = new Set(); // forks share commits with their parent; count each once
  const commits = [];
  for (const repo of repos) {
    let found;
    try {
      found = await listCommits(repo, viewer.id);
    } catch (err) {
      console.warn(`  skip ${repo.nameWithOwner}: ${err.message}`);
      continue;
    }
    let kept = 0;
    for (const c of found) {
      if (seen.has(c.oid) || c.parents.totalCount > 1) continue; // skip duplicates and merges
      seen.add(c.oid);
      kept++;
      commits.push({
        repo: repo.nameWithOwner,
        isPrivate: repo.isPrivate,
        date: c.authoredDate,
        claude: CLAUDE_RE.test(c.message),
        lines: c.additions + c.deletions,
      });
    }
    if (kept) console.log(`  ${repo.nameWithOwner}: ${kept}`);
  }
  return { login: viewer.login, commits };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function tally(commits) {
  const t = { manual: 0, claude: 0, manualLines: 0, claudeLines: 0 };
  for (const c of commits) {
    if (c.claude) { t.claude++; t.claudeLines += c.lines; }
    else { t.manual++; t.manualLines += c.lines; }
  }
  t.total = t.manual + t.claude;
  return t;
}

function byMonth(commits, months) {
  const now = new Date();
  const buckets = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    buckets.push({ key: d.toISOString().slice(0, 7), date: d, manual: 0, claude: 0 });
  }
  const index = new Map(buckets.map((b) => [b.key, b]));
  for (const c of commits) {
    const b = index.get(c.date.slice(0, 7));
    if (b) b[c.claude ? 'claude' : 'manual']++;
  }
  return buckets;
}

function byRepo(commits, login) {
  const groups = new Map();
  for (const c of commits) {
    if (!groups.has(c.repo)) groups.set(c.repo, []);
    groups.get(c.repo).push(c);
  }
  const all = [...groups].map(([repo, cs]) => ({ repo, isPrivate: cs[0].isPrivate, ...tally(cs) }));
  all.sort((a, b) => b.total - a.total);

  const rows = all.slice(0, TOP_REPOS).map((r) => {
    if (r.isPrivate && !SHOW_PRIVATE_NAMES) return { ...r, label: 'Private repo', muted: true };
    const [owner, name] = r.repo.split('/');
    return { ...r, label: owner === login ? name : r.repo };
  });
  const rest = new Set(all.slice(TOP_REPOS).map((r) => r.repo));
  if (rest.size) {
    rows.push({ label: `${rest.size} other repos`, muted: true, ...tally(commits.filter((c) => rest.has(c.repo))) });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const THEMES = {
  light: {
    surface: '#fcfcfb', border: 'rgba(11,11,11,0.10)', primary: '#0b0b0b', secondary: '#52514e',
    muted: '#898781', grid: '#e1e0d9', axis: '#c3c2b7', manual: '#2a78d6', claude: '#eb6834',
  },
  dark: {
    surface: '#1a1a19', border: 'rgba(255,255,255,0.10)', primary: '#f0efec', secondary: '#c3c2b7',
    muted: '#898781', grid: '#2c2c2a', axis: '#383835', manual: '#3987e5', claude: '#d95926',
  },
};

const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, Helvetica, Arial, sans-serif`;
const WIDTH = 800;
const PAD = 24;

const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
const fmt = (n) => (n >= 10_000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}K` : n.toLocaleString('en-US'));
const pct = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : '0%');

function card(theme, height, body, title) {
  const t = THEMES[theme];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-label="${esc(title)}">
<title>${esc(title)}</title>
<style>text { font-family: ${FONT}; } .num { font-variant-numeric: tabular-nums; }</style>
<rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${height - 1}" rx="8" fill="${t.surface}" stroke="${t.border}"/>
${body}
</svg>
`;
}

// Rect with 4px rounding only on the given side(s); the other side stays square.
function bar(x, y, w, h, fill, { roundLeft = false, roundRight = false, roundTop = false } = {}) {
  if (w <= 0 || h <= 0) return '';
  const r = Math.min(4, w / 2, h / 2);
  if (roundTop) {
    return `<path d="M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z" fill="${fill}"/>`;
  }
  const l = roundLeft ? r : 0;
  const rr = roundRight ? r : 0;
  return `<path d="M${x + l},${y} H${x + w - rr} ${rr ? `Q${x + w},${y} ${x + w},${y + rr}` : ''} V${y + h - rr} ${rr ? `Q${x + w},${y + h} ${x + w - rr},${y + h}` : ''} H${x + l} ${l ? `Q${x},${y + h} ${x},${y + h - l}` : ''} V${y + l} ${l ? `Q${x},${y} ${x + l},${y}` : ''} Z" fill="${fill}"/>`;
}

// Horizontal 100% bar split into hand-written | Claude, with a 2px surface gap between them.
function splitBar(t, x, y, w, h, manual, claude) {
  const total = manual + claude;
  if (!total) return bar(x, y, w, h, t.grid, { roundLeft: true, roundRight: true });
  const gap = manual && claude ? 2 : 0;
  const mw = Math.round(((w - gap) * manual) / total);
  const cw = w - gap - mw;
  return (
    bar(x, y, mw, h, t.manual, { roundLeft: true, roundRight: !claude }) +
    bar(x + mw + gap, y, cw, h, t.claude, { roundLeft: !manual, roundRight: true })
  );
}

function legend(t, x, y) {
  return `<g font-size="12" fill="${t.secondary}">
  <rect x="${x}" y="${y - 9}" width="10" height="10" rx="2" fill="${t.manual}"/><text x="${x + 16}" y="${y}">Hand-written</text>
  <rect x="${x + 112}" y="${y - 9}" width="10" height="10" rx="2" fill="${t.claude}"/><text x="${x + 128}" y="${y}">With Claude Code</text>
</g>`;
}

function header(t, title, subtitle) {
  return `<text x="${PAD}" y="${PAD + 14}" font-size="16" font-weight="600" fill="${t.primary}">${esc(title)}</text>
<text x="${PAD}" y="${PAD + 34}" font-size="12" fill="${t.muted}">${esc(subtitle)}</text>`;
}

function renderSummary(theme, total, repoCount, updated) {
  const t = THEMES[theme];
  const inner = WIDTH - PAD * 2;
  const tiles = [
    { label: 'Total commits', value: fmt(total.total), sub: `across ${repoCount} repos` },
    { label: 'Hand-written', value: fmt(total.manual), sub: `${pct(total.manual, total.total)} of commits`, swatch: t.manual },
    { label: 'With Claude Code', value: fmt(total.claude), sub: `${pct(total.claude, total.total)} of commits`, swatch: t.claude },
  ];
  const tileW = inner / tiles.length;
  let body = header(t, 'Commits: hand-written vs. Claude Code', `Default-branch commits, merges excluded · updated ${updated}`);
  tiles.forEach((tile, i) => {
    const x = PAD + i * tileW;
    const tx = tile.swatch ? x + 16 : x;
    if (tile.swatch) body += `<rect x="${x}" y="${PAD + 58}" width="10" height="10" rx="2" fill="${tile.swatch}"/>`;
    body += `<text x="${tx}" y="${PAD + 67}" font-size="12" fill="${t.secondary}">${esc(tile.label)}</text>
<text x="${x}" y="${PAD + 102}" font-size="32" font-weight="600" fill="${t.primary}">${tile.value}</text>
<text x="${x}" y="${PAD + 122}" font-size="12" fill="${t.muted}">${esc(tile.sub)}</text>`;
  });

  const rows = [
    { label: 'Commits', manual: total.manual, claude: total.claude },
    { label: 'Lines changed', manual: total.manualLines, claude: total.claudeLines },
  ];
  const labelW = 104;
  let y = PAD + 150;
  for (const row of rows) {
    const sum = row.manual + row.claude;
    body += `<text x="${PAD}" y="${y + 10}" font-size="12" fill="${t.secondary}">${row.label}</text>
${splitBar(t, PAD + labelW, y, inner - labelW - 110, 12, row.manual, row.claude)}
<text class="num" x="${WIDTH - PAD}" y="${y + 10}" font-size="12" text-anchor="end" fill="${t.secondary}">${pct(row.claude, sum)} Claude</text>`;
    y += 26;
  }
  return card(theme, y + PAD - 10, body, `Commits: ${total.manual} hand-written, ${total.claude} with Claude Code`);
}

// Smallest "round" tick step (1, 2, 2.5, 5 × 10^k) such that `ticks` steps cover v.
function niceStep(v, ticks) {
  const raw = Math.max(1, v / ticks);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const steps = mag >= 10 ? [1, 2, 2.5, 5, 10] : [1, 2, 5, 10];
  return steps.map((m) => m * mag).find((s) => s >= raw);
}

function renderMonthly(theme, months) {
  const t = THEMES[theme];
  const top = PAD + 64;
  const plotH = 170;
  const left = PAD + 32;
  const right = WIDTH - PAD;
  const step = niceStep(Math.max(1, ...months.map((m) => m.manual + m.claude)), 4);
  const max = step * 4;
  const y = (v) => top + plotH - (v / max) * plotH;
  const slot = (right - left) / months.length;
  const colW = Math.min(24, slot * 0.6);

  let body = header(t, 'Commits per month', `Last ${months.length} months`);
  body += legend(t, WIDTH - PAD - 232, PAD + 14);

  for (let i = 0; i <= 4; i++) {
    const v = step * i;
    const yy = y(v);
    body += `<line x1="${left}" x2="${right}" y1="${yy}" y2="${yy}" stroke="${i === 0 ? t.axis : t.grid}" stroke-width="1"/>
<text class="num" x="${left - 8}" y="${yy + 4}" font-size="11" text-anchor="end" fill="${t.muted}">${fmt(Math.round(v))}</text>`;
  }

  months.forEach((m, i) => {
    const cx = left + slot * (i + 0.5);
    const x = cx - colW / 2;
    const total = m.manual + m.claude;
    const base = y(0);
    const mh = base - y(m.manual);
    const ch = base - y(m.claude);
    // Hand-written sits on the baseline; Claude stacks on top with a 2px surface gap.
    const gap = m.manual && m.claude ? 2 : 0;
    body += bar(x, base - mh, colW, mh, t.manual, { roundTop: !m.claude });
    if (m.claude) body += bar(x, base - mh - gap - ch, colW, ch, t.claude, { roundTop: true });
    if (total) body += `<text class="num" x="${cx}" y="${base - mh - gap - ch - 6}" font-size="11" text-anchor="middle" fill="${t.secondary}">${fmt(total)}</text>`;
    const label = m.date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
    const showYear = i === 0 || m.date.getUTCMonth() === 0;
    body += `<text x="${cx}" y="${top + plotH + 18}" font-size="11" text-anchor="middle" fill="${t.muted}">${label}</text>`;
    if (showYear) body += `<text class="num" x="${cx}" y="${top + plotH + 32}" font-size="11" text-anchor="middle" fill="${t.muted}">${m.date.getUTCFullYear()}</text>`;
  });

  return card(theme, top + plotH + 32 + PAD - 4, body, 'Commits per month, hand-written vs. Claude Code');
}

function renderRepos(theme, rows) {
  const t = THEMES[theme];
  const top = PAD + 64;
  const rowH = 28;
  const labelW = 250;
  const valueW = 120;
  const barX = PAD + labelW;
  const barMax = WIDTH - PAD - valueW - barX;
  const max = Math.max(1, ...rows.map((r) => r.total));

  let body = header(t, 'Commits by repository', `Top ${Math.min(TOP_REPOS, rows.length)} repos by commit count`);
  body += legend(t, WIDTH - PAD - 232, PAD + 14);

  rows.forEach((r, i) => {
    const yy = top + i * rowH;
    const name = r.label.length > 34 ? `${r.label.slice(0, 33)}…` : r.label;
    const w = Math.max(4, (r.total / max) * barMax);
    body += `<text x="${PAD}" y="${yy + 10}" font-size="12" fill="${r.muted ? t.muted : t.secondary}">${esc(name)}</text>
${splitBar(t, barX, yy, w, 12, r.manual, r.claude)}
<text class="num" x="${barX + w + 8}" y="${yy + 10}" font-size="12" fill="${t.secondary}">${fmt(r.total)} <tspan fill="${t.muted}">· ${pct(r.claude, r.total)} Claude</tspan></text>`;
  });

  return card(theme, top + rows.length * rowH + PAD - 12, body, 'Commits by repository, hand-written vs. Claude Code');
}

// ---------------------------------------------------------------------------

const { login, commits } = await collect();
const total = tally(commits);
const repoCount = new Set(commits.map((c) => c.repo)).size;
const months = byMonth(commits, MONTHS);
const repos = byRepo(commits, login);
const updated = new Date().toISOString().slice(0, 10);

await mkdir(OUT_DIR, { recursive: true });
for (const theme of Object.keys(THEMES)) {
  await writeFile(`${OUT_DIR}/summary-${theme}.svg`, renderSummary(theme, total, repoCount, updated));
  await writeFile(`${OUT_DIR}/monthly-${theme}.svg`, renderMonthly(theme, months));
  await writeFile(`${OUT_DIR}/repos-${theme}.svg`, renderRepos(theme, repos));
}
console.log(`\n${total.total} commits: ${total.manual} hand-written, ${total.claude} with Claude Code → ${OUT_DIR}/`);
