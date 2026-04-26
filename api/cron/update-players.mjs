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

  // ── 중복 실행 방지: 실행 중 락 파일 체크 ─────────────────────────
  const githubToken  = String(process.env.GITHUB_TOKEN  || "").trim();
  const githubRepo   = String(process.env.GITHUB_REPO   || "").trim();
  const githubBranch = String(process.env.GITHUB_BRANCH || "main").trim();
  const targetPath   = String(process.env.REGISTERED_PLAYERS_FILE_PATH  || "data/registered_players.json").trim();
  const dailyPath    = String(process.env.DAILY_PLAYER_UPDATES_FILE_PATH || "data/daily_player_updates.json").trim();
  const apiFootballKey        = String(process.env.API_FOOTBALL_KEY          || "").trim();
  const apiFootballPlayersUrl = String(process.env.API_FOOTBALL_PLAYERS_URL  || "").trim();
  const apiFootballMaxPages   = Math.max(1, Math.min(200, Number(process.env.API_FOOTBALL_MAX_PAGES || 30) || 30));
  const lockPath = "data/.update-lock";

  if (githubToken && githubRepo) {
    const lockHeaders = {
      Authorization: `Bearer ${githubToken}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    };
    try {
      // 락 파일 존재 확인
      const lockCheck = await fetch(
        `https://api.github.com/repos/${githubRepo}/contents/${lockPath}?ref=${githubBranch}`,
        { headers: lockHeaders }
      );
      if (lockCheck.ok) {
        const lockData = await lockCheck.json();
        const lockedAt = Buffer.from(lockData.content, "base64").toString("utf8").trim();
        const lockedMs = Date.parse(lockedAt);
        const elapsedMin = (Date.now() - lockedMs) / 60000;
        // 락이 10분 이내면 중복 실행으로 판단
        if (elapsedMin < 10) {
          console.log(`[lock] 중복 실행 차단 — 이미 실행 중 (${elapsedMin.toFixed(1)}분 전 시작)`);
          return res.status(200).json({
            ok: false,
            error: "already_running",
            message: `이미 다른 인스턴스가 실행 중입니다 (${elapsedMin.toFixed(1)}분 전 시작). 잠시 후 다시 시도하세요.`,
            locked_at: lockedAt,
          });
        }
        console.log(`[lock] 오래된 락 파일 발견 (${elapsedMin.toFixed(1)}분 전) — 무시하고 진행`);
      }
      // 락 파일 생성 (실행 시작 표시)
      const now = new Date().toISOString();
      let existingSha = "";
      if (lockCheck.ok) {
        const ld = await lockCheck.json().catch(() => ({}));
        existingSha = String(ld?.sha || "");
      }
      await fetch(`https://api.github.com/repos/${githubRepo}/contents/${lockPath}`, {
        method: "PUT",
        headers: lockHeaders,
        body: JSON.stringify({
          message: "chore: update-players lock",
          content: Buffer.from(now, "utf8").toString("base64"),
          branch: githubBranch,
          ...(existingSha ? { sha: existingSha } : {}),
        }),
      });
      console.log(`[lock] 락 파일 생성 완료: ${now}`);
    } catch (e) {
      console.log("[lock] 락 체크 실패 (무시하고 진행):", String(e?.message || e));
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
  } finally {
    // ── 락 파일 삭제 (실행 완료/실패 모두) ───────────────────────
    if (githubToken && githubRepo) {
      try {
        const lockHeaders = {
          Authorization: `Bearer ${githubToken}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        };
        const lockCheck = await fetch(
          `https://api.github.com/repos/${githubRepo}/contents/${lockPath}?ref=${githubBranch}`,
          { headers: lockHeaders }
        );
        if (lockCheck.ok) {
          const lockData = await lockCheck.json();
          await fetch(`https://api.github.com/repos/${githubRepo}/contents/${lockPath}`, {
            method: "DELETE",
            headers: lockHeaders,
            body: JSON.stringify({
              message: "chore: remove update-players lock",
              sha: lockData.sha,
              branch: githubBranch,
            }),
          });
          console.log("[lock] 락 파일 삭제 완료");
        }
      } catch (e) {
        console.log("[lock] 락 삭제 실패 (무시):", String(e?.message || e));
      }
    }
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

// ── Rate limit 딜레이 ────────────────────────────────────────
const CALL_DELAY_MS  = Number(process.env.API_CALL_DELAY_MS  || 2000); // 호출 간격 (기본 2초, Pro 플랜)
const RATE_RETRY_MS  = Number(process.env.API_RATE_RETRY_MS  || 10000); // rateLimit 시 재시도 대기
const MAX_RETRIES    = 3; // rateLimit 재시도 횟수

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRateLimit(url, headers) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, { method: "GET", headers });

    if (res.status === 429) {
      // Rate limit 초과 — 대기 후 재시도
      console.log(`[rate-limit] 429 수신 (시도 ${attempt}/${MAX_RETRIES}) → ${RATE_RETRY_MS}ms 대기`);
      await sleep(RATE_RETRY_MS);
      continue;
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`api_football_failed:${res.status}:${text.slice(0, 180)}`);
    }

    const payload = await res.json();

    // API 응답 내 rateLimit 에러 확인
    const errObj = payload?.errors || {};
    const errKeys = Object.keys(errObj);
    if (errKeys.length) {
      const isRateLimit = errKeys.some(k =>
        String(errObj[k]).toLowerCase().includes("rate") ||
        String(errObj[k]).toLowerCase().includes("limit") ||
        String(errObj[k]).toLowerCase().includes("requests")
      );
      if (isRateLimit && attempt < MAX_RETRIES) {
        console.log(`[rate-limit] API error (시도 ${attempt}/${MAX_RETRIES}):`, JSON.stringify(errObj), `→ ${RATE_RETRY_MS}ms 대기`);
        await sleep(RATE_RETRY_MS);
        continue;
      }
      console.log("[fetch] API errors:", JSON.stringify(errObj));
      throw new Error(`api_football_error:${JSON.stringify(errObj)}`);
    }

    return payload;
  }
  throw new Error(`api_football_rate_limit_exceeded: ${MAX_RETRIES}회 재시도 실패`);
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

  console.log(`[fetch] 총 URL 수: ${leagueUrls.length} / maxPages: ${maxPages} / 호출간격: ${CALL_DELAY_MS}ms`);

  let callCount = 0;

  for (let i = 0; i < leagueUrls.length; i++) {
    const oneBaseUrl = leagueUrls[i];
    let totalPages = 1;

    for (let page = 1; page <= totalPages && page <= maxPages; page++) {
      const url = buildPagedUrl(oneBaseUrl, page);

      // ── 호출 간격 딜레이 (첫 번째 제외) ───────────────────────
      if (callCount > 0) await sleep(CALL_DELAY_MS);
      callCount++;

      console.log(`[fetch #${callCount}] 리그 ${i+1}/${leagueUrls.length} page ${page}/${totalPages} → ${url}`);

      let payload;
      try {
        payload = await fetchWithRateLimit(url, headers);
      } catch (err) {
        // rateLimit 이외의 에러면 이 리그는 건너뜀
        console.log(`[fetch] 에러로 리그 건너뜀: ${err.message}`);
        break;
      }

      console.log(`[fetch] results: ${payload?.results ?? 0} / paging: ${JSON.stringify(payload?.paging)}`);

      const onePage = normalizeApiFootballPlayers(payload);
      console.log(`[fetch] 정규화 선수: ${onePage.length}명 / 누적: ${all.length + onePage.filter(p => !seen.has(p.player_id)).length}명`);

      for (const p of onePage) {
        if (!p.player_id || seen.has(p.player_id)) continue;
        seen.add(p.player_id);
        all.push(p);
      }

      const pagingTotal = Number(payload?.paging?.total || 0);
      if (pagingTotal > 0) totalPages = pagingTotal;
      else if (!onePage.length) break;
    }
  }

  console.log(`[fetch] 완료 — 총 API 호출: ${callCount}회 / 최종 선수 수: ${all.length}명`);
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
  const season = String(process.env.API_FOOTBALL_SEASON || currentLikelySeasonKst()).trim();
  const sortExpr = String(process.env.API_FOOTBALL_SORT || "").trim();

  // ── 전체 164개 리그 (전세계 대륙별 완전 커버) ───────────────────
  // 환경변수 API_FOOTBALL_LEAGUE_IDS가 있으면 그걸 우선 사용
  const DEFAULT_LEAGUES = [
    // ── 유럽 1부 ─────────────────────────────────────────────────
    39,   // England - Premier League
    140,  // Spain - La Liga
    78,   // Germany - Bundesliga
    135,  // Italy - Serie A
    61,   // France - Ligue 1
    88,   // Netherlands - Eredivisie
    94,   // Portugal - Primeira Liga
    203,  // Turkey - Süper Lig
    144,  // Belgium - Pro League
    179,  // Scotland - Premiership
    197,  // Greece - Super League
    207,  // Switzerland - Super League
    218,  // Denmark - Superliga
    113,  // Norway - Eliteserien
    103,  // Sweden - Allsvenskan
    119,  // Austria - Bundesliga
    168,  // Croatia - HNL
    182,  // Serbia - Super Liga
    332,  // Poland - Ekstraklasa
    235,  // Russia - Premier League
    333,  // Ukraine - Premier League
    271,  // Romania - Liga I
    106,  // Finland - Veikkausliiga
    383,  // Bulgaria - First League
    244,  // Slovakia - Fortuna Liga
    210,  // Hungary - OTP Bank Liga
    169,  // Czech Republic - Liga
    283,  // Cyprus - 1st Division
    233,  // Bosnia - Premier League (중복 제거: 모로코 ID와 다름)
    286,  // Albania - Superliga
    291,  // Kosovo - Football Superleague
    392,  // Lithuania - A Lyga
    395,  // Latvia - Virsliga
    398,  // Estonia - Meistriliiga
    198,  // Greece - Super League 2
    // ── 유럽 2부 ─────────────────────────────────────────────────
    40,   // England - Championship
    141,  // Spain - Segunda División
    79,   // Germany - 2. Bundesliga
    136,  // Italy - Serie B
    62,   // France - Ligue 2
    89,   // Netherlands - Eerste Divisie
    95,   // Portugal - Segunda Liga
    145,  // Belgium - First Amateur
    208,  // Switzerland - Challenge League
    // ── 유럽 3부 (잉글랜드) ──────────────────────────────────────
    45,   // England - League One
    46,   // England - League Two
    // ── 아시아 ───────────────────────────────────────────────────
    292,  // South Korea - K League 1
    293,  // South Korea - K League 2
    98,   // Japan - J1 League
    99,   // Japan - J2 League
    100,  // Japan - J3 League
    307,  // Saudi Arabia - Pro League
    308,  // Saudi Arabia - Division 1
    322,  // Qatar - Stars League
    323,  // UAE - Arabian Gulf League
    324,  // Iran - Persian Gulf Pro League
    289,  // Thailand - Thai League 1
    290,  // Thailand - Thai League 2
    296,  // India - ISL
    301,  // Indonesia - Liga 1
    302,  // Vietnam - V.League 1
    303,  // Malaysia - Super League
    334,  // Uzbekistan - Super League
    336,  // Kazakhstan - Premier League
    351,  // Jordan - Pro League
    363,  // Bahrain - Premier League
    369,  // Kuwait - Premier League
    371,  // Oman - Professional League
    310,  // Iraq - Premier League
    294,  // South Korea - K3 League
    // ── 남미 ─────────────────────────────────────────────────────
    71,   // Brazil - Série A
    72,   // Brazil - Série B
    73,   // Brazil - Série C
    128,  // Argentina - Liga Profesional
    129,  // Argentina - Primera Nacional
    239,  // Colombia - Liga BetPlay
    240,  // Colombia - Torneo BetPlay
    265,  // Chile - Primera División
    268,  // Paraguay - División Profesional
    273,  // Uruguay - Primera División
    266,  // Peru - Liga 1
    267,  // Peru - Liga 2
    242,  // Venezuela - Primera División
    243,  // Ecuador - Liga Pro
    284,  // Bolivia - División Profesional
    // ── 아프리카 ─────────────────────────────────────────────────
    200,  // Egypt - Premier League
    201,  // Tunisia - Ligue 1
    202,  // Algeria - Ligue 1
    204,  // Nigeria - NPFL
    206,  // South Africa - Premier Soccer League
    772,  // Ghana - Premier League
    773,  // Senegal - Ligue 1
    774,  // Ivory Coast - Ligue 1
    776,  // Cameroon - Elite One
    778,  // Tanzania - Premier League
    780,  // Kenya - Premier League
    771,  // Ethiopia - Premier League
    782,  // Uganda - Premier League
    783,  // Zimbabwe - Premier Soccer League
    784,  // Zambia - Super League
    // ── 북중미카리브 ──────────────────────────────────────────────
    253,  // USA - MLS
    254,  // USA - USL Championship
    255,  // USA - USL League One
    262,  // Mexico - Liga MX
    263,  // Mexico - Ascenso MX
    164,  // Costa Rica - Primera División
    328,  // Honduras - Liga Nacional
    327,  // Panama - LPF
    330,  // Guatemala - Liga Nacional
    // ── 오세아니아 ───────────────────────────────────────────────
    188,  // Australia - A-League
    190,  // New Zealand - NZFC
  ];

  const envLeagues = parseCsvEnv(process.env.API_FOOTBALL_LEAGUE_IDS, []);
  const leagueIds  = envLeagues.length ? envLeagues : DEFAULT_LEAGUES;

  console.log(`[build-urls] season: ${season} / 리그 수: ${leagueIds.length} (${envLeagues.length ? "환경변수" : "기본값 전체"})`);

  const out = [];
  for (const leagueId of leagueIds) {
    const url = resolvePlayersUrlTemplate(baseUrl, { league: leagueId, season, sort: sortExpr });
    out.push(url);
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
