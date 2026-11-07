// Runs the report engine (src/engine/api.js) off the UI thread. api.js
// forwards the app's API requests here; shared state files (MTD history,
// remembered category choices, ...) are pulled from / pushed to Cloudflare KV
// around every request via /api/state/<name>.
import { handle, store, config } from './engine/api.js'
import templateUrl from './engine/final_output_template.xlsx?url'

config.loadTemplate = async () => {
  const res = await fetch(templateUrl)
  if (!res.ok) throw new Error(`Could not load the Final output template (HTTP ${res.status})`)
  return res.arrayBuffer()
}

async function pullState() {
  const before = {}
  for (const name of Object.keys(store)) {
    const res = await fetch(`/api/state/${name}`, { cache: 'no-store' })
    if (res.ok) store[name] = await res.text()
    // 404 = nothing shared yet, keep the shipped seed. Anything else: stop, or
    // pushing afterwards would overwrite the shared history with the seed.
    else if (res.status !== 404) throw new Error(`Could not load shared ${name} (HTTP ${res.status})`)
    before[name] = store[name]
  }
  return before
}

async function pushState(before) {
  // ponytail: last write wins per file -- fine while one PC runs the daily
  // report at a time; move to per-day KV keys or D1 if PCs process concurrently.
  for (const [name, text] of Object.entries(store)) {
    if (text === before[name]) continue
    const res = await fetch(`/api/state/${name}`, { method: 'PUT', body: text })
    if (!res.ok) throw new Error(`Could not save shared ${name} (HTTP ${res.status})`)
  }
}

async function run({ id, method, path, query, body, files }) {
  try {
    const before = await pullState()
    const result = await handle({
      method, path, query,
      body: body ? JSON.parse(body) : null,
      files: (files || []).map((f) => ({ name: f.name, bytes: f.buffer })),
    })
    await pushState(before)
    if (result.bytes) return { id, status: result.status, filename: result.filename, content_type: result.content_type, bytes: result.bytes }
    return { id, status: result.status, text: JSON.stringify(result.json) }
  } catch (err) {
    console.error(err)
    return { id, status: 500, text: JSON.stringify({ detail: String(err.message || err) }) }
  }
}

// one request at a time, so state pull/push never interleave
let queue = Promise.resolve()
self.onmessage = (event) => {
  queue = queue.then(() => run(event.data)).then((reply) => {
    self.postMessage(reply, reply.bytes ? [reply.bytes.buffer] : [])
  })
}
