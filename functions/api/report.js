// POST /api/report — приём отчёта о проблеме и запись в KV (binding REPORTS)
export async function onRequestPost({ request, env }) {
  try {
    const data = await request.json();
    if (!env.REPORTS) return json({ ok: false, error: 'storage not configured' }, 500);
    const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const rec = {
      id,
      created: new Date().toISOString(),
      description: String(data.description || '').slice(0, 5000),
      map: String(data.map || '').slice(0, 300000),
      ua: String(data.ua || '').slice(0, 600),
      window: String(data.window || ''),
      zoom: data.zoom,
      angle: data.angle,
      routes: data.routes,
      nodes: data.nodes,
      log: String(data.log || '').slice(0, 30000),
      country: request.headers.get('cf-ipcountry') || '',
    };
    await env.REPORTS.put('report:' + id, JSON.stringify(rec));
    return json({ ok: true, id });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 400);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
