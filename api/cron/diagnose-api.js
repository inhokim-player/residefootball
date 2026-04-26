/**
 * diagnose-api.js  —  API-Football 진단 전용 엔드포인트
 * 배치 위치: api/cron/diagnose-api.js
 * 호출 방법: https://your-vercel-app.vercel.app/api/cron/diagnose-api?secret=YOUR_CRON_SECRET
 *
 * 하는 일:
 *  1. API 키 상태 확인 (남은 콜 수, 플랜)
 *  2. 현재 접근 가능한 리그 목록 + 각 리그의 유효 시즌 출력
 *  3. 2024 / 2025 시즌 U25 선수 샘플 1페이지 직접 호출
 *  4. 모든 단계에서 상세 console.log + 응답에 포함
 */

export default async function handler(req, res) {
  /* ── 인증 ───────────────────────────────────────────────── */
  const cronSecret = process.env.CRON_SECRET || "";
  if (cronSecret) {
    const incoming =
      String(req.headers["x-cron-secret"] || "").trim() ||
      String(req.headers.authorization || "").replace(/^bearer\s+/i, "").trim() ||
      String(new URLSearchParams(String(req.url||"").split("?")[1]||"").get("secret") || "").trim();
    if (incoming !== cronSecret) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
  }

  const KEY = String(process.env.API_FOOTBALL_KEY || "").trim();
  const BASE = "https://v3.football.api-sports.io";
  const log = [];   // 모든 진단 결과를 여기에도 쌓음

  function note(tag, data) {
    const msg = `[DIAG][${tag}] ${JSON.stringify(data)}`;
    console.log(msg);
    log.push({ tag, data });
  }

  if (!KEY) {
    return res.status(400).json({ ok: false, error: "API_FOOTBALL_KEY 환경변수가 없습니다." });
  }

  const headers = { "x-apisports-key": KEY, Accept: "application/json" };

  /* ══════════════════════════════════════════════════════════
     STEP 1: API 키 상태 확인
  ══════════════════════════════════════════════════════════ */
  note("STEP1", "API 키 상태 확인 시작");
  let statusData = null;
  try {
    const r = await fetch(`${BASE}/status`, { headers });
    note("STEP1.http", { status: r.status, ok: r.ok });
    const body = await r.json();
    statusData = body?.response ?? body;
    note("STEP1.response", statusData);

    // 핵심: 남은 콜 수
    const account = statusData?.account || statusData;
    note("STEP1.plan", {
      plan:           account?.plan        ?? "unknown",
      requests_day:   account?.requests?.day   ?? "?",
      requests_limit: account?.requests?.limit ?? "?",
      active:         account?.active      ?? "?",
    });
  } catch (err) {
    note("STEP1.error", String(err?.message ?? err));
  }

  /* ══════════════════════════════════════════════════════════
     STEP 2: 리그 목록 + 유효 시즌 샘플 (상위 20개)
  ══════════════════════════════════════════════════════════ */
  note("STEP2", "접근 가능한 리그 + 시즌 목록 조회");
  let leaguesData = [];
  try {
    const r = await fetch(`${BASE}/leagues?current=true`, { headers });
    note("STEP2.http", { status: r.status, ok: r.ok });
    const body = await r.json();
    note("STEP2.errors",   body?.errors   ?? null);
    note("STEP2.results",  body?.results  ?? 0);

    leaguesData = (body?.response ?? []).slice(0, 20).map(item => ({
      id:      item?.league?.id,
      name:    item?.league?.name,
      country: item?.country?.name,
      seasons: (item?.seasons ?? []).map(s => s.year).sort((a,b) => b-a).slice(0,5),
      current_season: (item?.seasons ?? []).find(s => s.current)?.year ?? null,
    }));
    note("STEP2.leagues_sample", leaguesData);
  } catch (err) {
    note("STEP2.error", String(err?.message ?? err));
  }

  /* ══════════════════════════════════════════════════════════
     STEP 3: 2025 시즌 U25 선수 샘플 (리그 39 = Premier League)
  ══════════════════════════════════════════════════════════ */
  note("STEP3", "2025 시즌 PL(39) U25 선수 1페이지 호출");
  let players2025 = null;
  try {
    const url = `${BASE}/players?league=39&season=2025&age=22&page=1`;
    note("STEP3.url", url);
    const r = await fetch(url, { headers });
    note("STEP3.http", { status: r.status, ok: r.ok });
    const body = await r.json();
    note("STEP3.errors",  body?.errors  ?? null);
    note("STEP3.results", body?.results ?? 0);
    note("STEP3.paging",  body?.paging  ?? null);
    const sample = (body?.response ?? []).slice(0, 3).map(row => ({
      id:   row?.player?.id,
      name: row?.player?.name,
      age:  row?.player?.age,
      nationality: row?.player?.nationality,
    }));
    note("STEP3.sample_players", sample);
    players2025 = { results: body?.results ?? 0, sample, errors: body?.errors ?? null };
  } catch (err) {
    note("STEP3.error", String(err?.message ?? err));
  }

  /* ══════════════════════════════════════════════════════════
     STEP 4: 2024 시즌 동일 테스트
  ══════════════════════════════════════════════════════════ */
  note("STEP4", "2024 시즌 PL(39) U25 선수 1페이지 호출");
  let players2024 = null;
  try {
    const url = `${BASE}/players?league=39&season=2024&age=22&page=1`;
    note("STEP4.url", url);
    const r = await fetch(url, { headers });
    note("STEP4.http", { status: r.status, ok: r.ok });
    const body = await r.json();
    note("STEP4.errors",  body?.errors  ?? null);
    note("STEP4.results", body?.results ?? 0);
    note("STEP4.paging",  body?.paging  ?? null);
    const sample = (body?.response ?? []).slice(0, 3).map(row => ({
      id:   row?.player?.id,
      name: row?.player?.name,
      age:  row?.player?.age,
      nationality: row?.player?.nationality,
    }));
    note("STEP4.sample_players", sample);
    players2024 = { results: body?.results ?? 0, sample, errors: body?.errors ?? null };
  } catch (err) {
    note("STEP4.error", String(err?.message ?? err));
  }

  /* ══════════════════════════════════════════════════════════
     STEP 5: league 없이 age=22만으로 글로벌 호출
  ══════════════════════════════════════════════════════════ */
  note("STEP5", "글로벌 age=22, season=2025, league 없이 호출");
  let playersGlobal = null;
  try {
    const url = `${BASE}/players?age=22&season=2025&page=1`;
    note("STEP5.url", url);
    const r = await fetch(url, { headers });
    note("STEP5.http", { status: r.status, ok: r.ok });
    const body = await r.json();
    note("STEP5.errors",  body?.errors  ?? null);
    note("STEP5.results", body?.results ?? 0);
    note("STEP5.paging",  body?.paging  ?? null);
    playersGlobal = { results: body?.results ?? 0, errors: body?.errors ?? null };
  } catch (err) {
    note("STEP5.error", String(err?.message ?? err));
  }

  /* ══════════════════════════════════════════════════════════
     진단 요약
  ══════════════════════════════════════════════════════════ */
  const diagnosis = [];

  const account = statusData?.account ?? statusData ?? {};
  if (!account?.active) diagnosis.push("❌ API 키가 비활성 상태입니다.");
  if ((account?.requests?.day ?? -1) === 0) diagnosis.push("⚠️  오늘 API 호출 한도 소진됨.");
  if (players2025?.errors && Object.keys(players2025.errors).length)
    diagnosis.push(`❌ 2025 시즌 에러: ${JSON.stringify(players2025.errors)}`);
  if (players2024?.errors && Object.keys(players2024.errors).length)
    diagnosis.push(`❌ 2024 시즌 에러: ${JSON.stringify(players2024.errors)}`);
  if ((players2025?.results ?? 0) === 0 && (players2024?.results ?? 0) === 0)
    diagnosis.push("❌ 2024·2025 둘 다 결과 0 → API 키/플랜 문제 또는 엔드포인트 파라미터 오류");
  if ((players2025?.results ?? 0) > 0)
    diagnosis.push(`✅ 2025 시즌 정상 (results: ${players2025.results})`);
  if ((players2024?.results ?? 0) > 0)
    diagnosis.push(`✅ 2024 시즌 정상 (results: ${players2024.results})`);
  if (!diagnosis.length)
    diagnosis.push("✅ 명확한 오류 없음 — 로그 상세 확인 필요");

  note("SUMMARY.diagnosis", diagnosis);

  return res.status(200).json({
    ok: true,
    diagnosis,
    step1_api_status: statusData,
    step2_leagues_sample: leaguesData,
    step3_players_2025: players2025,
    step4_players_2024: players2024,
    step5_players_global: playersGlobal,
    full_log: log,
  });
}
