/**
 * update-players.mjs  v2  —  World U25 Football Players Data
 *
 * 핵심 개선:
 * ① 리그 1개 완료마다 즉시 GitHub에 저장 (타임아웃 방지)
 * ② 기존 데이터 + 신규 데이터 Merge (덮어쓰기 금지)
 * ③ Checkpoint: 오늘 완료한 리그는 다음 실행에서 스킵
 * ④ 간단한 Lock 메커니즘 (중복 실행 방지)
 */

/* ── 인증 ────────────────────────────────────────────────────── */
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

/* ── 슬립 ────────────────────────────────────────────────────── */
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── GitHub 파일 읽기 ─────────────────────────────────────────── */
async function ghGet(token, repo, branch, path) {
  const url = `https://api.github.com/repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`;
  const res  = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (res.status === 404) return { exists: false, sha: "", data: null };
  if (!res.ok) throw new Error(`gh_read:${res.status}`);
  const json = await res.json();
  const content = Buffer.from(json.content || "", "base64").toString("utf8");
  let data = null;
  try { data = JSON.parse(content); } catch (_) {}
  return { exists: true, sha: json.sha, data };
}

/* ── GitHub 파일 쓰기 ─────────────────────────────────────────── */
async function ghPut(token, repo, branch, path, content, message, sha) {
  const url = `https://api.github.com/repos/${repo}/contents/${path}`;
  const body = {
    message,
    content: Buffer.from(content, "utf8").toString("base64"),
    branch,
  };
  if (sha) body.sha = sha;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`gh_write:${res.status}:${t.slice(0, 120)}`);
  }
  const json = await res.json();
  return { sha: json.content?.sha || "", commitSha: json.commit?.sha || "" };
}

/* ── Checkpoint 읽기/쓰기 ─────────────────────────────────────── */
const CHECKPOINT_PATH = "data/.checkpoint.json";

async function loadCheckpoint(token, repo, branch) {
  try {
    const { data } = await ghGet(token, repo, branch, CHECKPOINT_PATH);
    if (!data) return { date: "", done: [] };
    return { date: String(data.date || ""), done: Array.isArray(data.done) ? data.done : [] };
  } catch (_) {
    return { date: "", done: [] };
  }
}

async function saveCheckpoint(token, repo, branch, date, done, sha) {
  try {
    const content = JSON.stringify({ date, done, updated_at: new Date().toISOString() }, null, 2);
    const result  = await ghPut(token, repo, branch, CHECKPOINT_PATH, content,
      `chore: checkpoint (${done.length} leagues done)`, sha);
    return result.sha;
  } catch (e) {
    console.log("[checkpoint] 저장 실패 (무시):", String(e?.message || e));
    return sha;
  }
}

/* ── Lock ────────────────────────────────────────────────────── */
const LOCK_PATH    = "data/.lock";
const LOCK_TIMEOUT = 15; // 분

async function acquireLock(token, repo, branch) {
  try {
    const { exists, sha, data } = await ghGet(token, repo, branch, LOCK_PATH);
    if (exists && data) {
      const elapsed = (Date.now() - Date.parse(data.at || "")) / 60000;
      if (!isNaN(elapsed) && elapsed < LOCK_TIMEOUT) {
        console.log(`[lock] 중복 실행 차단 (${elapsed.toFixed(1)}분 전 시작)`);
        return { ok: false, sha };
      }
    }
    const content = JSON.stringify({ at: new Date().toISOString() });
    const result  = await ghPut(token, repo, branch, LOCK_PATH, content,
      "chore: lock", exists ? sha : undefined);
    console.log("[lock] 락 생성 완료");
    return { ok: true, sha: result.sha };
  } catch (e) {
    console.log("[lock] 락 오류 (무시하고 진행):", String(e?.message || e));
    return { ok: true, sha: "" };
  }
}

async function releaseLock(token, repo, branch) {
  try {
    const { exists, sha } = await ghGet(token, repo, branch, LOCK_PATH);
    if (!exists) return;
    await fetch(`https://api.github.com/repos/${repo}/contents/${LOCK_PATH}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: "chore: unlock", sha, branch }),
    });
    console.log("[lock] 락 해제 완료");
  } catch (e) {
    console.log("[lock] 락 해제 실패 (무시):", String(e?.message || e));
  }
}

/* ── 데이터 정규화 ────────────────────────────────────────────── */
function inferContinent(country) {
  const c = String(country || "").toLowerCase();
  const map = {
    Asia: ["korea","japan","china","qatar","saudi","iran","iraq","uzbek","uae","thailand","vietnam","indonesia","india","malaysia"],
    Europe: ["england","spain","france","germany","italy","netherlands","portugal","belgium","croatia","serbia","denmark","sweden","norway","austria","poland","russia","ukraine","romania","greece","turkey","scotland","switzerland","czech","slovakia","hungary","finland","bulgaria","albania","kosovo","lithuania","latvia","estonia","cyprus","bosnia"],
    Africa: ["nigeria","ghana","senegal","morocco","egypt","algeria","tunisia","cameroon","ivory","south africa","ethiopia","kenya","tanzania","uganda","zimbabwe","zambia"],
    "North America": ["usa","canada","mexico","costa rica","honduras","panama","guatemala"],
    "South America": ["brazil","argentina","uruguay","colombia","chile","ecuador","peru","paraguay","bolivia","venezuela"],
    Oceania: ["australia","new zealand"],
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

function parseCm(v) { const m = String(v||"").match(/(\d+)/); return m ? Number(m[1]) : 0; }
function parseKg(v) { const m = String(v||"").match(/(\d+)/); return m ? Number(m[1]) : 0; }
function normFoot(v) {
  const r = String(v||"").toLowerCase();
  if (r.includes("left")) return "Left";
  if (r.includes("right")) return "Right";
  if (r.includes("both")||r.includes("ambi")) return "Both";
  return "Unknown";
}
function clamp(v,mn,mx) { const n=Number(v||0); return isFinite(n)?Math.max(mn,Math.min(mx,Math.floor(n))):mn; }
function clean(v, fb="-") { const x=String(v||"").trim(); return x||fb; }

function normalizePlayers(payload, leagueName) {
  const rows = Array.isArray(payload?.response) ? payload.response
             : Array.isArray(payload?.items)    ? payload.items
             : [];
  const out  = [];
  const seen = new Set();
  for (const row of rows) {
    const p     = row?.player || row || {};
    const stats = Array.isArray(row?.statistics) && row.statistics.length ? row.statistics[0] : {};
    const team  = stats?.team || {};
    const lg    = stats?.league || {};
    const nat   = String(p?.nationality || row?.country || p?.birth?.country || "-");
    const age   = Number(p?.age || row?.age || 0) || calcAge(p?.birth?.date || "");
    const id    = String(p?.id || row?.player_id || "").trim();
    const first = String(p?.firstname || "").trim();
    const last  = String(p?.lastname  || "").trim();
    const name  = String(p?.name || row?.name || (first && last ? `${first} ${last}` : first || last) || "").trim();
    if (!id || !name) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      player_id:     id,
      name,
      age:           clamp(age, 0, 60),
      height_cm:     clamp(parseCm(p?.height || row?.height_cm), 0, 260),
      weight_kg:     clamp(parseKg(p?.weight || row?.weight_kg), 0, 200),
      dominant_foot: normFoot(row?.dominant_foot || p?.foot || ""),
      country:       clean(nat),
      continent:     clean(row?.continent || inferContinent(nat)),
      club:          clean(team?.name || row?.club),
      position:      clean(stats?.games?.position || row?.position),
      league:        clean(lg?.name || leagueName || row?.league),
    });
  }
  return out;
}

/* ── 리그별 선수 fetch ───────────────────────────────────────────── */
async function fetchLeaguePlayers(baseUrl, leagueId, season, apiKey, maxPages) {
  const headers  = { "x-apisports-key": apiKey, Accept: "application/json" };
  const DELAY    = Number(process.env.API_CALL_DELAY_MS || 1000);
  const RETRY_MS = Number(process.env.API_RATE_RETRY_MS || 8000);
  const all      = [];
  const seen     = new Set();
  let   totalPages = 1;

  for (let page = 1; page <= totalPages && page <= maxPages; page++) {
    if (page > 1) await sleep(DELAY);

    const url = `${baseUrl}?league=${leagueId}&season=${season}&page=${page}`;
    console.log(`[fetch] 리그${leagueId} p${page}/${totalPages} → ${url}`);

    let payload;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await fetch(url, { method: "GET", headers });
      if (res.status === 429) {
        console.log(`[rate] 429 → ${RETRY_MS}ms 대기 (${attempt}/3)`);
        await sleep(RETRY_MS);
        continue;
      }
      if (!res.ok) throw new Error(`api:${res.status}`);
      payload = await res.json();
      const errs = payload?.errors || {};
      if (Object.keys(errs).length) {
        const isRate = Object.values(errs).some(v => /rate|limit|request/i.test(String(v)));
        if (isRate && attempt < 3) { await sleep(RETRY_MS); continue; }
        throw new Error(`api_err:${JSON.stringify(errs)}`);
      }
      break;
    }
    if (!payload) throw new Error("api: max retries");

    const paging = Number(payload?.paging?.total || 0);
    if (paging > 0) totalPages = paging;
    console.log(`[fetch] results:${payload?.results||0} paging:${payload?.paging?.current}/${totalPages}`);

    // 리그 이름 추출
    const lgName = payload?.response?.[0]?.statistics?.[0]?.league?.name || "";
    const players = normalizePlayers(payload, lgName);
    console.log(`[fetch] 정규화: ${players.length}명`);

    for (const p of players) {
      if (!seen.has(p.player_id)) { seen.add(p.player_id); all.push(p); }
    }

    await sleep(DELAY);
  }

  return all;
}

/* ── 기존 데이터와 Merge ─────────────────────────────────────────── */
function mergePlayers(existing, newPlayers, maxAge) {
  const map = new Map();
  // 기존 데이터 먼저
  for (const p of (existing || [])) {
    if (p?.player_id) map.set(String(p.player_id), p);
  }
  // 신규 데이터로 덮어쓰기 (최신 정보 우선)
  for (const p of (newPlayers || [])) {
    if (p?.player_id) map.set(String(p.player_id), p);
  }
  // U25 필터
  const hi = Math.max(1, Number(maxAge || 24));
  return Array.from(map.values()).filter(p => {
    const a = Number(p?.age);
    return isFinite(a) && a > 0 && a <= hi;
  });
}

/* ── 오늘 날짜 (KST) ──────────────────────────────────────────────── */
function todayKST() {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());
  } catch (_) { return new Date().toISOString().slice(0, 10); }
}

/* ── URL 정규화 ───────────────────────────────────────────────────── */
function normalizeUrl(raw) {
  try {
    const u = new URL(String(raw || "").trim());
    if (u.protocol !== "https:") return "";
    if (!/(^|\.)api-sports\.io$/i.test(u.hostname)) return "";
    if (!/\/players\/?$/i.test(u.pathname)) return "";
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch (_) { return ""; }
}

/* ── 기본 리그 목록 ───────────────────────────────────────────────── */
const DEFAULT_LEAGUES = [
  // 유럽 1부
  39,140,78,135,61,88,94,203,144,179,197,207,218,113,103,119,168,182,332,235,333,271,106,383,244,210,169,283,286,291,392,395,398,198,
  // 유럽 2부
  40,141,79,136,62,89,95,145,208,45,46,
  // 아시아
  292,293,98,99,100,307,308,322,323,324,289,290,296,301,302,303,334,336,351,363,369,371,310,294,
  // 남미
  71,72,73,128,129,239,240,265,268,273,266,267,242,243,284,
  // 아프리카
  200,201,202,204,206,772,773,774,776,778,780,771,782,783,784,
  // 북중미
  253,254,255,262,263,164,328,327,330,
  // 오세아니아
  188,190,
];

/* ══════════════════════════════════════════════════════════════
   HANDLER
══════════════════════════════════════════════════════════════ */
export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "method_not_allowed" });

  // 인증
  const cronSecret = String(process.env.CRON_SECRET || "").trim();
  if (cronSecret) {
    const { h, b, q } = readSecret(req);
    if (h !== cronSecret && b !== cronSecret && q !== cronSecret) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
  }

  // 환경변수
  const apiKey     = String(process.env.API_FOOTBALL_KEY         || "").trim();
  const apiUrl     = String(process.env.API_FOOTBALL_PLAYERS_URL || "").trim();
  const maxPages   = Math.max(1, Math.min(200, Number(process.env.API_FOOTBALL_MAX_PAGES || 10) || 10));
  const maxAge     = Math.max(16, Math.min(25,  Number(process.env.API_FOOTBALL_MAX_AGE  || 23) || 23));
  const season     = String(process.env.API_FOOTBALL_SEASON || (() => {
    try {
      const p = new Intl.DateTimeFormat("en-US", { timeZone:"Asia/Seoul", year:"numeric", month:"numeric" }).formatToParts(new Date());
      const y = Number(p.find(x=>x.type==="year")?.value||0);
      const m = Number(p.find(x=>x.type==="month")?.value||0);
      return String(m < 7 ? y-1 : y);
    } catch(_) { return String(new Date().getUTCFullYear()); }
  })()).trim();
  const ghToken    = String(process.env.GITHUB_TOKEN  || "").trim();
  const ghRepo     = String(process.env.GITHUB_REPO   || "").trim();
  const ghBranch   = String(process.env.GITHUB_BRANCH || "main").trim();
  const targetPath = String(process.env.REGISTERED_PLAYERS_FILE_PATH   || "data/registered_players.json").trim();
  const dailyPath  = String(process.env.DAILY_PLAYER_UPDATES_FILE_PATH || "data/daily_player_updates.json").trim();

  if (!apiKey || !apiUrl) return res.status(200).json({ ok: true, mode: "no_api_key" });
  if (!ghToken || !ghRepo) return res.status(400).json({ ok: false, error: "missing_github_config" });

  const canonicalUrl = normalizeUrl(apiUrl);
  if (!canonicalUrl) return res.status(400).json({ ok: false, error: "invalid_api_url" });

  // 리그 목록
  const envLeagues = String(process.env.API_FOOTBALL_LEAGUE_IDS || "")
    .split(",").map(x=>x.trim()).filter(Boolean).map(Number).filter(n=>n>0);
  const leagueIds = envLeagues.length ? envLeagues : DEFAULT_LEAGUES;

  // Lock
  const lock = await acquireLock(ghToken, ghRepo, ghBranch);
  if (!lock.ok) {
    return res.status(200).json({ ok: false, error: "already_running" });
  }

  try {
    const today = todayKST();

    // Checkpoint 로드
    let checkpoint = await loadCheckpoint(ghToken, ghRepo, ghBranch);
    let checkpointSha = "";

    // 오늘 날짜가 아니면 초기화
    if (checkpoint.date !== today) {
      console.log(`[checkpoint] 날짜 변경 (${checkpoint.date} → ${today}) — 초기화`);
      checkpoint = { date: today, done: [] };
    }

    const doneSet = new Set(checkpoint.done.map(String));
    const remaining = leagueIds.filter(id => !doneSet.has(String(id)));
    console.log(`[start] 시즌:${season} / 전체:${leagueIds.length}개 / 완료:${doneSet.size}개 / 남은:${remaining.length}개`);

    if (remaining.length === 0) {
      return res.status(200).json({
        ok: true, mode: "already_done_today",
        message: `오늘(${today}) 모든 리그 완료됨.`,
        leagues_total: leagueIds.length,
        leagues_done: doneSet.size,
      });
    }

    // 기존 데이터 로드
    let existingPlayers = [];
    let existingSha = "";
    try {
      const { data, sha } = await ghGet(ghToken, ghRepo, ghBranch, targetPath);
      existingSha = sha;
      existingPlayers = Array.isArray(data?.items) ? data.items
                      : Array.isArray(data)        ? data : [];
      console.log(`[merge] 기존 선수: ${existingPlayers.length}명`);
    } catch (e) {
      console.log("[merge] 기존 파일 없음 — 새로 시작");
    }

    // 리그별 처리
    let savedCount   = 0;
    let totalNew     = 0;
    let currentPlayers = existingPlayers.slice();

    for (const leagueId of remaining) {
      console.log(`\n[league] 리그 ${leagueId} 시작`);
      let leaguePlayers = [];
      try {
        leaguePlayers = await fetchLeaguePlayers(canonicalUrl, leagueId, season, apiKey, maxPages);
        console.log(`[league] 리그 ${leagueId} 완료: ${leaguePlayers.length}명`);
      } catch (e) {
        console.log(`[league] 리그 ${leagueId} 에러 → 건너뜀:`, String(e?.message || e));
        // 실패한 리그도 done에 추가 (무한 반복 방지)
        doneSet.add(String(leagueId));
        checkpoint.done = Array.from(doneSet);
        checkpointSha = await saveCheckpoint(ghToken, ghRepo, ghBranch, today, checkpoint.done, checkpointSha);
        continue;
      }

      totalNew += leaguePlayers.length;

      // Merge
      const merged = mergePlayers(currentPlayers, leaguePlayers, maxAge);
      currentPlayers = merged;

      // 즉시 GitHub 저장
      try {
        const content = JSON.stringify({ 
          updated_at: new Date().toISOString(),
          season,
          leagues_done: doneSet.size + 1,
          leagues_total: leagueIds.length,
          players_count: merged.length,
          items: merged 
        }, null, 2) + "\n";

        const result = await ghPut(ghToken, ghRepo, ghBranch, targetPath, content,
          `cron: league ${leagueId} done (${merged.length} players total)`, existingSha);
        existingSha = result.sha;
        savedCount++;
        console.log(`[save] 리그 ${leagueId} 저장 완료 → 총 ${merged.length}명 (SHA: ${result.commitSha.slice(0,7)})`);
      } catch (e) {
        console.log(`[save] 리그 ${leagueId} 저장 실패:`, String(e?.message || e));
      }

      // Checkpoint 업데이트
      doneSet.add(String(leagueId));
      checkpoint.done = Array.from(doneSet);
      checkpointSha = await saveCheckpoint(ghToken, ghRepo, ghBranch, today, checkpoint.done, checkpointSha);

      console.log(`[progress] 완료: ${doneSet.size}/${leagueIds.length} | 누적 선수: ${currentPlayers.length}명`);
    }

    // daily_player_updates.json 저장
    try {
      const { sha: dSha } = await ghGet(ghToken, ghRepo, ghBranch, dailyPath);
      await ghPut(ghToken, ghRepo, ghBranch, dailyPath,
        JSON.stringify({
          updated_at:    new Date().toISOString(),
          season,
          date:          today,
          leagues_done:  doneSet.size,
          leagues_total: leagueIds.length,
          players_count: currentPlayers.length,
          items:         currentPlayers,
        }, null, 2) + "\n",
        `cron: daily update (${currentPlayers.length} players)`,
        dSha
      );
    } catch (e) {
      console.log("[daily] 저장 실패 (무시):", String(e?.message || e));
    }

    return res.status(200).json({
      ok:             true,
      mode:           "league_by_league_merge",
      date:           today,
      season,
      leagues_total:  leagueIds.length,
      leagues_done:   doneSet.size,
      leagues_saved:  savedCount,
      players_total:  currentPlayers.length,
      new_from_api:   totalNew,
    });

  } catch (err) {
    console.error("[handler] 오류:", String(err?.message || err));
    return res.status(500).json({ ok: false, error: "failed", detail: String(err?.message || err) });
  } finally {
    await releaseLock(ghToken, ghRepo, ghBranch);
  }
}
