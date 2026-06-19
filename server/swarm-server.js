/**
 * Swarm Server - Express.js wrapper for multi-agent orchestration
 * Listens on port 7878, exposes /v1/swarm/build SSE endpoint
 */

const express = require('express');
const { runArchitect, runCoder, runReviewer } = require('./swarm-coordinator');

const app = express();
const PORT = process.env.PORT || 7878;

// Middleware
app.use((req, res, next) => {
  // CORS headers for browser access
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Ping endpoint (for browser client discovery)
app.get('/v1/ping', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Swarm build endpoint — SSE stream
app.post('/v1/swarm/build', async (req, res) => {
  const { prompt, provider, buildId } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'prompt required' });
  }

  const selectedProvider = provider || 'deepseek';
  console.log(`[${buildId || 'unknown'}] Swarm build started: prompt="${prompt.substring(0, 50)}...", provider="${selectedProvider}"`);

  // Setup SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Heartbeat: SSE comment line every 15s keeps the connection alive
  // through nginx + browser idle timeouts during long coder stages.
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch (_) { clearInterval(heartbeat); }
  }, 15000);
  res.on('close', () => clearInterval(heartbeat));

  try {
    // Retrieve all API keys from environment
    const allKeys = {
      ANTHROPIC_API_KEY:  process.env.ANTHROPIC_API_KEY  || '',
      DEEPSEEK_API_KEY:   process.env.DEEPSEEK_API_KEY   || '',
      OPENAI_API_KEY:     process.env.OPENAI_API_KEY     || '',
      GEMINI_API_KEY:     process.env.GEMINI_API_KEY     || '',
      GROQ_API_KEY:       process.env.GROQ_API_KEY       || '',
      MISTRAL_API_KEY:    process.env.MISTRAL_API_KEY    || '',
      XAI_API_KEY:        process.env.XAI_API_KEY        || '',
      TOGETHER_API_KEY:   process.env.TOGETHER_API_KEY   || '',
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
      FIREWORKS_API_KEY:  process.env.FIREWORKS_API_KEY  || '',
      KIMI_API_KEY:       process.env.KIMI_API_KEY       || '',
      QWEN_API_KEY:       process.env.QWEN_API_KEY       || '',
      ZAI_API_KEY:        process.env.ZAI_API_KEY        || '',
    };

    // Stage 1: Architect
    sendEvent('stage_change', { stage: 'architect', status: 'running' });
    console.log(`[${buildId || 'unknown'}] Architect stage started`);

    const spec = await runArchitect(prompt, selectedProvider, allKeys);
    console.log(`[${buildId || 'unknown'}] Architect stage completed`);
    sendEvent('stage_change', { stage: 'architect', status: 'done', spec });

    // Stage 2: Coder
    sendEvent('stage_change', { stage: 'coder', status: 'running' });
    console.log(`[${buildId || 'unknown'}] Coder stage started`);

    const code = await runCoder(prompt, spec, selectedProvider, allKeys);
    console.log(`[${buildId || 'unknown'}] Coder stage completed`);
    sendEvent('code_generated', { code });
    sendEvent('stage_change', { stage: 'coder', status: 'done' });

    // Stage 3: Reviewer
    sendEvent('stage_change', { stage: 'reviewer', status: 'running' });
    console.log(`[${buildId || 'unknown'}] Reviewer stage started`);

    const verdict = await runReviewer(prompt, spec, code, selectedProvider, allKeys);
    console.log(`[${buildId || 'unknown'}] Reviewer stage completed`);
    sendEvent('stage_change', { stage: 'reviewer', status: 'done', verdict });

    // Complete
    sendEvent('swarm_complete', { code, spec, verdict });
    console.log(`[${buildId || 'unknown'}] Swarm build complete`);
    res.end();
  } catch (error) {
    console.error(`[${buildId || 'unknown'}] Swarm error:`, error.message);
    sendEvent('swarm_failed', { error: error.message });
    res.end();
  }
});

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy', uptime: process.uptime() });
});

// Start server
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Swarm server listening on http://127.0.0.1:${PORT}`);
  console.log(`  Providers available:`);

  const providerCheck = {
    ANTHROPIC_API_KEY: 'Claude / LingModel',
    DEEPSEEK_API_KEY: 'DeepSeek',
    OPENAI_API_KEY: 'OpenAI',
    GEMINI_API_KEY: 'Gemini',
    GROQ_API_KEY: 'Groq',
    MISTRAL_API_KEY: 'Mistral',
    XAI_API_KEY: 'xAI Grok',
    TOGETHER_API_KEY: 'Together',
    OPENROUTER_API_KEY: 'OpenRouter',
    FIREWORKS_API_KEY: 'Fireworks',
    KIMI_API_KEY: 'Kimi',
    QWEN_API_KEY: 'Qwen',
    ZAI_API_KEY: 'z.ai',
  };

  let foundAny = false;
  for (const [envVar, label] of Object.entries(providerCheck)) {
    if (process.env[envVar]) {
      console.log(`    ✓ ${label}`);
      foundAny = true;
    }
  }
  if (!foundAny) {
    console.log(`    ⚠ No API keys found. Set any of: ${Object.keys(providerCheck).join(', ')}`);
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});
