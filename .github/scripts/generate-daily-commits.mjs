import fs from 'node:fs/promises';
import path from 'node:path';

const token = process.env.GH_TOKEN?.trim();
const username = process.env.GH_USERNAME?.trim() || 'AyoubDroubi';
const timeZone = process.env.TIME_ZONE?.trim() || 'Asia/Amman';
const days = Math.max(7, Math.min(90, Number(process.env.ACTIVITY_DAYS || 30)));

if (!token) {
  throw new Error('GH_TOKEN is required. Add PROFILE_README_TOKEN as a repository Actions secret.');
}

const headers = {
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'AyoubDroubi-profile-readme',
};

async function api(url) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${body.slice(0, 500)}`);
  }
  return response;
}

async function paged(url) {
  const out = [];
  let next = url;
  while (next) {
    const response = await api(next);
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error(`Expected array from ${next}`);
    out.push(...data);
    const link = response.headers.get('link') || '';
    const match = link.match(/<([^>]+)>; rel="next"/);
    next = match?.[1] || null;
  }
  return out;
}

function localDateKey(value) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const get = type => parts.find(p => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function dateRange(count) {
  const today = localDateKey(new Date());
  const [year, month, day] = today.split('-').map(Number);
  const anchor = new Date(Date.UTC(year, month - 1, day));
  const keys = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const d = new Date(anchor);
    d.setUTCDate(anchor.getUTCDate() - i);
    keys.push(d.toISOString().slice(0, 10));
  }
  return keys;
}

async function listRepositories() {
  // A fine-grained PAT can enumerate every selected repo visible to the user.
  // We intentionally require this instead of silently falling back to the
  // workflow GITHUB_TOKEN, which is scoped only to this profile repository.
  const repos = await paged('https://api.github.com/user/repos?per_page=100&sort=pushed&direction=desc&affiliation=owner,collaborator,organization_member');
  return repos.filter(repo => !repo.archived && !repo.disabled);
}

async function listBranches(fullName) {
  const encoded = fullName.split('/').map(encodeURIComponent).join('/');
  return paged(`https://api.github.com/repos/${encoded}/branches?per_page=100`);
}

async function listCommits(fullName, branch, sinceIso, untilIso) {
  const encoded = fullName.split('/').map(encodeURIComponent).join('/');
  const params = new URLSearchParams({
    sha: branch,
    author: username,
    since: sinceIso,
    until: untilIso,
    per_page: '100',
  });
  return paged(`https://api.github.com/repos/${encoded}/commits?${params.toString()}`);
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function shortDate(key) {
  const date = new Date(`${key}T12:00:00Z`);
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(date);
}

function renderSvg(series, meta) {
  const width = 1120;
  const height = 430;
  const left = 58;
  const right = 34;
  const chartTop = 196;
  const chartBottom = 354;
  const chartHeight = chartBottom - chartTop;
  const chartWidth = width - left - right;
  const gap = 7;
  const barWidth = Math.max(8, (chartWidth - gap * (series.length - 1)) / series.length);
  const maxValue = Math.max(1, ...series.map(d => d.count));
  const total = series.reduce((sum, d) => sum + d.count, 0);
  const today = series.at(-1)?.count || 0;
  const yesterday = series.at(-2)?.count || 0;
  const best = series.reduce((a, b) => (b.count > a.count ? b : a), series[0]);
  const updated = new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date());

  const cards = [
    ['TODAY', today.toLocaleString('en-US')],
    ['YESTERDAY', yesterday.toLocaleString('en-US')],
    [`LAST ${series.length} DAYS`, total.toLocaleString('en-US')],
    ['BEST DAY', `${best.count.toLocaleString('en-US')} · ${shortDate(best.date)}`],
  ];

  const cardWidth = 246;
  const cardGap = 18;
  const cardX0 = 58;
  const cardY = 82;
  const cardHeight = 80;

  const cardMarkup = cards.map(([label, value], index) => {
    const x = cardX0 + index * (cardWidth + cardGap);
    return `
      <rect class="card" x="${x}" y="${cardY}" width="${cardWidth}" height="${cardHeight}" rx="14" />
      <text class="card-label" x="${x + 18}" y="${cardY + 27}">${escapeXml(label)}</text>
      <text class="card-value" x="${x + 18}" y="${cardY + 59}">${escapeXml(value)}</text>`;
  }).join('');

  const bars = series.map((item, index) => {
    const x = left + index * (barWidth + gap);
    const h = item.count === 0 ? 2 : Math.max(5, (item.count / maxValue) * chartHeight);
    const y = chartBottom - h;
    const showTick = index === 0 || index === series.length - 1 || index % 3 === 0;
    const labelY = Math.max(chartTop - 8, y - 7);
    return `
      <g>
        <title>${escapeXml(item.date)} — ${item.count.toLocaleString('en-US')} commits</title>
        <rect class="bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${h.toFixed(1)}" rx="4" />
        ${item.count > 0 ? `<text class="count" x="${(x + barWidth / 2).toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle">${item.count}</text>` : ''}
        ${showTick ? `<text class="tick" x="${(x + barWidth / 2).toFixed(1)}" y="382" text-anchor="middle">${escapeXml(shortDate(item.date))}</text>` : ''}
      </g>`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
  <title id="title">Ayoub Aldroubi daily Git commit activity</title>
  <desc id="desc">Actual authored Git commits per day across repositories visible to the authenticated tracker.</desc>
  <style>
    :root { color-scheme: light dark; }
    .bg { fill: #ffffff; stroke: #d0d7de; }
    .title { fill: #1f2328; font: 700 20px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    .subtitle, .tick, .footer { fill: #656d76; font: 12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    .card { fill: #f6f8fa; stroke: #d0d7de; }
    .card-label { fill: #656d76; font: 700 11px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; letter-spacing: .6px; }
    .card-value { fill: #1f2328; font: 700 23px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    .grid { stroke: #d8dee4; stroke-width: 1; }
    .bar { fill: #2f81f7; }
    .count { fill: #1f2328; font: 700 10px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    @media (prefers-color-scheme: dark) {
      .bg { fill: #0d1117; stroke: #30363d; }
      .title, .card-value, .count { fill: #f0f6fc; }
      .subtitle, .tick, .footer, .card-label { fill: #8b949e; }
      .card { fill: #161b22; stroke: #30363d; }
      .grid { stroke: #21262d; }
      .bar { fill: #2f81f7; }
    }
  </style>
  <rect class="bg" x="0.5" y="0.5" width="1119" height="429" rx="18" />
  <text class="title" x="58" y="38">Daily Git commits · last ${series.length} days</text>
  <text class="subtitle" x="58" y="60">Commits, not GitHub contribution events · ${escapeXml(meta.repoCount)} repositories scanned · updated ${escapeXml(updated)} (${escapeXml(timeZone)})</text>
  ${cardMarkup}
  <line class="grid" x1="${left}" y1="${chartBottom}" x2="${width - right}" y2="${chartBottom}" />
  ${bars}
  <text class="footer" x="58" y="414">Counts are de-duplicated by commit SHA across branches. Only commits attributed to @${escapeXml(username)} are included.</text>
</svg>`;
}

const keys = dateRange(days);
const counts = new Map(keys.map(key => [key, 0]));
const since = new Date(Date.now() - (days + 2) * 24 * 60 * 60 * 1000).toISOString();
const until = new Date().toISOString();
const cutoff = keys[0];

const repos = await listRepositories();
const activeRepos = repos.filter(repo => !repo.pushed_at || repo.pushed_at.slice(0, 10) >= cutoff);
const seen = new Set();
let scannedBranches = 0;

for (const repo of activeRepos) {
  const branches = await listBranches(repo.full_name);
  scannedBranches += branches.length;
  for (const branch of branches) {
    const commits = await listCommits(repo.full_name, branch.name, since, until);
    for (const commit of commits) {
      const unique = `${repo.full_name}:${commit.sha}`;
      if (seen.has(unique)) continue;
      seen.add(unique);
      const stamp = commit.commit?.committer?.date || commit.commit?.author?.date;
      if (!stamp) continue;
      const key = localDateKey(new Date(stamp));
      if (counts.has(key)) counts.set(key, counts.get(key) + 1);
    }
  }
}

const series = keys.map(date => ({ date, count: counts.get(date) || 0 }));
const meta = {
  generatedAt: new Date().toISOString(),
  username,
  timeZone,
  repoCount: activeRepos.length,
  branchCount: scannedBranches,
  uniqueCommits: seen.size,
};

await fs.mkdir('assets', { recursive: true });
await fs.writeFile(path.join('assets', 'daily-commits.svg'), renderSvg(series, meta), 'utf8');
await fs.writeFile(path.join('assets', 'daily-commits.json'), `${JSON.stringify({ meta, days: series }, null, 2)}\n`, 'utf8');

console.log(`Generated ${series.length}-day commit chart from ${activeRepos.length} repositories / ${scannedBranches} branches / ${seen.size} unique commits.`);
