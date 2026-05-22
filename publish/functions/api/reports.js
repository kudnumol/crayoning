// GET /api/reports?key=ADMIN_KEY — выгрузка всех отчётов (для сводного списка).
// Защищено секретом ADMIN_KEY (переменная окружения проекта).
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
    return new Response('forbidden', { status: 403 });
  }
  if (!env.REPORTS) {
    return json([], 200);
  }
  const items = [];
  let cursor;
  do {
    const list = await env.REPORTS.list({ prefix: 'report:', cursor });
    for (const k of list.keys) {
      const v = await env.REPORTS.get(k.name);
      if (v) {
        try { items.push(JSON.parse(v)); } catch (_) {}
      }
    }
    cursor = list.list_complete ? null : list.cursor;
  } while (cursor);

  items.sort((a, b) => (a.created < b.created ? 1 : -1)); // новые сверху
  return json(items, 200);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
