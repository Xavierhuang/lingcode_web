// swarm.js — Multi-agent Swarm Build pipeline for /try.html
// Orchestrates: Architect → Coder(s) → Reviewer → DB Schema
// All providers available; outputs same as single-provider mode.

import { runAgent } from './agent.js?v=20260602d';

// ---- System Prompts ----

export const ARCHITECT_SYSTEM_PROMPT = `You are a software architect in a browser code playground. Given a user's request, output a structured JSON specification for the app they want to build.

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

If the request includes an [Approved scope] block, treat it as fixed product scope — design within it and do not add features the user excluded.

Return ONLY the JSON object. No explanation, no preamble.`;

export const CODER_SYSTEM_PROMPT = `You are a skilled front-end developer in a browser playground. You will receive a structured app specification in JSON. Implement every feature in the spec exactly.

Output ONE fenced \`\`\`html block containing a complete, self-contained prototype. Include all HTML, CSS, and JavaScript inline.

The spec defines the component tree, data model, features, and style approach. Your code must:
- Match the component structure in the spec
- Implement all features listed
- Support the data model fields
- Use the specified style approach (Tailwind CDN, vanilla CSS, etc.)
- Be runnable standalone in a browser (no build step, no npm)

Reply in the language of the user's original request unless they ask otherwise. Be complete on deliverables.`;

export const REVIEWER_SYSTEM_PROMPT = `You are a code reviewer in a browser playground. You receive a user's original request, the app specification, and the generated HTML code.

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

// ---- Pipeline Orchestration ----

export async function runSwarmPipeline({
  userPrompt,
  selectedProviders,      // array of { provider, apiKey }
  onStageChange,          // (stage: 'architect'|'coder'|'reviewer'|'complete', status) => void
  onCoderEvent,           // (providerId, event) => void
  onReviewerOutput,       // (output) => void
  onArchitectStream,      // (specTextSoFar: string) => void  — streams the architect's spec as it's being written
}) {
  const stages = {
    architect: { status: 'idle', spec: null },
    coder: { status: 'idle', results: [] },
    reviewer: { status: 'idle', verdict: null },
    complete: { status: 'idle' }
  };

  // Stage 1: Architect — single-shot, cheapest provider
  onStageChange?.({ stage: 'architect', status: 'running' });
  stages.architect.status = 'running';

  let specJson = null;
  let specText = '';

  try {
    // Use LingModel (free) or first available provider
    const architectProvider = selectedProviders[0]?.provider;
    const architectKey = selectedProviders[0]?.apiKey || '';

    await runAgent({
      provider: architectProvider,
      apiKey: architectKey,
      userPrompt: `Architect a web app for: ${userPrompt}`,
      system: ARCHITECT_SYSTEM_PROMPT,
      tools: [],
      abortSignal: null,
      onEvent: (e) => {
        if (e.kind === 'text') {
          specText += e.text;
          onArchitectStream?.(specText);
        }
      },
    });

    // Parse spec JSON
    try {
      specJson = JSON.parse(specText.trim());
    } catch (e) {
      console.warn('Architect JSON parse failed, trying to extract:', e);
      // Fallback: try to find first {...} block
      const match = specText.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          specJson = JSON.parse(match[0]);
        } catch {}
      }
    }

    if (!specJson) {
      specJson = {
        title: 'App',
        stack: 'html',
        files: ['index.html'],
        componentTree: [],
        dataModel: {},
        entrypoint: 'index.html',
        styleApproach: 'vanilla CSS',
        features: [],
        notes: ''
      };
    }

    stages.architect.status = 'done';
    stages.architect.spec = specJson;
    onStageChange?.({ stage: 'architect', status: 'done', spec: specJson });
  } catch (error) {
    console.error('Architect stage failed:', error);
    stages.architect.status = 'error';
    onStageChange?.({ stage: 'architect', status: 'error', error });
    throw error;
  }

  // Stage 2: Coder — race all selected providers in parallel
  onStageChange?.({ stage: 'coder', status: 'running' });
  stages.coder.status = 'running';

  const coderInput = `Build this application per the specification below:\n\n${JSON.stringify(specJson, null, 2)}`;

  const coderPromises = selectedProviders.map(async ({ provider, apiKey }) => {
    let codeText = '';
    try {
      await runAgent({
        provider,
        apiKey,
        userPrompt: coderInput,
        system: CODER_SYSTEM_PROMPT,
        tools: [],
        abortSignal: null,
        onEvent: (e) => {
          if (e.kind === 'text') codeText += e.text;
          onCoderEvent?.(provider.id, e);
        },
      });
      return { provider, success: true, code: codeText };
    } catch (error) {
      console.error(`Coder [${provider.name}] failed:`, error);
      return { provider, success: false, error };
    }
  });

  const coderResults = await Promise.all(coderPromises);
  const successfulCoders = coderResults.filter((r) => r.success);

  stages.coder.status = 'done';
  stages.coder.results = coderResults;
  onStageChange?.({ stage: 'coder', status: 'done', results: coderResults });

  if (successfulCoders.length === 0) {
    throw new Error('All coder agents failed');
  }

  // Pick best (first successful) for reviewer
  const winnerCoder = successfulCoders[0];
  let generatedCode = winnerCoder.code;

  // Extract HTML from markdown fence if needed
  const htmlMatch = generatedCode.match(/```(?:html)?\n([\s\S]*?)\n```/);
  if (htmlMatch) {
    generatedCode = htmlMatch[1].trim();
  }

  // Stage 3: Reviewer — single-shot on winner
  onStageChange?.({ stage: 'reviewer', status: 'running' });
  stages.reviewer.status = 'running';

  let reviewerText = '';

  try {
    const reviewerProvider = selectedProviders[0]?.provider;
    const reviewerKey = selectedProviders[0]?.apiKey || '';

    const reviewInput = `User request: ${userPrompt}\n\nApp spec:\n\`\`\`json\n${JSON.stringify(specJson, null, 2)}\n\`\`\`\n\nGenerated code:\n\`\`\`html\n${generatedCode}\n\`\`\`\n\nReview this code.`;

    await runAgent({
      provider: reviewerProvider,
      apiKey: reviewerKey,
      userPrompt: reviewInput,
      system: REVIEWER_SYSTEM_PROMPT,
      tools: [],
      abortSignal: null,
      onEvent: (e) => {
        if (e.kind === 'text') reviewerText += e.text;
      },
    });

    // Parse reviewer JSON
    let verdict = null;
    try {
      verdict = JSON.parse(reviewerText.trim());
    } catch (e) {
      const match = reviewerText.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          verdict = JSON.parse(match[0]);
        } catch {}
      }
    }

    if (verdict) {
      stages.reviewer.status = 'done';
      stages.reviewer.verdict = verdict;
      onReviewerOutput?.(verdict);

      // If reviewer says needs_fix and provides patched code, use it
      if (verdict.rewriteRequired && verdict.patchedCode) {
        generatedCode = verdict.patchedCode;
      }
    }

    onStageChange?.({ stage: 'reviewer', status: 'done', verdict });
  } catch (error) {
    console.error('Reviewer stage failed:', error);
    stages.reviewer.status = 'error';
    onStageChange?.({ stage: 'reviewer', status: 'error', error });
    // Don't throw — reviewer failure is non-fatal
  }

  // Return complete result
  onStageChange?.({ stage: 'complete', status: 'done' });
  return {
    spec: specJson,
    code: generatedCode,
    coderResults,
    reviewerVerdict: stages.reviewer.verdict,
  };
}

// ---- Utility: Extract HTML from code ----

export function extractHtmlFromCodeBlock(text) {
  const htmlMatch = text.match(/```(?:html)?\n([\s\S]*?)\n```/);
  if (htmlMatch) {
    return htmlMatch[1].trim();
  }
  return text;
}

// ---- SONA-Lite: Self-Learning Provider Router ----
// Stores keyword → provider score mappings in localStorage.
// After each build, updates scores based on judge verdict.
// On next similar prompt, routes to historically best provider.

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from',
  'has', 'he', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the',
  'to', 'was', 'with', 'this', 'if', 'not', 'do', 'does', 'did', 'will',
  'would', 'should', 'could', 'can', 'make', 'get', 'go', 'want', 'need',
  'have', 'i', 'you', 'me', 'we', 'they', 'them'
]);

export const SONA = {
  STORAGE_KEY: 'lingcode-sona-v1',
  MAX_PATTERNS: 200,

  load() {
    try {
      const json = localStorage.getItem(this.STORAGE_KEY);
      if (!json) return { patterns: {} };
      return JSON.parse(json);
    } catch {
      return { patterns: {} };
    }
  },

  save(state) {
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(state));
    } catch {
      console.warn('SONA localStorage save failed');
    }
  },

  extractKeywords(prompt) {
    // Normalize: lowercase, split, remove stop words, keep 3+ letter tokens
    const tokens = prompt.toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !STOP_WORDS.has(t))
      .sort();
    return tokens.slice(0, 8).join(' '); // Use first 8 tokens
  },

  route(prompt, availableProviders) {
    // Given a prompt, find the historically best provider for similar prompts.
    const state = this.load();
    const keywords = this.extractKeywords(prompt);

    if (!keywords) return null;

    // Find closest pattern match (keyword overlap)
    let bestPattern = null;
    let bestScore = 0.2; // Require >20% overlap
    const kws = new Set(keywords.split(' '));

    for (const [key, pattern] of Object.entries(state.patterns)) {
      if (!pattern.scores) continue;
      const pkws = new Set(key.split(' '));
      const intersection = [...kws].filter((k) => pkws.has(k)).length;
      const overlap = intersection / Math.max(kws.size, pkws.size, 1);
      if (overlap > bestScore) {
        bestScore = overlap;
        bestPattern = pattern;
      }
    }

    if (!bestPattern) return null;

    // Return provider with highest score
    let winner = null;
    let winnerScore = -Infinity;
    for (const [pid, score] of Object.entries(bestPattern.scores)) {
      if (availableProviders.has(pid) && score > winnerScore) {
        winnerScore = score;
        winner = pid;
      }
    }

    return winner ? { providerId: winner, confidence: bestScore } : null;
  },

  update(prompt, providerId, rubricScore) {
    // After a build, update the pattern with the judge's score.
    // EMA (α=0.3) so recent results weigh more.
    const state = this.load();
    const keywords = this.extractKeywords(prompt);

    if (!keywords) return;

    const key = keywords;
    if (!state.patterns[key]) {
      state.patterns[key] = {
        keywords: key.split(' '),
        scores: {},
        useCounts: {},
        lastUsed: Date.now(),
      };
    }

    const pattern = state.patterns[key];
    const prev = pattern.scores[providerId] ?? 5.0; // Default starting score
    const count = (pattern.useCounts[providerId] ?? 0) + 1;
    const alpha = 0.3; // EMA weight for new data
    pattern.scores[providerId] = prev * (1 - alpha) + rubricScore * alpha;
    pattern.useCounts[providerId] = count;
    pattern.lastUsed = Date.now();

    // Evict oldest if over limit
    const keys = Object.keys(state.patterns);
    if (keys.length > this.MAX_PATTERNS) {
      const oldest = keys.reduce((a, b) =>
        state.patterns[a].lastUsed < state.patterns[b].lastUsed ? a : b
      );
      delete state.patterns[oldest];
    }

    this.save(state);
  },

  getSuggestion(prompt, availableProviders) {
    // Returns { providerId, confidence, reason } or null
    const route = this.route(prompt, availableProviders);
    if (!route) return null;

    const state = this.load();
    const keywords = this.extractKeywords(prompt);
    const pattern = state.patterns[keywords];
    if (!pattern) return null;

    const score = pattern.scores[route.providerId];
    return {
      providerId: route.providerId,
      confidence: route.confidence,
      historicalScore: score,
      usageCount: pattern.useCounts[route.providerId] || 0,
    };
  },
};
