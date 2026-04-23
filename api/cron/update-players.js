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
  if (!triggerUrl) {
    return res.status(200).json({
      ok: true,
      mode: "registered_only",
      message: "No trigger configured. Site keeps showing registered players fallback.",
      kst_schedule: "10:00",
    });
  }

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
