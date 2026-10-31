// Runs the unchanged Python backend (backend/api.py) in the browser via
// Pyodide. pyApi.js forwards the app's API requests here; shared state files
// (MTD history, remembered category choices, ...) are pulled from / pushed to
// Cloudflare KV around every request via /api/state/<name>.
const PYODIDE = 'https://cdn.jsdelivr.net/pyodide/v314.0.7/full/'

// KV key -> file the Python code reads/writes (see backend/runtime_paths.py)
const STATE_FILES = {
  'daily_history.json': '/app/config/daily_history.json',
  'learned_overrides.json': '/app/config/learned_overrides.json',
  'verification_history.json': '/app/backend/data/verification_history.json',
  'schema_baselines.json': '/app/backend/data/schema_baselines.json',
}

const BRIDGE = `
import json, os, sys
sys.path.insert(0, "/app")
os.chdir("/app")
from backend import api

def bridge(method, path, query, body_json, files):
    body = json.loads(body_json) if body_json else None
    py_files = [(f[0], f[1].to_bytes()) for f in files] if files else None
    r = api.handle(method, path, query, body, py_files)
    if "bytes" in r:
        return json.dumps({"status": r["status"], "filename": r["filename"], "content_type": r["content_type"]}), r["bytes"]
    return json.dumps({"status": r["status"], "text": api.dumps(r["json"])}), None
`

async function boot() {
  const { loadPyodide } = await import(/* @vite-ignore */ `${PYODIDE}pyodide.mjs`)
  const py = await loadPyodide({ indexURL: PYODIDE })
  await py.loadPackage(['pandas', 'micropip'])
  // pure-Python wheels from PyPI, pinned to the versions the tests run against
  await py.pyimport('micropip').install(['openpyxl==3.1.5', 'et-xmlfile==2.0.0'])
  const zip = await fetch('/pyapp.zip')
  if (!zip.ok) throw new Error(`Could not load pyapp.zip (${zip.status})`)
  py.unpackArchive(await zip.arrayBuffer(), 'zip', { extractDir: '/app' })
  py.runPython(BRIDGE)
  return py
}

let ready = boot() // start loading right away, while the user picks files

function readText(py, path) {
  try {
    return py.FS.readFile(path, { encoding: 'utf8' })
  } catch {
    return null
  }
}

async function pullState(py) {
  const before = {}
  for (const [name, path] of Object.entries(STATE_FILES)) {
    const res = await fetch(`/api/state/${name}`, { cache: 'no-store' })
    if (res.ok) py.FS.writeFile(path, await res.text())
    // 404 = nothing shared yet, keep the shipped seed. Anything else: stop, or
    // pushing afterwards would overwrite the shared history with the seed.
    else if (res.status !== 404) throw new Error(`Could not load shared ${name} (HTTP ${res.status})`)
    before[name] = readText(py, path)
  }
  return before
}

async function pushState(py, before) {
  // ponytail: last write wins per file -- fine while one PC runs the daily
  // report at a time; move to per-day KV keys or D1 if PCs process concurrently.
  for (const [name, path] of Object.entries(STATE_FILES)) {
    const text = readText(py, path)
    if (text === null || text === before[name]) continue
    const res = await fetch(`/api/state/${name}`, { method: 'PUT', body: text })
    if (!res.ok) throw new Error(`Could not save shared ${name} (HTTP ${res.status})`)
  }
}

async function run({ id, method, path, query, body, files }) {
  let py
  try {
    py = await ready
  } catch (err) {
    ready = boot() // e.g. offline on first load -- retry on the next request
    return { id, status: 503, text: JSON.stringify({ detail: `Calculation engine failed to load: ${err.message}` }) }
  }
  try {
    const before = await pullState(py)
    const result = py.globals.get('bridge')(method, path, query, body, files ? files.map((f) => [f.name, new Uint8Array(f.buffer)]) : null)
    const [metaJson, data] = result.toJs()
    result.destroy()
    await pushState(py, before)
    const meta = JSON.parse(metaJson)
    return data ? { id, ...meta, bytes: data } : { id, ...meta }
  } catch (err) {
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
