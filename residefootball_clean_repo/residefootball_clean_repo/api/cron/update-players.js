export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  const cronSecret = process.env.CRON_SECRET || "";
  if (cronSecret) {
    const incomingHeader = String(req.headers["x-cron-secret"] || "").trim();
    const authRaw = String(req.headers.authorization || "");
    const bearer = authRaw.toLowerCase().startsWith("bearer ")
      ? authRaw.slice(7).trim()
      : "";
    const ok = incomingHeader === cronSecret || bearer === cronSecret;
    if (!ok) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
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

  if (!apiFootballKey || !apiFootballPlayersUrl) {
    return res.status(200).json({
      ok: true,
      mode: "registered_only",
      message: "No API_FOOTBALL settings. Keep registered players only.",
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

  try {
    const items = await fetchAllApiFootballPlayers({
      apiFootballPlayersUrl,
      apiFootballKey,
      maxPages: apiFootballMaxPages,
    });
    if (!items.length) {
      return res.status(422).json({
        ok: false,
        error: "empty_players",
        message: "API response contained no usable players.",
      });
    }

    const body = JSON.stringify({ items }, null, 2) + "\n";
    const saved = await upsertGithubFile({
      githubToken,
      githubRepo,
      githubBranch,
      path: targetPath,
      content: body,
      message: `cron: update registered players (${items.length})`,
    });

    return res.status(200).json({
      ok: true,
      mode: "api_football_to_github",
      players: items.length,
      max_pages: apiFootballMaxPages,
      path: targetPath,
      commit_sha: saved.commitSha,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "update_failed",
      detail: String(err && err.message ? err.message : err),
    });
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
      age: Number(p?.age || row?.age || 0) || 0,
      height_cm: parseCm(p?.height || row?.height_cm || row?.height),
      weight_kg: parseKg(p?.weight || row?.weight_kg || row?.weight),
      dominant_foot: String(row?.dominant_foot || "Unknown"),
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
}) {
  const headers = {
    "x-apisports-key": apiFootballKey,
    Accept: "application/json",
  };
  const all = [];
  const seen = new Set();
  let totalPages = 1;

  for (let page = 1; page <= totalPages && page <= maxPages; page += 1) {
    const url = buildPagedUrl(apiFootballPlayersUrl, page);
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
  return all;
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
