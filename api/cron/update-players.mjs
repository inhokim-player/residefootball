/**
 * update-players.mjs  v4  —  World U25 Football Players Data
 *
 * ① Lock 없음 — Run Now 즉시 실행
 * ② SHA 정확히 추적 — 422 오류 없음
 * ③ 리그별 즉시 저장 + Merge
 * ④ Checkpoint — 이어하기
 * ⑤ 50개 국가 / 60개 리그
 */

/* ── 인증 ─────────────────────────────────────────────────────── */
function readSecret(req) {
  const h = String(req.headers?.["x-cron-secret"] || "").trim();
  const b = String(req.headers?.authorization || "").replace(/^bearer\s+/i, "").trim();
  let q = "";
  try {
    const raw = String(req.url || "");
    const qi  = raw.indexOf("?");
    if (qi >= 0) q = new URLSearchParams(raw.slice(qi + 1)).get("secret") || "";
  } catch (_) {}
  return { h, b, q: String(q).trim() };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── GitHub 읽기 ─────────────────────────────────────────────── */
async function ghGet(token, repo, branch, filePath) {
  const url = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(branch)}`;
  const res  = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (res.status === 404) return { exists: false, sha: "", data: null };
  if (!res.ok) throw new Error(`gh_read:${res.status}`);
  const json = await res.json();
  let data = null;
  try { data = JSON.parse(Buffer.from(json.content || "", "base64").toString("utf8")); } catch (_) {}
  return { exists: true, sha: String(json.sha || ""), data };
}

/* ── GitHub 쓰기 (SHA 자동 조회) ────────────────────────────── */
async function ghPut(token, repo, branch, filePath, content, message, knownSha) {
  const url     = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(filePath)}`;
  const ghHdr   = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" };

  let sha = knownSha || "";
  if (!sha) {
    const r = await fetch(`${url}?ref=${encodeURIComponent(branch)}`, { headers: ghHdr });
    if (r.ok) { const j = await r.json(); sha = String(j.sha || ""); }
  }

  const res = await fetch(url, {
    method: "PUT", headers: ghHdr,
    body: JSON.stringify({
      message,
      content: Buffer.from(String(content), "utf8").toString("base64"),
      branch,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`gh_write:${res.status}:${t.slice(0,160)}`); }
  const json = await res.json();
  return { sha: String(json.content?.sha || ""), commitSha: String(json.commit?.sha || "") };
}

/* ── Checkpoint ─────────────────────────────────────────────── */
const CHECKPOINT_PATH = "data/.checkpoint.json";

async function loadCheckpoint(token, repo, branch) {
  try {
    const { data, sha } = await ghGet(token, repo, branch, CHECKPOINT_PATH);
    return { date: String(data?.date || ""), done: Array.isArray(data?.done) ? data.done : [], sha: sha || "" };
  } catch (_) { return { date: "", done: [], sha: "" }; }
}

async function saveCheckpoint(token, repo, branch, date, done, currentSha) {
  try {
    const r = await ghPut(token, repo, branch, CHECKPOINT_PATH,
      JSON.stringify({ date, done, updated_at: new Date().toISOString() }, null, 2) + "\n",
      `chore: checkpoint ${done.length} leagues`, currentSha);
    return r.sha;
  } catch (e) { console.log("[checkpoint] 저장 실패:", String(e?.message || e)); return currentSha; }
}

/* ── 데이터 정규화 ───────────────────────────────────────────── */
function inferContinent(country) {
  const c = String(country || "").toLowerCase();
  const map = {
    Asia:           ["korea","japan","china","qatar","saudi","iran","iraq","uzbek","uae","thailand","vietnam","indonesia","india","malaysia","myanmar","cambodia","philippines","bahrain","kuwait","oman","jordan","kazakhstan"],
    Europe:         ["england","spain","france","germany","italy","netherlands","portugal","belgium","croatia","serbia","denmark","sweden","norway","austria","poland","russia","ukraine","romania","greece","turkey","scotland","switzerland","czech","slovakia","hungary","finland","bulgaria","albania","kosovo","lithuania","latvia","estonia","cyprus","bosnia","moldova","armenia","georgia","azerbaijan","north macedonia","montenegro","slovenia"],
    Africa:         ["nigeria","ghana","senegal","morocco","egypt","algeria","tunisia","cameroon","ivory","south africa","ethiopia","kenya","tanzania","uganda","zimbabwe","zambia","mali","burkina","mozambique","angola"],
    "North America":["usa","canada","mexico","costa rica","honduras","panama","guatemala","jamaica","trinidad","el salvador"],
    "South America":["brazil","argentina","uruguay","colombia","chile","ecuador","peru","paraguay","bolivia","venezuela"],
    Oceania:        ["australia","new zealand","fiji","papua"],
  };
  for (const [cont, keys] of Object.entries(map)) {
    if (keys.some(k => c.includes(k))) return cont;
  }
  return "-";
}

function calcAge(iso) {
  const d = new Date(String(iso || "").trim());
  if (isNaN(d.getTime())) return 0;
  const now = new Date();
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) age--;
  return age > 0 ? age : 0;
}

function parseCm(v) { const m = String(v||"").match(/(\d+)/); return m?Number(m[1]):0; }
function parseKg(v) { const m = String(v||"").match(/(\d+)/); return m?Number(m[1]):0; }
function normFoot(v) {
  const r = String(v||"").toLowerCase();
  if (r.includes("left"))  return "Left";
  if (r.includes("right")) return "Right";
  if (r.includes("both")||r.includes("ambi")) return "Both";
  return "Unknown";
}
function clamp(v,mn,mx) { const n=Number(v||0); return isFinite(n)?Math.max(mn,Math.min(mx,Math.floor(n))):mn; }
function clean(v,fb="-") { return String(v||"").trim()||fb; }

function normalizePlayers(payload, leagueName) {
  const rows = Array.isArray(payload?.response) ? payload.response : Array.isArray(payload?.items) ? payload.items : [];
  const out = []; const seen = new Set();
  for (const row of rows) {
    const p     = row?.player || row || {};
    const stats = Array.isArray(row?.statistics)&&row.statistics.length ? row.statistics[0] : {};
    const team  = stats?.team   || {};
    const lg    = stats?.league || {};
    const nat   = String(p?.nationality||row?.country||p?.birth?.country||"-");
    const age   = Number(p?.age||row?.age||0)||calcAge(p?.birth?.date||"");
    const id    = String(p?.id||row?.player_id||"").trim();
    const first = String(p?.firstname||"").trim();
    const last  = String(p?.lastname||"").trim();
    const name  = String(p?.name||row?.name||(first&&last?`${first} ${last}`:first||last)||"").trim();
    if (!id||!name) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      player_id:     id,
      name,
      age:           clamp(age,0,60),
      height_cm:     clamp(parseCm(p?.height||row?.height_cm),0,260),
      weight_kg:     clamp(parseKg(p?.weight||row?.weight_kg),0,200),
      dominant_foot: normFoot(row?.dominant_foot||p?.foot||""),
      country:       clean(nat),
      continent:     clean(row?.continent||inferContinent(nat)),
      club:          clean(team?.name||row?.club),
      position:      clean(stats?.games?.position||row?.position),
      league:        clean(lg?.name||leagueName||row?.league),
    });
  }
  return out;
}

/* ── 리그 선수 fetch ─────────────────────────────────────────── */
async function fetchLeaguePlayers(baseUrl, leagueId, season, apiKey, maxPages) {
  const headers  = { "x-apisports-key": apiKey, Accept: "application/json" };
  const DELAY    = Number(process.env.API_CALL_DELAY_MS || 200);
  const RETRY_MS = Number(process.env.API_RATE_RETRY_MS || 2000);
  const all = []; const seen = new Set();
  let totalPages = 1;

  for (let page = 1; page <= totalPages && page <= maxPages; page++) {
    if (page > 1) await sleep(DELAY);
    const url = `${baseUrl}?league=${leagueId}&season=${season}&page=${page}`;
    console.log(`[fetch] 리그${leagueId} p${page}/${totalPages}`);

    let payload;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await fetch(url, { method: "GET", headers });
      if (res.status === 429) { await sleep(RETRY_MS); continue; }
      if (!res.ok) throw new Error(`api:${res.status}`);
      payload = await res.json();
      const errs = payload?.errors || {};
      if (Object.keys(errs).length) {
        if (Object.values(errs).some(v => /rate|limit|request/i.test(String(v))) && attempt < 3) {
          await sleep(RETRY_MS); continue;
        }
        throw new Error(`api_err:${JSON.stringify(errs)}`);
      }
      break;
    }
    if (!payload) throw new Error("max_retries");

    const paging = Number(payload?.paging?.total || 0);
    if (paging > 0) totalPages = paging;

    const lgName  = payload?.response?.[0]?.statistics?.[0]?.league?.name || "";
    const players = normalizePlayers(payload, lgName);
    for (const p of players) { if (!seen.has(p.player_id)) { seen.add(p.player_id); all.push(p); } }
    await sleep(DELAY);
  }
  return all;
}

/* ── Merge ───────────────────────────────────────────────────── */
function mergePlayers(existing, newPlayers, maxAge) {
  const map = new Map();
  for (const p of (existing||[])) if (p?.player_id) map.set(String(p.player_id), p);
  for (const p of (newPlayers||[])) if (p?.player_id) map.set(String(p.player_id), p);
  const hi = Math.max(1, Number(maxAge||25));
  return Array.from(map.values()).filter(p => { const a=Number(p?.age); return isFinite(a)&&a>0&&a<=hi; });
}

/* ── 날짜/시즌 ───────────────────────────────────────────────── */
function todayKST() {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone:"Asia/Seoul", year:"numeric", month:"2-digit", day:"2-digit" }).format(new Date());
  } catch (_) { return new Date().toISOString().slice(0,10); }
}

function currentSeason() {
  try {
    const p = new Intl.DateTimeFormat("en-US", { timeZone:"Asia/Seoul", year:"numeric", month:"numeric" }).formatToParts(new Date());
    const y = Number(p.find(x=>x.type==="year")?.value||0);
    const m = Number(p.find(x=>x.type==="month")?.value||0);
    return String(m < 7 ? y-1 : y);
  } catch (_) { return String(new Date().getUTCFullYear()); }
}

function normalizeUrl(raw) {
  try {
    const u = new URL(String(raw||"").trim());
    if (u.protocol !== "https:") return "";
    if (!/(^|\.)api-sports\.io$/i.test(u.hostname)) return "";
    if (!/\/players\/?$/i.test(u.pathname)) return "";
    return `${u.origin}${u.pathname.replace(/\/+$/,"")}`;
  } catch (_) { return ""; }
}

/* ── 50개 국가 / 60개 리그 ──────────────────────────────────── */
const DEFAULT_LEAGUES = [
  // ── 유럽 1부 (20개국) ───────────────────────────────────────
  39,   // England        - Premier League
  140,  // Spain          - La Liga
  78,   // Germany        - Bundesliga
  135,  // Italy          - Serie A
  61,   // France         - Ligue 1
  88,   // Netherlands    - Eredivisie
  94,   // Portugal       - Primeira Liga
  203,  // Turkey         - Süper Lig
  144,  // Belgium        - Pro League
  179,  // Scotland       - Premiership
  207,  // Switzerland    - Super League
  218,  // Denmark        - Superliga
  113,  // Norway         - Eliteserien
  103,  // Sweden         - Allsvenskan
  119,  // Austria        - Bundesliga
  332,  // Poland         - Ekstraklasa
  235,  // Russia         - Premier League
  197,  // Greece         - Super League
  168,  // Croatia        - HNL
  182,  // Serbia         - Super Liga
  // ── 유럽 2부 (5대 리그) ─────────────────────────────────────
  40,   // England        - Championship
  141,  // Spain          - Segunda
  79,   // Germany        - 2. Bundesliga
  136,  // Italy          - Serie B
  62,   // France         - Ligue 2
  // ── 아시아 (12개국) ─────────────────────────────────────────
  292,  // South Korea    - K League 1
  98,   // Japan          - J1 League
  307,  // Saudi Arabia   - Pro League
  322,  // Qatar          - Stars League
  323,  // UAE            - Arabian Gulf League
  324,  // Iran           - Persian Gulf Pro League
  289,  // Thailand       - Thai League 1
  296,  // India          - ISL
  301,  // Indonesia      - Liga 1
  302,  // Vietnam        - V.League 1
  336,  // Kazakhstan     - Premier League
  310,  // Iraq           - Premier League
  // ── 남미 (8개국) ────────────────────────────────────────────
  71,   // Brazil         - Série A
  128,  // Argentina      - Liga Profesional
  239,  // Colombia       - Liga BetPlay
  265,  // Chile          - Primera División
  273,  // Uruguay        - Primera División
  266,  // Peru           - Liga 1
  242,  // Venezuela      - Primera División
  243,  // Ecuador        - Liga Pro
  // ── 아프리카 (6개국) ────────────────────────────────────────
  200,  // Egypt          - Premier League
  204,  // Nigeria        - NPFL
  206,  // South Africa   - PSL
  202,  // Algeria        - Ligue 1
  772,  // Ghana          - Premier League
  773,  // Senegal        - Ligue 1
  // ── 북중미 (3개국) ──────────────────────────────────────────
  253,  // USA            - MLS
  262,  // Mexico         - Liga MX
  164,  // Costa Rica     - Primera División
  // ── 오세아니아 (1개국) ──────────────────────────────────────
  188,  // Australia      - A-League
];

/* ══════════════════════════════════════════════════════════════
   HANDLER
══════════════════════════════════════════════════════════════ */
export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ ok:false, error:"method_not_allowed" });

  const cronSecret = String(process.env.CRON_SECRET || "").trim();
  if (cronSecret) {
    const { h, b, q } = readSecret(req);
    if (h !== cronSecret && b !== cronSecret && q !== cronSecret)
      return res.status(401).json({ ok:false, error:"unauthorized" });
  }

  const apiKey     = String(process.env.API_FOOTBALL_KEY         || "").trim();
  const apiUrl     = String(process.env.API_FOOTBALL_PLAYERS_URL || "").trim();
  const maxPages   = Math.max(1, Math.min(200, Number(process.env.API_FOOTBALL_MAX_PAGES || 20) || 20));
  const maxAge     = Math.max(16, Math.min(26,  Number(process.env.API_FOOTBALL_MAX_AGE  || 25) || 25));
  const season     = String(process.env.API_FOOTBALL_SEASON || currentSeason()).trim();
  const ghToken    = String(process.env.GITHUB_TOKEN  || "").trim();
  const ghRepo     = String(process.env.GITHUB_REPO   || "").trim();
  const ghBranch   = String(process.env.GITHUB_BRANCH || "main").trim();
  const targetPath = String(process.env.REGISTERED_PLAYERS_FILE_PATH   || "data/registered_players.json").trim();
  const dailyPath  = String(process.env.DAILY_PLAYER_UPDATES_FILE_PATH || "data/daily_player_updates.json").trim();

  if (!apiKey || !apiUrl) return res.status(200).json({ ok:true, mode:"no_api_key" });
  if (!ghToken || !ghRepo) return res.status(400).json({ ok:false, error:"missing_github_config" });

  const canonicalUrl = normalizeUrl(apiUrl);
  if (!canonicalUrl) return res.status(400).json({ ok:false, error:"invalid_api_url" });

  const envLeagues  = String(process.env.API_FOOTBALL_LEAGUE_IDS || "")
    .split(",").map(x=>x.trim()).filter(Boolean).map(Number).filter(n=>n>0);
  const leagueIds   = envLeagues.length ? envLeagues : DEFAULT_LEAGUES;

  const today = todayKST();
  console.log(`[start] ${today} / 시즌:${season} / maxAge:${maxAge} / maxPages:${maxPages} / 리그:${leagueIds.length}개`);

  // Checkpoint
  let cp    = await loadCheckpoint(ghToken, ghRepo, ghBranch);
  let cpSha = cp.sha;
  if (cp.date !== today) {
    console.log(`[checkpoint] 날짜 변경 → 초기화`);
    cp = { date:today, done:[], sha:"" }; cpSha = "";
  }

  const doneSet   = new Set(cp.done.map(String));
  const remaining = leagueIds.filter(id => !doneSet.has(String(id)));
  console.log(`[start] 완료:${doneSet.size} / 남은:${remaining.length}`);

  if (!remaining.length) {
    return res.status(200).json({ ok:true, mode:"already_done_today", date:today, leagues_done:doneSet.size });
  }

  // 기존 선수 데이터 로드
  let existingPlayers = []; let playersSha = "";
  try {
    const { data, sha } = await ghGet(ghToken, ghRepo, ghBranch, targetPath);
    playersSha      = sha;
    existingPlayers = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
    console.log(`[merge] 기존: ${existingPlayers.length}명`);
  } catch (_) { console.log("[merge] 기존 파일 없음"); }

  let currentPlayers = existingPlayers.slice();
  let savedLeagues   = 0;
  let totalNew       = 0;

  for (const leagueId of remaining) {
    console.log(`\n[league] 리그 ${leagueId} 시작`);
    let leaguePlayers = [];
    try {
      leaguePlayers = await fetchLeaguePlayers(canonicalUrl, leagueId, season, apiKey, maxPages);
      console.log(`[league] 리그 ${leagueId} 완료: ${leaguePlayers.length}명`);
    } catch (e) {
      console.log(`[league] 리그 ${leagueId} 에러 → 건너뜀:`, String(e?.message||e));
      doneSet.add(String(leagueId));
      cp.done = Array.from(doneSet);
      cpSha   = await saveCheckpoint(ghToken, ghRepo, ghBranch, today, cp.done, cpSha);
      continue;
    }

    totalNew      += leaguePlayers.length;
    currentPlayers = mergePlayers(currentPlayers, leaguePlayers, maxAge);

    // 즉시 저장
    try {
      const body = JSON.stringify({
        updated_at:    new Date().toISOString(),
        season,
        leagues_done:  doneSet.size + 1,
        leagues_total: leagueIds.length,
        players_count: currentPlayers.length,
        items:         currentPlayers,
      }, null, 2) + "\n";

      const result = await ghPut(ghToken, ghRepo, ghBranch, targetPath, body,
        `cron: league ${leagueId} (${currentPlayers.length} players)`, playersSha);
      playersSha = result.sha;
      savedLeagues++;
      console.log(`[save] 리그 ${leagueId} → 총 ${currentPlayers.length}명`);
    } catch (e) {
      console.log(`[save] 저장 실패:`, String(e?.message||e));
    }

    doneSet.add(String(leagueId));
    cp.done = Array.from(doneSet);
    cpSha   = await saveCheckpoint(ghToken, ghRepo, ghBranch, today, cp.done, cpSha);
    console.log(`[progress] ${doneSet.size}/${leagueIds.length} | 누적: ${currentPlayers.length}명`);
  }

  // daily 저장
  try {
    const { sha: dSha } = await ghGet(ghToken, ghRepo, ghBranch, dailyPath);
    await ghPut(ghToken, ghRepo, ghBranch, dailyPath,
      JSON.stringify({ updated_at:new Date().toISOString(), season, date:today,
        leagues_done:doneSet.size, leagues_total:leagueIds.length,
        players_count:currentPlayers.length, items:currentPlayers }, null, 2) + "\n",
      `cron: daily (${currentPlayers.length} players)`, dSha);
  } catch (e) { console.log("[daily] 저장 실패:", String(e?.message||e)); }

  return res.status(200).json({
    ok:true, mode:"league_by_league_merge",
    date:today, season,
    leagues_total:leagueIds.length, leagues_done:doneSet.size,
    leagues_saved:savedLeagues, players_total:currentPlayers.length,
    new_from_api:totalNew,
  });
}
