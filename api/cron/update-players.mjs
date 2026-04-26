/**
 * update-players.mjs  —  World U25 Football Players Data Cron
 *
 * ▸ ESM (export default) — Vercel Fluid / Node 20+
 * ▸ 변수 중복 선언 완전 제거
 * ▸ 락 파일 안전 해제 (finally 블록)
 * ▸ 111개 리그 기본값 내장
 * ▸ 2초 딜레이 + rateLimit 자동 재시도
 */

/* ──────────────────────────────────────────────────────────────
   헬퍼: cron secret 읽기
────────────────────────────────────────────────────────────── */
function readCronSecret(req) {
  const header = String(req.headers["x-cron-secret"] || "").trim();
  const auth   = String(req.headers.authorization || "");
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  let query = "";
  try {
    const raw = String(req.url || "");
    const qi  = raw.indexOf("?");
    if (qi >= 0) {
      const sp = new URLSearchParams(raw.slice(qi + 1));
      query = String(sp.get("secret") || sp.get("cron_secret") || "").trim();
    }
  } catch (_) {}
  return { header, bearer, query };
}

/* ──────────────────────────────────────────────────────────────
   헬퍼: GitHub 파일 업서트
────────────────────────────────────────────────────────────── */
async function upsertGithubFile({ token, repo, branch, path, content, message }) {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const apiUrl  = `https://api.github.com/repos/${repo}/contents/${encoded}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept:        "application/vnd.github+json",
    "Content-Type":"application/json",
  };
  // 기존 SHA 조회
  let sha = "";
  const getRes = await fetch(`${apiUrl}?ref=${encodeURIComponent(branch)}`, { headers });
  if (getRes.ok) {
    const cur = await getRes.json();
    sha = String(cur?.sha || "");
  } else if (getRes.status !== 404) {
    const t = await getRes.text();
    throw new Error(`github_read_failed:${getRes.status}:${t.slice(0, 160)}`);
  }
  // 파일 쓰기
  const putRes = await fetch(apiUrl, {
    method: "PUT", headers,
    body: JSON.stringify({
      message,
      content: Buffer.from(content, "utf8").toString("base64"),
      branch,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!putRes.ok) {
    const t = await putRes.text();
    throw new Error(`github_write_failed:${putRes.status}:${t.slice(0, 160)}`);
  }
  const saved = await putRes.json();
  return { commitSha: String(saved?.commit?.sha || "") };
}

/* ──────────────────────────────────────────────────────────────
   헬퍼: 락 파일 관리
────────────────────────────────────────────────────────────── */
const LOCK_PATH    = "data/.update-lock";
const LOCK_TIMEOUT = 10; // 분

async function acquireLock(token, repo, branch) {
  if (!token || !repo) return { acquired: true, sha: "" }; // 환경변수 없으면 스킵
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept:        "application/vnd.github+json",
    "Content-Type":"application/json",
  };
  const encoded = LOCK_PATH.split("/").map(encodeURIComponent).join("/");
  const apiUrl  = `https://api.github.com/repos/${repo}/contents/${encoded}`;

  try {
    // 기존 락 확인
    const getRes = await fetch(`${apiUrl}?ref=${encodeURIComponent(branch)}`, { headers });
    let existingSha = "";

    if (getRes.ok) {
      const data     = await getRes.json();
      existingSha    = String(data?.sha || "");
      const lockedAt = Buffer.from(data.content || "", "base64").toString("utf8").trim();
      const elapsed  = (Date.now() - Date.parse(lockedAt)) / 60000;

      if (!isNaN(elapsed) && elapsed < LOCK_TIMEOUT) {
        console.log(`[lock] 중복 실행 차단 — ${elapsed.toFixed(1)}분 전 시작`);
        return { acquired: false, sha: existingSha };
      }
      console.log(`[lock] 오래된 락 (${elapsed.toFixed(1)}분) — 무시하고 진행`);
    }

    // 락 생성
    const now    = new Date().toISOString();
    const putRes = await fetch(apiUrl, {
      method: "PUT", headers,
      body: JSON.stringify({
        message: "chore: update-players lock",
        content: Buffer.from(now, "utf8").toString("base64"),
        branch,
        ...(existingSha ? { sha: existingSha } : {}),
      }),
    });
    if (!putRes.ok) {
      const t = await putRes.text();
      console.log("[lock] 락 생성 실패 (무시하고 진행):", t.slice(0, 100));
      return { acquired: true, sha: "" }; // 락 실패해도 진행
    }
    const putData = await putRes.json();
    const newSha  = String(putData?.content?.sha || "");
    console.log(`[lock] 락 생성 완료: ${now}`);
    return { acquired: true, sha: newSha };
  } catch (e) {
    console.log("[lock] 락 체크 오류 (무시하고 진행):", String(e?.message || e));
    return { acquired: true, sha: "" };
  }
}

async function releaseLock(token, repo, branch) {
  if (!token || !repo) return;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept:        "application/vnd.github+json",
    "Content-Type":"application/json",
  };
  const encoded = LOCK_PATH.split("/").map(encodeURIComponent).join("/");
  const apiUrl  = `https://api.github.com/repos/${repo}/contents/${encoded}`;

  try {
    const getRes = await fetch(`${apiUrl}?ref=${encodeURIComponent(branch)}`, { headers });
    if (!getRes.ok) return;
    const data = await getRes.json();
    await fetch(apiUrl, {
      method: "DELETE", headers,
      body: JSON.stringify({
        message: "chore: remove update-players lock",
        sha:     data.sha,
        branch,
      }),
    });
    console.log("[lock] 락 해제 완료");
  } catch (e) {
    console.log("[lock] 락 해제 실패 (무시):", String(e?.message || e));
  }
}

/* ──────────────────────────────────────────────────────────────
   헬퍼: API 호출 (딜레이 + rateLimit 재시도)
────────────────────────────────────────────────────────────── */
const CALL_DELAY_MS = Number(process.env.API_CALL_DELAY_MS  || 2000);
const RETRY_WAIT_MS = Number(process.env.API_RATE_RETRY_MS  || 10000);
const MAX_RETRIES   = 3;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchWithRetry(url, headers) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, { method: "GET", headers });

    if (res.status === 429) {
      console.log(`[rate-limit] 429 (시도 ${attempt}/${MAX_RETRIES}) → ${RETRY_WAIT_MS}ms 대기`);
      await sleep(RETRY_WAIT_MS);
      continue;
    }
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`api_failed:${res.status}:${t.slice(0, 180)}`);
    }

    const payload = await res.json();
    const errs    = payload?.errors || {};
    if (Object.keys(errs).length) {
      const isRate = Object.values(errs).some(v =>
        /rate|limit|requests/i.test(String(v))
      );
      if (isRate && attempt < MAX_RETRIES) {
        console.log(`[rate-limit] API error (시도 ${attempt}):`, JSON.stringify(errs));
        await sleep(RETRY_WAIT_MS);
        continue;
      }
      throw new Error(`api_error:${JSON.stringify(errs)}`);
    }
    return payload;
  }
  throw new Error(`rate_limit_exceeded: ${MAX_RETRIES}회 실패`);
}

/* ──────────────────────────────────────────────────────────────
   헬퍼: 데이터 정규화
────────────────────────────────────────────────────────────── */
function inferContinent(country) {
  const c = String(country || "").toLowerCase();
  if (!c || c === "-") return "-";
  const map = {
    Asia:         ["korea","japan","china","qatar","saudi","iran","iraq","uzbek","uae","thailand","vietnam","indonesia","india","malaysia","myanmar","cambodia","philippines"],
    Europe:       ["england","spain","france","germany","italy","netherlands","portugal","belgium","croatia","serbia","denmark","sweden","norway","austria","poland","russia","ukraine","romania","greece","turkey","scotland","switzerland","czech","slovakia","hungary","finland","bulgaria","albania","kosovo","lithuania","latvia","estonia","cyprus","bosnia"],
    Africa:       ["nigeria","ghana","senegal","morocco","egypt","algeria","tunisia","cameroon","ivory coast","south africa","ethiopia","kenya","tanzania","uganda","zimbabwe","zambia"],
    "North America":["usa","canada","mexico","costa rica","honduras","panama","guatemala","jamaica"],
    "South America":["brazil","argentina","uruguay","colombia","chile","ecuador","peru","paraguay","bolivia","venezuela"],
    Oceania:      ["australia","new zealand"],
  };
  for (const [cont, keys] of Object.entries(map)) {
    if (keys.some(k => c.includes(k))) return cont;
  }
  return "-";
}

function calcAge(isoDate) {
  const d = new Date(String(isoDate || "").trim());
  if (isNaN(d.getTime())) return 0;
  const now = new Date();
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) age--;
  return age > 0 ? age : 0;
}

function parseCm(v) {
  if (typeof v === "number") return Math.max(0, Math.floor(v));
  const m = String(v || "").match(/(\d+)/);
  return m ? Number(m[1]) : 0;
}
function parseKg(v) {
  if (typeof v === "number") return Math.max(0, Math.floor(v));
  const m = String(v || "").match(/(\d+)/);
  return m ? Number(m[1]) : 0;
}
function clamp(v, mn, mx) {
  const n = Number(v || 0);
  return isFinite(n) ? Math.max(mn, Math.min(mx, Math.floor(n))) : mn;
}
function normalizeFoot(v) {
  const r = String(v || "").toLowerCase();
  if (r.includes("left"))  return "Left";
  if (r.includes("right")) return "Right";
  if (r.includes("both") || r.includes("ambi")) return "Both";
  return "Unknown";
}
function cleanText(v, fb = "-") {
  const x = String(v || "").replace(/\s+/g, " ").trim();
  return x || fb;
}
function cleanName(v) {
  const n = String(v || "").replace(/\s+/g, " ").trim();
  return n && n !== "-" ? n : "";
}

function normalizeOnePlayer(p, row) {
  const stats   = Array.isArray(row?.statistics) && row.statistics.length ? row.statistics[0] : {};
  const team    = stats?.team    || {};
  const league  = stats?.league  || {};
  const birth   = String(p?.birth?.country || "").trim();
  const nat     = String(p?.nationality || row?.country || birth || "-");

  const age = Number(p?.age || row?.age || 0) || calcAge(p?.birth?.date || row?.birth_date || "");
  const id  = String(p?.id || row?.player_id || "").trim();
  const name = cleanName(
    p?.name || `${String(p?.firstname||"").trim()} ${String(p?.lastname||"").trim()}`.trim() || row?.name
  );

  if (!id || !name) return null;

  return {
    player_id:     id,
    name,
    age:           clamp(age, 0, 60),
    height_cm:     clamp(parseCm(p?.height || row?.height_cm), 0, 260),
    weight_kg:     clamp(parseKg(p?.weight || row?.weight_kg), 0, 200),
    dominant_foot: normalizeFoot(row?.dominant_foot || p?.foot || ""),
    country:       cleanText(nat),
    continent:     cleanText(row?.continent || inferContinent(nat)),
    club:          cleanText(team?.name || row?.club),
    position:      cleanText(stats?.games?.position || row?.position),
    league:        cleanText(league?.name || row?.league),
  };
}

function normalizePayload(payload) {
  const rows = Array.isArray(payload?.response) ? payload.response
             : Array.isArray(payload?.items)    ? payload.items
             : Array.isArray(payload)            ? payload : [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const p   = row?.player || row || {};
    const rec = normalizeOnePlayer(p, row);
    if (!rec || seen.has(rec.player_id)) continue;
    seen.add(rec.player_id);
    out.push(rec);
  }
  return out;
}

function filterU25(items, maxAge) {
  const hi = Math.max(1, Number(maxAge || 24));
  return (items || []).filter(p => {
    const a = Number(p?.age);
    return isFinite(a) && a > 0 && a <= hi;
  });
}

/* ──────────────────────────────────────────────────────────────
   헬퍼: URL 빌드
────────────────────────────────────────────────────────────── */
function currentSeason() {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Seoul", year: "numeric", month: "numeric",
    }).formatToParts(new Date());
    const y = Number(parts.find(p => p.type === "year")?.value  || 0);
    const m = Number(parts.find(p => p.type === "month")?.value || 0);
    return String(m < 7 ? y - 1 : y);
  } catch (_) {
    return String(new Date().getUTCFullYear());
  }
}

function parseCsv(val) {
  return String(val || "").split(",").map(x => x.trim()).filter(Boolean);
}

function buildUrls(baseUrl, season, sort) {
  // 111개 리그 기본값 (전세계 대륙별)
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

  const envIds   = parseCsv(process.env.API_FOOTBALL_LEAGUE_IDS);
  const leagueIds = envIds.length ? envIds : DEFAULT_LEAGUES;

  console.log(`[urls] season:${season} / 리그:${leagueIds.length}개 / sort:"${sort}"`);

  return leagueIds.map(id => {
    let url = baseUrl;
    url += url.includes("?") ? "&" : "?";
    url += `league=${encodeURIComponent(id)}&season=${encodeURIComponent(season)}`;
    if (sort) url += `&sort=${encodeURIComponent(sort)}`;
    return url;
  });
}

function pagedUrl(base, page) {
  const re = /([?&])page=\d+/i;
  if (re.test(base)) return base.replace(re, `$1page=${page}`);
  return base + (base.includes("?") ? "&" : "?") + `page=${page}`;
}

/* ──────────────────────────────────────────────────────────────
   메인 fetch
────────────────────────────────────────────────────────────── */
async function fetchAllPlayers({ baseUrl, apiKey, maxPages, season, sort }) {
  const headers = { "x-apisports-key": apiKey, Accept: "application/json" };
  const urls    = buildUrls(baseUrl, season, sort);
  const all     = [];
  const seen    = new Set();
  let   calls   = 0;

  console.log(`[fetch] 총 ${urls.length}개 리그 / maxPages:${maxPages} / delay:${CALL_DELAY_MS}ms`);

  for (let i = 0; i < urls.length; i++) {
    const baseLeagueUrl = urls[i];
    let totalPages = 1;

    for (let page = 1; page <= totalPages && page <= maxPages; page++) {
      if (calls > 0) await sleep(CALL_DELAY_MS);
      calls++;

      const url = pagedUrl(baseLeagueUrl, page);
      console.log(`[fetch #${calls}] 리그 ${i+1}/${urls.length} p${page}/${totalPages}`);

      let payload;
      try {
        payload = await fetchWithRetry(url, headers);
      } catch (e) {
        console.log(`[fetch] 리그 ${i+1} 에러 → 건너뜀:`, String(e?.message || e));
        break;
      }

      const pagingTotal = Number(payload?.paging?.total || 0);
      if (pagingTotal > 0) totalPages = pagingTotal;

      const players = normalizePayload(payload);
      console.log(`[fetch] results:${payload?.results ?? 0} / 정규화:${players.length}명`);

      for (const p of players) {
        if (!p.player_id || seen.has(p.player_id)) continue;
        seen.add(p.player_id);
        all.push(p);
      }
      if (!players.length && pagingTotal === 0) break;
    }
  }

  console.log(`[fetch] 완료 — API 호출:${calls}회 / 수집:${all.length}명`);
  return all;
}

/* ──────────────────────────────────────────────────────────────
   날짜 유틸
────────────────────────────────────────────────────────────── */
function kstDate() {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());
  } catch (_) {
    return new Date().toISOString().slice(0, 10);
  }
}

/* ──────────────────────────────────────────────────────────────
   URL 유효성 검사
────────────────────────────────────────────────────────────── */
function normalizePlayersUrl(raw) {
  try {
    const u = new URL(String(raw || "").trim());
    if (u.protocol !== "https:") return "";
    if (!/(^|\.)api-sports\.io$/i.test(u.hostname)) return "";
    if (!/\/players\/?$/i.test(u.pathname)) return "";
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch (_) {
    return "";
  }
}

/* ══════════════════════════════════════════════════════════════
   HANDLER
══════════════════════════════════════════════════════════════ */
export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  // ── 인증 ────────────────────────────────────────────────────
  const cronSecret = String(process.env.CRON_SECRET || "").trim();
  if (cronSecret) {
    const { header, bearer, query } = readCronSecret(req);
    if (header !== cronSecret && bearer !== cronSecret && query !== cronSecret) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
  }

  // ── 환경변수 (한 곳에서만 선언) ─────────────────────────────
  const apiKey        = String(process.env.API_FOOTBALL_KEY          || "").trim();
  const apiUrl        = String(process.env.API_FOOTBALL_PLAYERS_URL  || "").trim();
  const maxPages      = Math.max(1, Math.min(200, Number(process.env.API_FOOTBALL_MAX_PAGES || 30) || 30));
  const maxAge        = Math.max(16, Math.min(25,  Number(process.env.API_FOOTBALL_MAX_AGE  || 24) || 24));
  const minAge        = 15;
  const season        = String(process.env.API_FOOTBALL_SEASON || currentSeason()).trim();
  const sort          = String(process.env.API_FOOTBALL_SORT   || "").trim();
  const ghToken       = String(process.env.GITHUB_TOKEN  || "").trim();
  const ghRepo        = String(process.env.GITHUB_REPO   || "").trim();
  const ghBranch      = String(process.env.GITHUB_BRANCH || "main").trim();
  const targetPath    = String(process.env.REGISTERED_PLAYERS_FILE_PATH   || "data/registered_players.json").trim();
  const dailyPath     = String(process.env.DAILY_PLAYER_UPDATES_FILE_PATH || "data/daily_player_updates.json").trim();
  const triggerUrl    = String(process.env.API_SYNC_TRIGGER_URL    || "").trim();
  const triggerSecret = String(process.env.API_SYNC_TRIGGER_SECRET || "").trim();

  // ── 외부 트리거 모드 ─────────────────────────────────────────
  if (triggerUrl) {
    try {
      const up = await fetch(triggerUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(triggerSecret ? { Authorization: `Bearer ${triggerSecret}` } : {}),
        },
        body: JSON.stringify({ source: "vercel-cron", at: new Date().toISOString() }),
      });
      const text = await up.text();
      if (!up.ok) return res.status(502).json({ ok: false, error: "upstream_failed", status: up.status, body: text.slice(0, 180) });
      return res.status(200).json({ ok: true, mode: "external_trigger", status: up.status });
    } catch (e) {
      return res.status(500).json({ ok: false, error: "trigger_exception", detail: String(e?.message || e) });
    }
  }

  // ── 환경변수 체크 ────────────────────────────────────────────
  if (!apiKey || !apiUrl) {
    return res.status(200).json({
      ok: true, mode: "registered_only",
      message: "API_FOOTBALL_KEY 또는 API_FOOTBALL_PLAYERS_URL 미설정. 데이터 수집 불가.",
    });
  }
  if (!ghToken || !ghRepo) {
    return res.status(400).json({ ok: false, error: "missing_github_config" });
  }
  const canonicalUrl = normalizePlayersUrl(apiUrl);
  if (!canonicalUrl) {
    return res.status(400).json({ ok: false, error: "invalid_api_url",
      message: "API_FOOTBALL_PLAYERS_URL은 https://v3.football.api-sports.io/players 형식이어야 합니다." });
  }

  // ── 중복 실행 방지 락 ────────────────────────────────────────
  const lock = await acquireLock(ghToken, ghRepo, ghBranch);
  if (!lock.acquired) {
    return res.status(200).json({
      ok: false, error: "already_running",
      message: "다른 인스턴스가 실행 중입니다. 잠시 후 다시 시도하세요.",
    });
  }

  // ── 메인 실행 ────────────────────────────────────────────────
  try {
    const allItems = await fetchAllPlayers({ baseUrl: canonicalUrl, apiKey, maxPages, season, sort });
    const u25      = filterU25(allItems, maxAge);

    console.log(`[summary] 전체:${allItems.length} / U25(≤${maxAge}):${u25.length}`);

    if (!u25.length) {
      return res.status(200).json({
        ok: true, mode: "no_u25_data",
        message: "U25 선수 없음. 시즌/리그 설정을 확인하세요.",
        rows_total: allItems.length,
      });
    }

    // registered_players.json 저장
    const saved = await upsertGithubFile({
      token: ghToken, repo: ghRepo, branch: ghBranch, path: targetPath,
      content: JSON.stringify({ items: u25 }, null, 2) + "\n",
      message: `cron: U25 players (${u25.length})`,
    });

    // daily_player_updates.json 저장
    const savedDaily = await upsertGithubFile({
      token: ghToken, repo: ghRepo, branch: ghBranch, path: dailyPath,
      content: JSON.stringify({
        updated_at:    new Date().toISOString(),
        kst_date:      kstDate(),
        age_min:       minAge,
        age_max:       maxAge,
        players_count: u25.length,
        season,
        items:         u25,
      }, null, 2) + "\n",
      message: `cron: daily U25 overlay (${u25.length})`,
    });

    return res.status(200).json({
      ok:               true,
      mode:             "api_football_to_github",
      players:          u25.length,
      rows_total:       allItems.length,
      season,
      max_age:          maxAge,
      path:             targetPath,
      daily_path:       dailyPath,
      commit_sha:       saved.commitSha,
      daily_commit_sha: savedDaily.commitSha,
    });

  } catch (err) {
    console.error("[handler] 오류:", String(err?.message || err));
    return res.status(500).json({
      ok: false, error: "update_failed",
      detail: String(err?.message || err),
    });
  } finally {
    // 성공/실패 모두 락 해제
    await releaseLock(ghToken, ghRepo, ghBranch);
  }
}
