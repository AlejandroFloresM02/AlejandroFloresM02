// Generates an SVG card that splits your commits into hand-written vs. made with Claude Code.
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

async function listCommits(nameWithOwner, authorId) {
  const [owner, name] = nameWithOwner.split('/');
  const commits = [];
  let after = null;
  do {
    const data = await gql(
      `query($owner: String!, $name: String!, $author: ID!, $after: String) {
        repository(owner: $owner, name: $name) { defaultBranchRef { target { ... on Commit {
          history(first: 100, after: $after, author: { id: $author }) {
            pageInfo { hasNextPage endCursor }
            nodes { oid authoredDate message parents { totalCount } }
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
      console.warn(`  skip ${repo}: ${err.message}`);
      continue;
    }
    for (const c of found) {
      if (seen.has(c.oid) || c.parents.totalCount > 1) continue; // skip duplicates and merges
      seen.add(c.oid);
      commits.push({ date: c.authoredDate, claude: CLAUDE_RE.test(c.message) });
    }
  }
  return commits;
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

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const THEMES = {
  light: {
    surface: '#fcfcfb', border: 'rgba(11,11,11,0.10)', primary: '#0b0b0b', secondary: '#52514e',
    muted: '#898781', axis: '#c3c2b7', manual: '#2a78d6', claude: '#eb6834',
  },
  dark: {
    surface: '#1a1a19', border: 'rgba(255,255,255,0.10)', primary: '#f0efec', secondary: '#c3c2b7',
    muted: '#898781', axis: '#383835', manual: '#3987e5', claude: '#d95926',
  },
};

const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, Helvetica, Arial, sans-serif`;
const WIDTH = 600;
const PAD = 20;

const fmt = (n) => n.toLocaleString('en-US');
const pct = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : '0%');

// Rect with 4px rounding on the given ends; the other ends stay square.
function bar(x, y, w, h, fill, { left = false, right = false, top = false } = {}) {
  if (w <= 0 || h <= 0) return '';
  const r = Math.min(4, w / 2, h / 2);
  if (top) {
    return `<path d="M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z" fill="${fill}"/>`;
  }
  const l = left ? r : 0;
  const rr = right ? r : 0;
  return `<path d="M${x + l},${y} H${x + w - rr} ${rr ? `Q${x + w},${y} ${x + w},${y + rr}` : ''} V${y + h - rr} ${rr ? `Q${x + w},${y + h} ${x + w - rr},${y + h}` : ''} H${x + l} ${l ? `Q${x},${y + h} ${x},${y + h - l}` : ''} V${y + l} ${l ? `Q${x},${y} ${x + l},${y}` : ''} Z" fill="${fill}"/>`;
}

function renderCard(theme, commits, months, updated) {
  const t = THEMES[theme];
  const inner = WIDTH - PAD * 2;
  const claude = commits.filter((c) => c.claude).length;
  const manual = commits.length - claude;
  const total = commits.length;

  let body = `<text x="${PAD}" y="${PAD + 14}" font-size="15" font-weight="600" fill="${t.primary}">Hand-written vs. Claude Code</text>
<text x="${PAD}" y="${PAD + 33}" font-size="12" fill="${t.muted}">${fmt(total)} commits · updated ${updated}</text>`;

  // Share bar: hand-written | Claude, separated by a 2px surface gap.
  const barY = PAD + 50;
  const gap = manual && claude ? 2 : 0;
  const mw = total ? Math.round(((inner - gap) * manual) / total) : 0;
  body += bar(PAD, barY, mw, 10, t.manual, { left: true, right: !claude });
  body += bar(PAD + mw + gap, barY, inner - gap - mw, 10, t.claude, { left: !manual, right: true });

  // Legend doubles as the value labels.
  const keyY = barY + 32;
  [
    { x: PAD, color: t.manual, label: 'Hand-written', value: manual },
    { x: PAD + inner / 2, color: t.claude, label: 'Claude Code', value: claude },
  ].forEach((k) => {
    body += `<rect x="${k.x}" y="${keyY - 9}" width="10" height="10" rx="2" fill="${k.color}"/>
<text x="${k.x + 16}" y="${keyY}" font-size="12" fill="${t.secondary}">${k.label} <tspan font-weight="600" fill="${t.primary}">${fmt(k.value)}</tspan> <tspan fill="${t.muted}">· ${pct(k.value, total)}</tspan></text>`;
  });

  // Last N months as small stacked columns: hand-written on the baseline, Claude on top.
  const chartTop = keyY + 32;
  const chartH = 56;
  const base = chartTop + chartH;
  const slot = inner / months.length;
  const colW = Math.min(16, slot * 0.5);
  const max = Math.max(1, ...months.map((m) => m.manual + m.claude));
  const h = (v) => (v / max) * chartH;
  const peak = months.reduce((a, b) => (b.manual + b.claude > a.manual + a.claude ? b : a));

  body += `<text x="${PAD}" y="${chartTop - 10}" font-size="11" fill="${t.muted}">Last ${months.length} months</text>
<line x1="${PAD}" x2="${WIDTH - PAD}" y1="${base}" y2="${base}" stroke="${t.axis}" stroke-width="1"/>`;
  months.forEach((m, i) => {
    const cx = PAD + slot * (i + 0.5);
    const x = cx - colW / 2;
    const mh = h(m.manual);
    const ch = h(m.claude);
    const g = m.manual && m.claude ? 2 : 0;
    body += bar(x, base - mh, colW, mh, t.manual, { top: !m.claude });
    body += bar(x, base - mh - g - ch, colW, ch, t.claude, { top: true });
    if (m === peak && m.manual + m.claude) {
      body += `<text x="${cx}" y="${base - mh - g - ch - 5}" font-size="11" text-anchor="middle" fill="${t.secondary}">${fmt(m.manual + m.claude)}</text>`;
    }
    const label = m.date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
    body += `<text x="${cx}" y="${base + 15}" font-size="10" text-anchor="middle" fill="${t.muted}">${label}</text>`;
  });

  const height = base + 15 + PAD;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-label="${fmt(manual)} hand-written commits, ${fmt(claude)} with Claude Code">
<title>${fmt(manual)} hand-written commits, ${fmt(claude)} with Claude Code</title>
<style>text { font-family: ${FONT}; }</style>
<rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${height - 1}" rx="8" fill="${t.surface}" stroke="${t.border}"/>
${body}
</svg>
`;
}

// ---------------------------------------------------------------------------

const commits = await collect();
const months = byMonth(commits, MONTHS);
const updated = new Date().toISOString().slice(0, 10);

await mkdir(OUT_DIR, { recursive: true });
for (const theme of Object.keys(THEMES)) {
  await writeFile(`${OUT_DIR}/card-${theme}.svg`, renderCard(theme, commits, months, updated));
}
const claude = commits.filter((c) => c.claude).length;
console.log(`${commits.length} commits: ${commits.length - claude} hand-written, ${claude} with Claude Code → ${OUT_DIR}/`);
