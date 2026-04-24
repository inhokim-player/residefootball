function readCronSecretFromRequest(req) {
  const incomingHeader = String(req.headers["x-cron-secret"] || "").trim();
  const authRaw = String(req.headers.authorization || "");
  const bearer = authRaw.toLowerCase().startsWith("bearer ")
    ? authRaw.slice(7).trim()
    : "";
  let fromQuery = "";
  try {
    const q = req.query && typeof req.query === "object" ? req.query : null;
    if (q) {
      const a = q.secret ?? q.cron_secret;
      if (Array.isArray(a)) fromQuery = String(a[0] || "").trim();
      else if (a != null) fromQuery = String(a).trim();
    }
  } catch (e) {
    // ignore
  }
  if (!fromQuery) {
    try {
      const raw = String(req.url || "");
      const i = raw.indexOf("?");
      if (i >= 0) {
        const sp = new URLSearchParams(raw.slice(i + 1));
        fromQuery = String(sp.get("secret") || sp.get("cron_secret") || "").trim();
      }
    } catch (e) {
      // ignore
    }
  }
  return { incomingHeader, bearer, fromQuery };
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  const cronSecret = process.env.CRON_SECRET || "";
  if (cronSecret) {
    const { incomingHeader, bearer, fromQuery } = readCronSecretFromRequest(req);
    const ok =
      incomingHeader === cronSecret ||
      bearer === cronSecret ||
      fromQuery === cronSecret;
    if (!ok) {
      return res.status(401).json({
        ok: false,
        error: "unauthorized",
        hint: "Set the same value as CRON_SECRET using header x-cron-secret, Authorization: Bearer ..., or query ?secret= (query may appear in access logs).",
      });
    }
  }

  const triggerUrl = process.env.API_SYNC_TRIGGER_URL || "";
  const triggerSecret = process.env.API_SYNC_TRIGGER_SECRET || "";
  if (triggerUrl) {
    try {
      const upstream = await fetch(triggerUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(triggerSecret ? { Authorization: `Bearer ${triggerSecret}` } : {}),
        },
        body: JSON.stringify({
          source: "vercel-cron",
          at: new Date().toISOString(),
        }),
      });
      const text = await upstream.text();
      if (!upstream.ok) {
        return res.status(502).json({
          ok: false,
          error: "upstream_failed",
          status: upstream.status,
          body_preview: text.slice(0, 180),
        });
      }
      return res.status(200).json({
        ok: true,
        mode: "external_trigger",
        triggered: true,
        status: upstream.status,
      });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: "trigger_exception",
        detail: String(err && err.message ? err.message : err),
      });
    }
  }

  const apiFootballKey = String(process.env.API_FOOTBALL_KEY || "").trim();
  const apiFootballPlayersUrl = String(process.env.API_FOOTBALL_PLAYERS_URL || "").trim();
  const apiFootballMaxPages = Math.max(1, Math.min(200, Number(process.env.API_FOOTBALL_MAX_PAGES || 30) || 30));
  const githubToken = String(process.env.GITHUB_TOKEN || "").trim();
  const githubRepo = String(process.env.GITHUB_REPO || "").trim(); // owner/repo
  const githubBranch = String(process.env.GITHUB_BRANCH || "main").trim();
  const targetPath = String(process.env.REGISTERED_PLAYERS_FILE_PATH || "data/registered_players.json").trim();
  const dailyPath = String(process.env.DAILY_PLAYER_UPDATES_FILE_PATH || "data/daily_player_updates.json").trim();

  if (!apiFootballKey || !apiFootballPlayersUrl) {
    return res.status(200).json({
      ok: true,
      mode: "registered_only",
      message:
        "No API_FOOTBALL_KEY / API_FOOTBALL_PLAYERS_URL in Vercel env: this endpoint does not pull players. Set those (and GITHUB_*) to refresh registered_players.json, or set API_SYNC_TRIGGER_URL to call your sync service.",
      kst_schedule: "10:00",
    });
  }

  if (!githubToken || !githubRepo) {
    return res.status(400).json({
      ok: false,
      error: "missing_github_config",
      message: "Set GITHUB_TOKEN and GITHUB_REPO to persist updated players.",
    });
  }

  const canonicalPlayersBase = normalizePlayersEndpoint(apiFootballPlayersUrl);
  if (!canonicalPlayersBase) {
    return res.status(400).json({
      ok: false,
      error: "invalid_api_players_url",
      message:
        "API_FOOTBALL_PLAYERS_URL must target API-Football players endpoint. Example: https://v3.football.api-sports.io/players",
    });
  }

  try {
    const maxAge = Math.max(16, Math.min(24, Number(process.env.API_FOOTBALL_MAX_AGE || 24) || 24));
    const minAge = 15;
    const items = await fetchAllApiFootballPlayers({
      apiFootballPlayersUrl: canonicalPlayersBase,
      apiFootballKey,
      maxPages: apiFootballMaxPages,
      minAge,
      maxAge,
    });
    const u25 = filterUnderAge(items, maxAge);
    console.log(
      "[update-players] rows summary:",
      JSON.stringify({
        rows_total: items.length,
        rows_under_u25: u25.length,
        max_age: maxAge,
      })
    );
    if (!u25.length) {
      return res.status(200).json({
        ok: true,
        mode: "no_u25_data",
        status: "no_u25_players_found",
        message: "no_u25_players_found",
        rows_total: items.length,
        rows_under_u25: 0,
        kst_schedule_fixed: "10:00",
      });
    }

    const body = JSON.stringify({ items: u25 }, null, 2) + "\n";
    const saved = await upsertGithubFile({
      githubToken,
      githubRepo,
      githubBranch,
      path: targetPath,
      content: body,
      message: `cron: under-u25 registered players (${u25.length})`,
    });

    const dailyBody =
      JSON.stringify(
        {
          updated_at: new Date().toISOString(),
          kst_date: formatDateInTimeZone(new Date(), "Asia/Seoul"),
          age_min: minAge,
          age_max: maxAge,
          players_count: u25.length,
          source_mode: "api-football-global-u25-market-value",
          items: u25,
        },
        null,
        2
      ) + "\n";
    const savedDaily = await upsertGithubFile({
      githubToken,
      githubRepo,
      githubBranch,
      path: dailyPath,
      content: dailyBody,
      message: `cron: daily U25 overlay (${u25.length})`,
    });

    return res.status(200).json({
      ok: true,
      mode: "api_football_to_github",
      players: u25.length,
      max_pages: apiFootballMaxPages,
      kst_schedule_fixed: "10:00",
      age_min: minAge,
      age_max: maxAge,
      leagues: parseCsvEnv(process.env.API_FOOTBALL_LEAGUE_IDS, []),
      season: String(process.env.API_FOOTBALL_SEASON || currentLikelySeasonKst()).trim(),
      sort: String(process.env.API_FOOTBALL_SORT || "").trim(),
      path: targetPath,
      daily_path: dailyPath,
      commit_sha: saved.commitSha,
      daily_commit_sha: savedDaily.commitSha,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "update_failed",
      detail: String(err && err.message ? err.message : err),
    });
  }
}

function filterUnderAge(items, maxAge) {
  const hi = Math.max(1, Number(maxAge || 24));
  return (items || []).filter((p) => {
    const a = Number(p?.age);
    if (!Number.isFinite(a) || a <= 0) return false;
    return a <= hi;
  });
}

function formatDateInTimeZone(date, tz) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  } catch (e) {
    return new Date(date).toISOString().slice(0, 10);
  }
}

function normalizeApiFootballPlayers(payload) {
  const rows = Array.isArray(payload?.response)
    ? payload.response
    : Array.isArray(payload?.items)
      ? payload.items
      : Array.isArray(payload)
        ? payload
        : [];

  const out = [];
  for (const row of rows) {
    const p = row?.player || row || {};
    const stats0 = Array.isArray(row?.statistics) && row.statistics.length ? row.statistics[0] : {};
    const team = stats0?.team || {};
    const league = stats0?.league || {};
    const birthCountry = String(p?.birth?.country || "").trim();
    const normalized = normalizeOnePlayer({
      player_id: String(p?.id || row?.player_id || "").trim(),
      name: pickPlayerName(p, row),
      age: resolveAge(p, row),
      height_cm: parseCm(p?.height || row?.height_cm || row?.height),
      weight_kg: parseKg(p?.weight || row?.weight_kg || row?.weight),
      dominant_foot: normalizeFoot(row?.dominant_foot || row?.foot || p?.foot || ""),
      country: String(p?.nationality || row?.country || birthCountry || "-"),
      continent: String(row?.continent || inferContinent(p?.nationality || row?.country || birthCountry || "-")),
      club: String(team?.name || row?.club || "-"),
      position: String(stats0?.games?.position || row?.position || "-"),
      league: String(league?.name || row?.league || "-"),
    });
    if (normalized) out.push(normalized);
  }
  return dedupePlayers(out);
}

function resolveAge(playerObj, rowObj) {
  const p = playerObj || {};
  const r = rowObj || {};
  const direct = Number(p?.age || r?.age || 0) || 0;
  if (direct > 0) return direct;
  const birth =
    String(p?.birth?.date || r?.birth_date || r?.birth || "").trim();
  const fromBirth = calcAgeFromBirthDate(birth);
  return fromBirth > 0 ? fromBirth : 0;
}

function calcAgeFromBirthDate(isoDateLike) {
  const raw = String(isoDateLike || "").trim();
  if (!raw) return 0;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return 0;
  const now = new Date();
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) age -= 1;
  return age > 0 ? age : 0;
}

function pickPlayerName(playerObj, rowObj) {
  const p = playerObj || {};
  const full = String(p?.name || rowObj?.name || "").trim();
  const composed = `${String(p?.firstname || "").trim()} ${String(p?.lastname || "").trim()}`.trim();
  return full || composed || "";
}

function normalizeOnePlayer(input) {
  const playerId = String(input?.player_id || "").trim();
  const name = cleanName(input?.name);
  if (!playerId || !name) return null;
  const country = cleanText(input?.country, "-");
  return {
    player_id: playerId,
    name,
    age: clampInt(input?.age, 0, 60),
    height_cm: clampInt(input?.height_cm, 0, 260),
    weight_kg: clampInt(input?.weight_kg, 0, 200),
    dominant_foot: normalizeFoot(input?.dominant_foot),
    country,
    continent: cleanText(input?.continent, inferContinent(country)),
    club: cleanText(input?.club, "-"),
    position: cleanText(input?.position, "-"),
    league: cleanText(input?.league, "-"),
  };
}

function dedupePlayers(items) {
  const byId = new Map();
  for (const item of items || []) {
    if (!item?.player_id) continue;
    byId.set(item.player_id, item);
  }
  return Array.from(byId.values());
}

function cleanName(v) {
  const name = String(v || "").replace(/\s+/g, " ").trim();
  return name && name !== "-" ? name : "";
}

function cleanText(v, fallback = "-") {
  const text = String(v || "").replace(/\s+/g, " ").trim();
  return text || fallback;
}

function clampInt(v, min, max) {
  const n = Number(v || 0);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function normalizeFoot(v) {
  const raw = String(v || "").toLowerCase().trim();
  if (raw.includes("left")) return "Left";
  if (raw.includes("right")) return "Right";
  if (raw.includes("both") || raw.includes("ambi")) return "Both";
  return "Unknown";
}

function inferContinent(country) {
  const c = String(country || "").toLowerCase().trim();
  if (!c || c === "-") return "-";
  const asia = ["korea", "japan", "china", "qatar", "saudi", "iran", "iraq", "uzbek", "uae", "thailand", "vietnam", "indonesia", "india"];
  const europe = ["england", "spain", "france", "germany", "italy", "netherlands", "portugal", "belgium", "croatia", "serbia", "denmark", "sweden", "norway"];
  const africa = ["nigeria", "ghana", "senegal", "morocco", "egypt", "algeria", "tunisia", "cameroon", "ivory coast"];
  const northAmerica = ["usa", "canada", "mexico", "costa rica", "jamaica", "honduras", "panama"];
  const southAmerica = ["brazil", "argentina", "uruguay", "colombia", "chile", "ecuador", "peru", "paraguay", "bolivia", "venezuela"];
  const oceania = ["australia", "new zealand"];
  if (asia.some((k) => c.includes(k))) return "Asia";
  if (europe.some((k) => c.includes(k))) return "Europe";
  if (africa.some((k) => c.includes(k))) return "Africa";
  if (northAmerica.some((k) => c.includes(k))) return "North America";
  if (southAmerica.some((k) => c.includes(k))) return "South America";
  if (oceania.some((k) => c.includes(k))) return "Oceania";
  return "-";
}

async function fetchAllApiFootballPlayers({
  apiFootballPlayersUrl,
  apiFootballKey,
  maxPages,
  minAge,
  maxAge,
}) {
  const headers = {
    "x-apisports-key": apiFootballKey,
    Accept: "application/json",
  };
  const all = [];
  const seen = new Set();
  const leagueUrls = buildLeagueScopedBaseUrls(apiFootballPlayersUrl, minAge, maxAge);

  for (const oneBaseUrl of leagueUrls) {
    let totalPages = 1;
    for (let page = 1; page <= totalPages && page <= maxPages; page += 1) {
      const url = buildPagedUrl(oneBaseUrl, page);
      const apiRes = await fetch(url, { method: "GET", headers });
      if (!apiRes.ok) {
        const text = await apiRes.text();
        throw new Error(`api_football_failed:${apiRes.status}:${text.slice(0, 180)}`);
      }
      const payload = await apiRes.json();
      const onePage = normalizeApiFootballPlayers(payload);
      for (const p of onePage) {
        if (!p.player_id || seen.has(p.player_id)) continue;
        seen.add(p.player_id);
        all.push(p);
      }
      const pagingTotal = Number(payload?.paging?.total || 0);
      if (pagingTotal > 0) {
        totalPages = pagingTotal;
      } else if (!onePage.length) {
        break;
      }
    }
  }
  return all;
}

function parseCsvEnv(value, fallback = []) {
  const raw = String(value || "").trim();
  if (!raw) return fallback.slice();
  return raw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function currentLikelySeasonKst() {
  try {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", year: "numeric", month: "numeric" }).formatToParts(now);
    const year = Number(parts.find((p) => p.type === "year")?.value || 0);
    const month = Number(parts.find((p) => p.type === "month")?.value || 0);
    if (!year || !month) return String(new Date().getUTCFullYear());
    // 유럽 주요 리그 기준: 7월 이전은 이전 시즌으로 간주.
    return String(month < 7 ? year - 1 : year);
  } catch (e) {
    return String(new Date().getUTCFullYear());
  }
}

function normalizePlayersEndpoint(rawUrl) {
  try {
    const u = new URL(String(rawUrl || "").trim());
    const isHttps = u.protocol === "https:";
    const hostOk = /(^|\.)api-sports\.io$/i.test(u.hostname);
    const pathOk = /\/players\/?$/i.test(u.pathname);
    if (!isHttps || !hostOk || !pathOk) return "";
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch (e) {
    return "";
  }
}

function buildLeagueScopedBaseUrls(baseUrl, minAge, maxAge) {
  const leagueIds = parseCsvEnv(process.env.API_FOOTBALL_LEAGUE_IDS, []);
  const season = String(process.env.API_FOOTBALL_SEASON || currentLikelySeasonKst()).trim();
  const sortExpr = String(process.env.API_FOOTBALL_SORT || "").trim();
  const ages = [];
  for (let age = Math.max(15, Number(minAge || 15)); age <= Math.min(24, Number(maxAge || 24)); age += 1) {
    ages.push(String(age));
  }
  if (!ages.length) ages.push("24");
  if (!leagueIds.length) {
    // Default mode: global pool (no league restriction).
    return ages.map((age) => resolvePlayersUrlTemplate(baseUrl, { season, sort: sortExpr, age }));
  }
  const out = [];
  for (const leagueId of leagueIds) {
    for (const age of ages) {
      out.push(resolvePlayersUrlTemplate(baseUrl, { league: leagueId, season, sort: sortExpr, age }));
    }
  }
  return out;
}

function resolvePlayersUrlTemplate(baseUrl, params) {
  let url = String(baseUrl || "").trim();
  if (!url) return "";
  // Template support:
  // - https://v3.football.api-sports.io/players?league={{league}}&season={{season}}&sort={{sort}}
  // - https://.../players?league=:league&season=:season&sort=:sort
  Object.entries(params || {}).forEach(([key, value]) => {
    const val = encodeURIComponent(String(value));
    url = url
      .replaceAll(`{{${key}}}`, val)
      .replaceAll(`:${key}`, val);
  });
  // Clear unresolved placeholders so template mode still works when env vars are omitted.
  url = url
    .replaceAll("{{league}}", "")
    .replaceAll("{{season}}", "")
    .replaceAll("{{sort}}", "")
    .replaceAll("{{age}}", "")
    .replaceAll(":league", "")
    .replaceAll(":season", "")
    .replaceAll(":sort", "")
    .replaceAll(":age", "");
  url = url
    .replace(/([?&])league=(?=&|$)/gi, "$1")
    .replace(/([?&])season=(?=&|$)/gi, "$1")
    .replace(/([?&])sort=(?=&|$)/gi, "$1")
    .replace(/([?&])age=(?=&|$)/gi, "$1");
  url = url.replace(/[?&]{2,}/g, "&").replace(/\?&/g, "?").replace(/[?&]$/, "");
  return appendApiQuery(url, params);
}

function appendApiQuery(baseUrl, params) {
  const out = String(baseUrl || "");
  const pairs = Object.entries(params || {}).filter(([, v]) => String(v || "").trim());
  let result = out;
  for (const [k, v] of pairs) {
    const key = encodeURIComponent(k);
    const val = encodeURIComponent(String(v));
    const re = new RegExp(`([?&])${key}=[^&]*`, "i");
    if (re.test(result)) {
      result = result.replace(re, `$1${key}=${val}`);
      continue;
    }
    result += `${result.includes("?") ? "&" : "?"}${key}=${val}`;
  }
  return result;
}

function buildPagedUrl(baseUrl, page) {
  const hasQuery = baseUrl.includes("?");
  const re = /([?&])page=\d+/i;
  if (re.test(baseUrl)) {
    return baseUrl.replace(re, `$1page=${page}`);
  }
  return `${baseUrl}${hasQuery ? "&" : "?"}page=${page}`;
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

async function upsertGithubFile({
  githubToken,
  githubRepo,
  githubBranch,
  path,
  content,
  message,
}) {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const baseUrl = `https://api.github.com/repos/${githubRepo}/contents/${encodedPath}`;
  const commonHeaders = {
    Authorization: `Bearer ${githubToken}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
  };

  let sha = "";
  const getUrl = `${baseUrl}?ref=${encodeURIComponent(githubBranch)}`;
  const existing = await fetch(getUrl, { headers: commonHeaders });
  if (existing.ok) {
    const current = await existing.json();
    sha = String(current?.sha || "");
  } else if (existing.status !== 404) {
    const text = await existing.text();
    throw new Error(`github_read_failed:${existing.status}:${text.slice(0, 160)}`);
  }

  const putBody = {
    message,
    content: Buffer.from(content, "utf8").toString("base64"),
    branch: githubBranch,
    ...(sha ? { sha } : {}),
  };
  const writeRes = await fetch(baseUrl, {
    method: "PUT",
    headers: commonHeaders,
    body: JSON.stringify(putBody),
  });
  if (!writeRes.ok) {
    const text = await writeRes.text();
    throw new Error(`github_write_failed:${writeRes.status}:${text.slice(0, 160)}`);
  }
  const saved = await writeRes.json();
  return {
    commitSha: String(saved?.commit?.sha || ""),
  };
}
