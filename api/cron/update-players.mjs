/**
 * update-players.mjs  v5
 *
 * 핵심 구조:
 * - 리그 1개 완료 시 즉시 GitHub 저장 (타임아웃 안전)
 * - 페이지 단위 Checkpoint (리그 내 페이지도 이어하기)
 * - Merge 방식 저장 (기존 데이터 보존)
 * - Lock 없음 (Run Now 즉시 실행)
 */

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── 인증 ─────────────────────────────────────────────────────── */
function readSecret(req) {
  const h = String(req.headers?.["x-cron-secret"] || "").trim();
  const b = String(req.headers?.authorization || "").replace(/^bearer\s+/i, "").trim();
  let q = "";
  try {
    const qi = String(req.url||"").indexOf("?");
    if (qi >= 0) q = new URLSearchParams(String(req.url).slice(qi+1)).get("secret") || "";
  } catch(_) {}
  return { h, b, q: String(q).trim() };
}

/* ── GitHub 읽기 ─────────────────────────────────────────────── */
async function ghGet(token, repo, branch, path) {
  const res = await fetch(
    `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`,
    { headers: { Authorization:`Bearer ${token}`, Accept:"application/vnd.github+json" } }
  );
  if (res.status === 404) return { exists:false, sha:"", data:null };
  if (!res.ok) throw new Error(`gh_read:${res.status}`);
  const json = await res.json();
  let data = null;
  try { data = JSON.parse(Buffer.from(json.content||"","base64").toString("utf8")); } catch(_) {}
  return { exists:true, sha:String(json.sha||""), data };
}

/* ── GitHub 쓰기 ─────────────────────────────────────────────── */
async function ghPut(token, repo, branch, path, content, message, knownSha) {
  const url = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path)}`;
  const hdr = { Authorization:`Bearer ${token}`, Accept:"application/vnd.github+json", "Content-Type":"application/json" };
  let sha = knownSha || "";
  if (!sha) {
    const r = await fetch(`${url}?ref=${encodeURIComponent(branch)}`, { headers: hdr });
    if (r.ok) { const j = await r.json(); sha = String(j.sha||""); }
  }
  const res = await fetch(url, {
    method:"PUT", headers:hdr,
    body: JSON.stringify({ message, content:Buffer.from(String(content),"utf8").toString("base64"), branch, ...(sha?{sha}:{}) }),
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`gh_write:${res.status}:${t.slice(0,160)}`); }
  const json = await res.json();
  return { sha:String(json.content?.sha||""), commitSha:String(json.commit?.sha||"") };
}

/* ── Checkpoint: 리그+페이지 단위 ───────────────────────────── */
const CP_PATH = "data/.checkpoint.json";

async function loadCp(token, repo, branch) {
  try {
    const { data, sha } = await ghGet(token, repo, branch, CP_PATH);
    return {
      date:       String(data?.date || ""),
      doneLeagues:Array.isArray(data?.doneLeagues) ? data.doneLeagues : [],
      curLeague:  Number(data?.curLeague  || 0),
      curPage:    Number(data?.curPage    || 0),
      sha,
    };
  } catch(_) { return { date:"", doneLeagues:[], curLeague:0, curPage:0, sha:"" }; }
}

async function saveCp(token, repo, branch, cp) {
  try {
    const r = await ghPut(token, repo, branch, CP_PATH,
      JSON.stringify({ date:cp.date, doneLeagues:cp.doneLeagues, curLeague:cp.curLeague, curPage:cp.curPage, updated_at:new Date().toISOString() }, null, 2)+"\n",
      `chore: checkpoint`, cp.sha);
    return r.sha;
  } catch(e) { console.log("[cp] 저장 실패:", String(e?.message||e)); return cp.sha; }
}

/* ── 정규화 ──────────────────────────────────────────────────── */
function inferContinent(c) {
  c = String(c||"").toLowerCase();
  if (["korea","japan","china","qatar","saudi","iran","iraq","uae","thailand","vietnam","indonesia","india","malaysia","uzbek","kazakhstan","bahrain","kuwait","oman","jordan"].some(k=>c.includes(k))) return "Asia";
  if (["england","spain","france","germany","italy","netherlands","portugal","belgium","croatia","serbia","denmark","sweden","norway","austria","poland","russia","ukraine","romania","greece","turkey","scotland","switzerland","czech","slovakia","hungary","finland","bulgaria","albania","kosovo","lithuania","latvia","estonia","cyprus","bosnia"].some(k=>c.includes(k))) return "Europe";
  if (["nigeria","ghana","senegal","morocco","egypt","algeria","tunisia","cameroon","ivory","south africa","ethiopia","kenya","tanzania","uganda","zimbabwe","zambia"].some(k=>c.includes(k))) return "Africa";
  if (["usa","canada","mexico","costa rica","honduras","panama","guatemala"].some(k=>c.includes(k))) return "North America";
  if (["brazil","argentina","uruguay","colombia","chile","ecuador","peru","paraguay","bolivia","venezuela"].some(k=>c.includes(k))) return "South America";
  if (["australia","new zealand"].some(k=>c.includes(k))) return "Oceania";
  return "-";
}
function calcAge(iso) {
  const d = new Date(String(iso||"").trim());
  if (isNaN(d.getTime())) return 0;
  const n = new Date(); let age = n.getUTCFullYear()-d.getUTCFullYear();
  const m = n.getUTCMonth()-d.getUTCMonth();
  if (m<0||(m===0&&n.getUTCDate()<d.getUTCDate())) age--;
  return age>0?age:0;
}
function parseCm(v){const m=String(v||"").match(/(\d+)/);return m?Number(m[1]):0;}
function parseKg(v){const m=String(v||"").match(/(\d+)/);return m?Number(m[1]):0;}
function normFoot(v){const r=String(v||"").toLowerCase();if(r.includes("left"))return"Left";if(r.includes("right"))return"Right";if(r.includes("both")||r.includes("ambi"))return"Both";return"Unknown";}
function clamp(v,mn,mx){const n=Number(v||0);return isFinite(n)?Math.max(mn,Math.min(mx,Math.floor(n))):mn;}
function clean(v,fb="-"){return String(v||"").trim()||fb;}

function normalizePlayers(payload, lgName) {
  const rows = Array.isArray(payload?.response)?payload.response:Array.isArray(payload?.items)?payload.items:[];
  const out=[]; const seen=new Set();
  for (const row of rows) {
    const p=row?.player||row||{};
    const stats=Array.isArray(row?.statistics)&&row.statistics.length?row.statistics[0]:{};
    const team=stats?.team||{}; const lg=stats?.league||{};
    const nat=String(p?.nationality||row?.country||p?.birth?.country||"-");
    const age=Number(p?.age||row?.age||0)||calcAge(p?.birth?.date||"");
    const id=String(p?.id||row?.player_id||"").trim();
    const name=String(p?.name||row?.name||[String(p?.firstname||"").trim(),String(p?.lastname||"").trim()].filter(Boolean).join(" ")||"").trim();
    if (!id||!name||seen.has(id)) continue;
    seen.add(id);
    out.push({
      player_id:id, name,
      age:clamp(age,0,60),
      height_cm:clamp(parseCm(p?.height||row?.height_cm),0,260),
      weight_kg:clamp(parseKg(p?.weight||row?.weight_kg),0,200),
      dominant_foot:normFoot(row?.dominant_foot||p?.foot||""),
      country:clean(nat),
      continent:clean(row?.continent||inferContinent(nat)),
      club:clean(team?.name||row?.club),
      position:clean(stats?.games?.position||row?.position),
      league:clean(lg?.name||lgName||row?.league),
    });
  }
  return out;
}

/* ── Merge ───────────────────────────────────────────────────── */
function merge(existing, newPlayers, maxAge) {
  const map = new Map();
  for (const p of (existing||[])) if (p?.player_id) map.set(String(p.player_id), p);
  for (const p of (newPlayers||[])) if (p?.player_id) map.set(String(p.player_id), p);
  const hi = Math.max(1, Number(maxAge||25));
  return Array.from(map.values()).filter(p => { const a=Number(p?.age); return isFinite(a)&&a>0&&a<=hi; });
}

/* ── URL ─────────────────────────────────────────────────────── */
function todayKST() {
  try { return new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Seoul",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date()); }
  catch(_) { return new Date().toISOString().slice(0,10); }
}
function currentSeason() {
  try {
    const p=new Intl.DateTimeFormat("en-US",{timeZone:"Asia/Seoul",year:"numeric",month:"numeric"}).formatToParts(new Date());
    const y=Number(p.find(x=>x.type==="year")?.value||0); const m=Number(p.find(x=>x.type==="month")?.value||0);
    return String(m<7?y-1:y);
  } catch(_) { return String(new Date().getUTCFullYear()); }
}
function normalizeUrl(raw) {
  try {
    const u=new URL(String(raw||"").trim());
    if(u.protocol!=="https:") return "";
    if(!/(^|\.)api-sports\.io$/i.test(u.hostname)) return "";
    if(!/\/players\/?$/i.test(u.pathname)) return "";
    return `${u.origin}${u.pathname.replace(/\/+$/,"")}`;
  } catch(_) { return ""; }
}

/* ── 기본 리그 (55개 / 50개국) ───────────────────────────────── */
const DEFAULT_LEAGUES = [
  // 유럽 1부 20개국
  39,140,78,135,61,88,94,203,144,179,207,218,113,103,119,332,235,197,168,182,
  // 유럽 2부 5대리그
  40,141,79,136,62,
  // 아시아 12개국
  292,98,307,322,323,324,289,296,301,302,336,310,
  // 남미 8개국
  71,128,239,265,273,266,242,243,
  // 아프리카 6개국
  200,204,206,202,772,773,
  // 북중미 3개국
  253,262,164,
  // 오세아니아 1개국
  188,
];

/* ══════════════════════════════════════════════════════════════
   HANDLER
══════════════════════════════════════════════════════════════ */
export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ok:false,error:"method_not_allowed"});

  const cronSecret = String(process.env.CRON_SECRET||"").trim();
  if (cronSecret) {
    const {h,b,q} = readSecret(req);
    if (h!==cronSecret&&b!==cronSecret&&q!==cronSecret)
      return res.status(401).json({ok:false,error:"unauthorized"});
  }

  const apiKey   = String(process.env.API_FOOTBALL_KEY||"").trim();
  const apiUrl   = String(process.env.API_FOOTBALL_PLAYERS_URL||"").trim();
  const maxPages = Math.max(1,Math.min(200,Number(process.env.API_FOOTBALL_MAX_PAGES||20)||20));
  const maxAge   = Math.max(16,Math.min(26,Number(process.env.API_FOOTBALL_MAX_AGE||25)||25));
  const season   = String(process.env.API_FOOTBALL_SEASON||currentSeason()).trim();
  const ghToken  = String(process.env.GITHUB_TOKEN||"").trim();
  const ghRepo   = String(process.env.GITHUB_REPO||"").trim();
  const ghBranch = String(process.env.GITHUB_BRANCH||"main").trim();
  const tgtPath  = String(process.env.REGISTERED_PLAYERS_FILE_PATH||"data/registered_players.json").trim();
  const dlyPath  = String(process.env.DAILY_PLAYER_UPDATES_FILE_PATH||"data/daily_player_updates.json").trim();
  const DELAY    = Number(process.env.API_CALL_DELAY_MS||200);
  const RETRY_MS = Number(process.env.API_RATE_RETRY_MS||2000);

  if (!apiKey||!apiUrl) return res.status(200).json({ok:true,mode:"no_api_key"});
  if (!ghToken||!ghRepo) return res.status(400).json({ok:false,error:"missing_github_config"});
  const baseUrl = normalizeUrl(apiUrl);
  if (!baseUrl) return res.status(400).json({ok:false,error:"invalid_api_url"});

  const envLeagues = String(process.env.API_FOOTBALL_LEAGUE_IDS||"").split(",").map(x=>x.trim()).filter(Boolean).map(Number).filter(n=>n>0);
  const leagueIds  = envLeagues.length ? envLeagues : DEFAULT_LEAGUES;
  const today      = todayKST();

  // Checkpoint 로드
  let cp = await loadCp(ghToken, ghRepo, ghBranch);
  if (cp.date !== today) {
    console.log(`[cp] 날짜 변경(${cp.date}→${today}) — 초기화`);
    cp = { date:today, doneLeagues:[], curLeague:0, curPage:0, sha:"" };
  }

  const doneSet   = new Set(cp.doneLeagues.map(String));
  const remaining = leagueIds.filter(id => !doneSet.has(String(id)));
  console.log(`[start] 시즌:${season} maxAge:${maxAge} maxPages:${maxPages} / 완료:${doneSet.size} 남은:${remaining.length}`);

  if (!remaining.length) {
    console.log("[start] 모든 리그 완료");
    return res.status(200).json({ok:true,mode:"already_done_today",date:today,leagues_done:doneSet.size});
  }

  // 기존 선수 데이터 + SHA
  let players=[]; let playersSha="";
  try {
    const {data,sha} = await ghGet(ghToken, ghRepo, ghBranch, tgtPath);
    playersSha = sha;
    players = Array.isArray(data?.items)?data.items:Array.isArray(data)?data:[];
    console.log(`[load] 기존: ${players.length}명 SHA:${playersSha.slice(0,7)}`);
  } catch(_) { console.log("[load] 기존 파일 없음"); }

  const apiHdr = { "x-apisports-key":apiKey, Accept:"application/json" };

  // ── 리그별 처리 ───────────────────────────────────────────────
  for (const leagueId of remaining) {
    console.log(`\n[league] ${leagueId} 시작`);
    const leaguePlayers = []; const seen = new Set();
    let totalPages = 1;
    let startPage  = 1;

    // 이 리그가 이전에 중단됐으면 해당 페이지부터
    if (cp.curLeague === leagueId && cp.curPage > 0) {
      startPage = cp.curPage;
      console.log(`[league] ${leagueId} p${startPage}부터 이어서`);
    }

    let leagueOk = true;
    for (let page = startPage; page <= totalPages && page <= maxPages; page++) {
      if (page > 1) await sleep(DELAY);
      const url = `${baseUrl}?league=${leagueId}&season=${season}&page=${page}`;

      let payload;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const r = await fetch(url, {method:"GET", headers:apiHdr});
        if (r.status === 429) { console.log(`[rate] 429 → ${RETRY_MS}ms`); await sleep(RETRY_MS); continue; }
        if (!r.ok) { leagueOk=false; break; }
        payload = await r.json();
        const errs = payload?.errors||{};
        if (Object.keys(errs).length) {
          if (Object.values(errs).some(v=>/rate|limit|request/i.test(String(v)))&&attempt<3) { await sleep(RETRY_MS); continue; }
          console.log(`[league] ${leagueId} API 에러:`, JSON.stringify(errs));
          leagueOk=false; break;
        }
        break;
      }
      if (!leagueOk || !payload) break;

      const paging = Number(payload?.paging?.total||0);
      if (paging>0) totalPages=paging;
      const lgName = payload?.response?.[0]?.statistics?.[0]?.league?.name||"";
      const batch  = normalizePlayers(payload, lgName);
      for (const p of batch) { if (!seen.has(p.player_id)) { seen.add(p.player_id); leaguePlayers.push(p); } }
      console.log(`[fetch] 리그${leagueId} p${page}/${Math.min(totalPages,maxPages)} → ${batch.length}명`);

      // 페이지 Checkpoint 저장 (5페이지마다)
      if (page % 5 === 0) {
        cp.curLeague = leagueId; cp.curPage = page + 1;
        cp.sha = await saveCp(ghToken, ghRepo, ghBranch, cp);
      }
      await sleep(DELAY);
    }

    console.log(`[league] ${leagueId} 수집완료: ${leaguePlayers.length}명`);

    // Merge
    players = merge(players, leaguePlayers, maxAge);

    // ── 리그 완료 즉시 GitHub 저장 ────────────────────────────
    console.log(`[save] 리그${leagueId} 저장 시작 → 총 ${players.length}명`);
    try {
      const body = JSON.stringify({
        updated_at:    new Date().toISOString(),
        season,
        leagues_done:  doneSet.size + 1,
        leagues_total: leagueIds.length,
        players_count: players.length,
        items:         players,
      }, null, 2) + "\n";

      const result = await ghPut(ghToken, ghRepo, ghBranch, tgtPath, body,
        `cron: league ${leagueId} (${players.length} players)`, playersSha);
      playersSha = result.sha;
      console.log(`[save] ✅ 리그${leagueId} 저장완료 SHA:${result.commitSha.slice(0,7)}`);
    } catch(e) {
      console.error(`[save] ❌ 리그${leagueId} 저장실패:`, String(e?.message||e));
    }

    // 리그 완료 Checkpoint
    doneSet.add(String(leagueId));
    cp.doneLeagues = Array.from(doneSet);
    cp.curLeague   = 0;
    cp.curPage     = 0;
    cp.sha = await saveCp(ghToken, ghRepo, ghBranch, cp);
    console.log(`[progress] ${doneSet.size}/${leagueIds.length} | 누적:${players.length}명`);
  }

  // daily 메타데이터
  try {
    const {sha:dSha} = await ghGet(ghToken, ghRepo, ghBranch, dlyPath);
    await ghPut(ghToken, ghRepo, ghBranch, dlyPath,
      JSON.stringify({updated_at:new Date().toISOString(),season,date:today,
        leagues_done:doneSet.size,leagues_total:leagueIds.length,players_count:players.length},null,2)+"\n",
      `cron: daily meta (${players.length} players)`, dSha);
    console.log("[daily] ✅ 메타 저장완료");
  } catch(e) { console.log("[daily] 저장실패:", String(e?.message||e)); }

  return res.status(200).json({
    ok:true, mode:"per_league_save",
    date:today, season,
    leagues_total:leagueIds.length, leagues_done:doneSet.size,
    players_total:players.length,
  });
}
