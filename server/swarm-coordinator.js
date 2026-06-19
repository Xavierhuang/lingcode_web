/**
 * SwarmCoordinator - Multi-agent pipeline orchestration
 * Supports 15+ LLM providers (Anthropic-format + 13 OpenAI-compatible)
 * Architect → Coder → Reviewer stages
 */

const https = require('https');
const http = require('http');

// System prompts for each stage
const ARCHITECT_SYSTEM_PROMPT = `You are a software architect in a browser code playground. Given a user's request, output a structured JSON specification for the app they want to build.

Output ONLY valid JSON, no prose, no markdown fences.

Schema:
{
  "title": "string — app name",
  "stack": "html|tailwind-cdn|react-cdn",
  "files": ["array of filenames to generate"],
  "componentTree": [
    { "name": "ComponentName", "children": ["ChildComponent", ...], "role": "description" }
  ],
  "dataModel": {
    "EntityName": { "fieldName": "type description", ... },
    ...
  },
  "entrypoint": "string — primary filename (usually index.html)",
  "styleApproach": "string — how to style (tailwind-cdn, vanilla CSS, etc)",
  "features": ["user-visible feature 1", "feature 2", ...],
  "notes": "implementation hints for the coder — edge cases, libraries, patterns"
}

Return ONLY the JSON object. No explanation, no preamble.`;

const CODER_SYSTEM_PROMPT = `You are a skilled front-end developer in a browser playground. You will receive a structured app specification in JSON. Implement every feature in the spec exactly.

Output ONE fenced \`\`\`html block containing a complete, self-contained prototype. Include all HTML, CSS, and JavaScript inline.

The spec defines the component tree, data model, features, and style approach. Your code must:
- Match the component structure in the spec
- Implement all features listed
- Support the data model fields
- Use the specified style approach (Tailwind CDN, vanilla CSS, etc.)
- Be runnable standalone in a browser (no build step, no npm)

Reply in the language of the user's original request unless they ask otherwise. Be complete on deliverables.`;

const REVIEWER_SYSTEM_PROMPT = `You are a code reviewer in a browser playground. You receive a user's original request, the app specification, and the generated HTML code.

Identify real bugs, accessibility gaps, security issues, and missing features from the spec. Output ONLY valid JSON.

Schema:
{
  "verdict": "good|needs_fix",
  "issues": [
    {
      "severity": "error|warn",
      "category": "bug|missing_feature|accessibility|security|performance",
      "description": "what's wrong",
      "location": "which component or section",
      "suggestedFix": "how to fix it"
    },
    ...
  ],
  "rewriteRequired": boolean — true if the code needs a full rewrite, false if small patches suffice,
  "patchedCode": "complete corrected HTML code ONLY if rewriteRequired=true, else empty string",
  "summary": "brief one-line verdict"
}

Output ONLY the JSON object. No prose, no markdown fences.`;

// ---- Provider Registry ----
const PROVIDER_REGISTRY = {
  // === Anthropic-format ===
  claude: {
    shape: 'anthropic',
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    model: 'claude-sonnet-4-5',
    envKey: 'ANTHROPIC_API_KEY',
  },
  lingmodel: {
    shape: 'anthropic',
    hostname: '127.0.0.1',
    port: 3000,
    protocol: 'http',
    path: '/api/inference/anthropic/v1/messages',
    model: 'kimi-k2.7',
    envKey: null,
  },
  // Back-compat alias for swarm jobs stored with the old Advanced tier id.
  // Same model as `lingmodel` now that Standard/Advanced are collapsed.
  'lingmodel-advanced': {
    shape: 'anthropic',
    hostname: '127.0.0.1',
    port: 3000,
    protocol: 'http',
    path: '/api/inference/anthropic/v1/messages',
    model: 'kimi-k2.7',
    envKey: null,
  },

  // === OpenAI-compatible ===
  deepseek: {
    shape: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    envKey: 'DEEPSEEK_API_KEY',
  },
  openai: {
    shape: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    envKey: 'OPENAI_API_KEY',
  },
  gemini: {
    shape: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash',
    envKey: 'GEMINI_API_KEY',
  },
  groq: {
    shape: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    envKey: 'GROQ_API_KEY',
  },
  mistral: {
    shape: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'mistral-small-latest',
    envKey: 'MISTRAL_API_KEY',
  },
  xai: {
    shape: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    model: 'grok-2-latest',
    envKey: 'XAI_API_KEY',
  },
  together: {
    shape: 'openai',
    baseUrl: 'https://api.together.xyz/v1',
    model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    envKey: 'TOGETHER_API_KEY',
  },
  openrouter: {
    shape: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'anthropic/claude-haiku-4-5',
    envKey: 'OPENROUTER_API_KEY',
    extraHeaders: {
      'HTTP-Referer': 'https://lingcode.dev',
      'X-Title': 'LingCode Try',
    },
  },
  fireworks: {
    shape: 'openai',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    model: 'accounts/fireworks/models/llama-v3p1-70b-instruct',
    envKey: 'FIREWORKS_API_KEY',
  },
  kimi: {
    shape: 'openai',
    baseUrl: 'https://api.moonshot.ai/v1',
    model: 'moonshot-v1-8k',
    envKey: 'KIMI_API_KEY',
  },
  qwen: {
    shape: 'openai',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-max',
    envKey: 'QWEN_API_KEY',
  },
  zai: {
    shape: 'openai',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    model: 'glm-5.1',
    envKey: 'ZAI_API_KEY',
  },
};

// ---- Generic LLM callers ----

function callAnthropic(prompt, system, config, apiKey) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: config.model,
      max_tokens: 32000,
      system,
      messages: [{ role: 'user', content: prompt }]
    });

    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'anthropic-version': '2024-06-01'
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const options = {
      hostname: config.hostname,
      port: config.port,
      path: config.path,
      method: 'POST',
      headers,
    };

    const lib = config.protocol === 'http' ? http : https;
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.content?.[0]?.text) {
            resolve(json.content[0].text);
          } else {
            reject(new Error(json.error?.message || 'Invalid Anthropic response'));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function callOpenAICompat(prompt, system, config, apiKey) {
  return new Promise((resolve, reject) => {
    const url = new URL(config.baseUrl);
    const isHttp = url.protocol === 'http:';
    const lib = isHttp ? http : https;
    const chatPath = url.pathname.replace(/\/$/, '') + '/chat/completions';

    const body = JSON.stringify({
      model: config.model,
      max_tokens: 32000,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt }
      ]
    });

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttp ? 80 : 443),
      path: chatPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': `Bearer ${apiKey}`,
        ...(config.extraHeaders || {})
      }
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.choices?.[0]?.message?.content) {
            resolve(json.choices[0].message.content);
          } else {
            reject(new Error(json.error?.message || `Invalid response from ${config.baseUrl}`));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Single dispatcher for all providers
async function callProvider(prompt, system, providerId, allKeys) {
  const config = PROVIDER_REGISTRY[providerId];
  if (!config) {
    throw new Error(`Unknown provider: ${providerId}`);
  }

  const apiKey = config.envKey ? (allKeys[config.envKey] || '') : '';

  if (config.shape === 'anthropic') {
    return callAnthropic(prompt, system, config, apiKey);
  } else {
    return callOpenAICompat(prompt, system, config, apiKey);
  }
}

// ---- Swarm stages ----

async function runArchitect(prompt, providerId, allKeys) {
  try {
    const architectPrompt = `Architect a web app for: ${prompt}`;
    const response = await callProvider(architectPrompt, ARCHITECT_SYSTEM_PROMPT, providerId, allKeys);

    // Parse JSON response
    try {
      return JSON.parse(response.trim());
    } catch (e) {
      // Try extracting JSON from markdown fence
      const match = response.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          return JSON.parse(match[0]);
        } catch {}
      }
    }

    // Fallback
    return {
      title: 'Generated App',
      stack: 'html',
      files: ['index.html'],
      componentTree: [],
      dataModel: {},
      entrypoint: 'index.html',
      styleApproach: 'vanilla CSS',
      features: [],
      notes: response.substring(0, 200)
    };
  } catch (error) {
    console.error('Architect error:', error.message);
    return {
      title: 'App',
      stack: 'html',
      files: ['index.html'],
      componentTree: [],
      dataModel: {},
      entrypoint: 'index.html',
      styleApproach: 'vanilla CSS',
      features: [],
      notes: `Error: ${error.message}`
    };
  }
}

async function runCoder(prompt, spec, providerId, allKeys) {
  try {
    const coderPrompt = `Build this application per the specification below:\n\n${JSON.stringify(spec, null, 2)}`;
    const response = await callProvider(coderPrompt, CODER_SYSTEM_PROMPT, providerId, allKeys);

    // Extract HTML from markdown fence — tolerates truncated response (no closing ```)
    const idx = response.toLowerCase().lastIndexOf('```html');
    if (idx >= 0) {
      let body = response.slice(idx + 7).replace(/^[^\n]*\n?/, '');
      const closeIdx = body.indexOf('```');
      if (closeIdx >= 0) body = body.slice(0, closeIdx);
      return body.trim();
    }

    // No fenced block at all — fall back to bare HTML heuristic
    const bareHtmlIdx = response.toLowerCase().indexOf('<!doctype html');
    if (bareHtmlIdx >= 0) return response.slice(bareHtmlIdx).trim();

    return response;
  } catch (error) {
    console.error('Coder error:', error.message);
    return `<html><body><h1>Build Failed</h1><p>${error.message}</p></body></html>`;
  }
}

async function runReviewer(userPrompt, spec, code, providerId, allKeys) {
  try {
    const reviewInput = `User request: ${userPrompt}\n\nApp spec:\n\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\`\n\nGenerated code:\n\`\`\`html\n${code}\n\`\`\`\n\nReview this code.`;
    const response = await callProvider(reviewInput, REVIEWER_SYSTEM_PROMPT, providerId, allKeys);

    // Parse JSON response
    try {
      return JSON.parse(response.trim());
    } catch (e) {
      const match = response.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          return JSON.parse(match[0]);
        } catch {}
      }
    }

    return {
      verdict: 'good',
      issues: [],
      rewriteRequired: false,
      patchedCode: '',
      summary: 'Verdict unavailable'
    };
  } catch (error) {
    console.error('Reviewer error:', error.message);
    return {
      verdict: 'good',
      issues: [],
      rewriteRequired: false,
      patchedCode: '',
      summary: `Error: ${error.message}`
    };
  }
}

module.exports = {
  runArchitect,
  runCoder,
  runReviewer,
  PROVIDER_REGISTRY
};
