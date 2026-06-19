// demo.js — replay cached provider responses with realistic streaming
// timing so /try.html?demo=1 can show a live-looking race without hitting
// real APIs (no auth, no quota, deterministic).
//
// The scripted runner emits the SAME event shape as agent.js's real
// runOnce — { kind: 'text' | 'tool_call' | 'done' } — so the pane code
// downstream is unchanged.

let activeScenario = null;
let slowmoFactor = 1;

/// Scales replay timings — used by the marketing-video pipeline to stretch
/// a ~10s scripted race into ~60s for a TikTok / Reels capture.
export function setSlowmo(factor) {
  slowmoFactor = Math.max(1, Number(factor) || 1);
}

export async function loadScenarios(url = '/try/demo-data.json') {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`demo-data fetch ${r.status}`);
  return r.json();
}

export function setActiveScenario(scenario) { activeScenario = scenario; }
export function getActiveScenario() { return activeScenario; }

/// Picks a random scenario from the loaded list.
export function pickScenario(data, requestedId) {
  const list = data.scenarios || [];
  if (!list.length) return null;
  if (requestedId) {
    const found = list.find((s) => s.id === requestedId);
    if (found) return found;
  }
  return list[Math.floor(Math.random() * list.length)];
}

/// Async-iterator runner with the same shape as agent.js's runOnce.
/// Splits each provider's cached `text` into ~40-char chunks and emits
/// them at intervals derived from `ttftMs` / `totalMs` so the visible
/// streaming pace matches what the metadata claims.
export async function* scriptedRunOnce({ provider }) {
  const data = activeScenario?.responses?.[provider.id];
  if (!data) {
    // No cached response for this provider — finish immediately so the
    // pane shows "no output" instead of hanging.
    yield { kind: 'done', toolCalls: [], inputTokens: 0, outputTokens: 0 };
    return;
  }

  // `text` is stored as an array of lines in demo-data.json so the JSON
  // stays readable. Accept either array-of-lines or a flat string.
  const text = Array.isArray(data.text) ? data.text.join('\n') : (data.text || '');
  const ttft = Math.max(50, (data.ttftMs || 500) * slowmoFactor);
  const total = Math.max(ttft + 500, (data.totalMs || 5000) * slowmoFactor);
  const chunkSize = 40;
  const chunks = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  const streamMs = total - ttft;
  const perChunk = chunks.length ? Math.max(20, streamMs / chunks.length) : 0;

  // First-byte delay (TTFT).
  await sleep(ttft);
  for (const c of chunks) {
    yield { kind: 'text', text: c };
    await sleep(perChunk);
  }
  yield {
    kind: 'done',
    toolCalls: [],
    inputTokens: data.inputTokens || Math.round(text.length / 4),
    outputTokens: data.outputTokens || Math.round(text.length / 4),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
