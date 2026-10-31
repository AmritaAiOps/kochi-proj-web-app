// Shared app state in Cloudflare KV (binding STATE), one key per file the
// Python backend persists. Holds only daily totals, category codes and column
// names -- never patient rows (those stay in the browser).
const NAMES = new Set(['daily_history.json', 'learned_overrides.json', 'verification_history.json', 'schema_baselines.json'])
const MAX_BYTES = 5 * 1024 * 1024

export async function onRequest({ request, env, params }) {
  const name = params.name
  if (!NAMES.has(name)) return new Response('Not found', { status: 404 })

  if (request.method === 'GET') {
    const value = await env.STATE.get(name)
    if (value === null) return new Response('Not found', { status: 404 })
    return new Response(value, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
  }

  if (request.method === 'PUT') {
    const text = await request.text()
    if (new TextEncoder().encode(text).length > MAX_BYTES) return new Response('Too large', { status: 413 })
    try {
      JSON.parse(text)
    } catch {
      return new Response('Body must be JSON', { status: 400 })
    }
    await env.STATE.put(name, text)
    return new Response(null, { status: 204 })
  }

  return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, PUT' } })
}
