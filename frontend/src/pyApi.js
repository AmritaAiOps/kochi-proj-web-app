// Routes the app's API calls (same URLs the FastAPI server used to serve) to
// the in-browser Python engine in py.worker.js, returning real Response
// objects -- so App.jsx and the components didn't need to change at all.
const ROUTES = [
  /^\/detect$/,
  /^\/process$/,
  /^\/download\/[^/]+$/,
  /^\/category-review(\/resolve)?$/,
  /^\/api\/(monthly-average|verification-report|schema-baseline\/reset)$/,
]

const worker = new Worker(new URL('./py.worker.js', import.meta.url), { type: 'module' })
const pending = new Map()
let nextId = 0
worker.onmessage = ({ data }) => {
  pending.get(data.id)?.(data)
  pending.delete(data.id)
}

const realFetch = window.fetch.bind(window)

window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url, window.location.href)
  if (url.origin !== window.location.origin || !ROUTES.some((r) => r.test(url.pathname))) {
    return realFetch(input, init)
  }

  let body = null
  let files = null
  if (init.body instanceof FormData) {
    const fields = {}
    files = []
    for (const [key, value] of init.body.entries()) {
      if (value instanceof File) files.push({ name: value.name, buffer: await value.arrayBuffer() })
      else fields[key] = value
    }
    body = JSON.stringify(fields)
  } else if (typeof init.body === 'string') {
    body = init.body
  }

  const reply = await new Promise((resolve) => {
    const id = nextId++
    pending.set(id, resolve)
    const message = { id, method: (init.method || 'GET').toUpperCase(), path: url.pathname, query: url.search.slice(1), body, files }
    worker.postMessage(message, files ? files.map((f) => f.buffer) : [])
  })

  if (reply.bytes) {
    return new Response(reply.bytes, {
      status: reply.status,
      headers: { 'Content-Type': reply.content_type, 'Content-Disposition': `attachment; filename="${reply.filename}"` },
    })
  }
  return new Response(reply.text, { status: reply.status, headers: { 'Content-Type': 'application/json' } })
}
