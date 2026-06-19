#!/usr/bin/env python3
"""
rewrite-top30-tutorials.py — Question-shape titles + TL;DR-first paragraphs.

For each tutorial in the REWRITES dict the script:
  - Replaces <title>...</title>
  - Replaces the first <h1>...</h1>
  - Inserts <p class="tldr"><strong>TL;DR:</strong> ...</p> before the existing <p class="intro">

Idempotent via the sentinel <!-- geo-rewrite:v1 -->.

Filenames stay unchanged — URLs do not break. Only the human-visible title and
the first paragraph are touched.

Usage:
  python3 scripts/rewrite-top30-tutorials.py             # apply all rewrites
  python3 scripts/rewrite-top30-tutorials.py --dry       # report planned changes
"""

import re
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
WEBSITE_DIR = SCRIPT_DIR.parent
TUTORIALS_DIR = WEBSITE_DIR / "tutorials"
SENTINEL = "geo-rewrite:v1"

# Map: slug -> { title: full <title> text, h1: new H1, tldr: TL;DR paragraph (no enclosing tag) }
# Titles end with " | LingCode Tutorials" so they read well in search results.
REWRITES = {
    "connect-an-mcp-server": {
        "title": "How do I connect an MCP server to LingCode? | Tutorials",
        "h1": "How do I connect an MCP server to LingCode?",
        "tldr": "Add an MCP server entry to <code>.lingcode/mcp.json</code> (or the equivalent UI in the Mac IDE) with the server's command, args, and env. LingCode launches it as a subprocess and exposes its tools to the agent as <code>mcp__&lt;id&gt;__&lt;name&gt;</code> calls. Works in the Mac IDE, the CLI, and /try (HTTP transport only in /try).",
    },
    "understanding-providers": {
        "title": "Which AI provider should I use in LingCode? | Tutorials",
        "h1": "Which AI provider should I use in LingCode?",
        "tldr": "Use <strong>Claude</strong> for high-stakes refactors and design tasks, <strong>DeepSeek-V4 Flash</strong> for bulk and rapid prototyping, <strong>GPT-4o</strong> for balanced general work, and <strong>Ollama</strong> when you need offline. LingCode supports 13 providers — switch per-task or mid-conversation.",
    },
    "deepseek": {
        "title": "How do I use DeepSeek in LingCode? | Tutorials",
        "h1": "How do I use DeepSeek in LingCode?",
        "tldr": "Add your DeepSeek API key in <em>Settings → AI Providers → DeepSeek</em>, pick <em>DeepSeek-V4 Flash</em> for speed or <em>V4 Pro</em> for quality, and start chatting. The CLI uses the same key from macOS Keychain.",
    },
    "lingmodel": {
        "title": "What is LingModel and how do I use it? | Tutorials",
        "h1": "What is LingModel and how do I use it?",
        "tldr": "LingModel is LingCode's managed inference — no API key needed. It's free on the Starter tier with limits, and unmetered on Pro and Max Pro. Pick <em>LingModel</em> from the provider menu and start prompting; everything runs through LingCode's hosted proxy.",
    },
    "build-a-multi-page-website": {
        "title": "How do I build a multi-page website in LingCode /try? | Tutorials",
        "h1": "How do I build a multi-page website in LingCode /try?",
        "tldr": "Prompt for the home page first, then prompt <em>\"add a /pricing page\"</em> and <em>\"add a /about page.\"</em> /try builds shared nav and styling automatically. Download the whole site as a .zip when you're done, or Publish to a free lingcode.dev/p/&lt;name&gt; URL.",
    },
    "build-a-pitch-deck": {
        "title": "How do I build a pitch deck in LingCode /try? | Tutorials",
        "h1": "How do I build a pitch deck in LingCode /try?",
        "tldr": "Open /try, prompt <em>\"a 10-slide pitch deck for &lt;company&gt; with problem, solution, market, traction, ask\"</em>, iterate with element-level ⌘-click edits, and export to PDF/PowerPoint when done. Total time: under 10 minutes.",
    },
    "build-an-analytics-dashboard": {
        "title": "How do I build an analytics dashboard in LingCode /try? | Tutorials",
        "h1": "How do I build an analytics dashboard in LingCode /try?",
        "tldr": "Prompt /try for <em>\"a SaaS analytics dashboard with KPI cards, three Chart.js charts, and realistic mock data.\"</em> The first version takes about 30 seconds. Iterate on layout and metrics with element-level edits; download or publish when satisfied.",
    },
    "install-and-use-the-lingcode-cli": {
        "title": "How do I install and use the lingcode CLI? | Tutorials",
        "h1": "How do I install and use the lingcode CLI?",
        "tldr": "On macOS/Linux: <code>curl -fsSL https://lingcode.dev/install.sh | sh</code>. On Windows: download the Bun zip from /cli. Run <code>lingcode</code> for the REPL or <code>lingcode ask --provider deepseek \"…\"</code> for one-shot. Works with all 13 providers and reuses keys from the desktop app's Keychain.",
    },
    "set-up-stripe-api-keys": {
        "title": "How do I set up Stripe API keys correctly? | Tutorials",
        "h1": "How do I set up Stripe API keys correctly?",
        "tldr": "Stripe gives you four keys: <em>pk_test</em>, <em>sk_test</em>, <em>pk_live</em>, <em>sk_live</em>. Publishable (pk) goes in client code, secret (sk) goes in env vars only — never client code. Use test keys until launch, then swap to live keys in one place (env vars), not in code.",
    },
    "set-up-supabase-database-and-auth": {
        "title": "How do I set up Supabase for database and auth? | Tutorials",
        "h1": "How do I set up Supabase for database and auth?",
        "tldr": "Sign up at supabase.com, create a project, copy the <em>Project URL</em> and <em>anon</em> key from <em>Settings → API</em> into your env vars, and call <code>createClient(url, key)</code>. Database, auth, storage, and a JS SDK all come from that one signup. Free tier: 500 MB DB, 50K active users.",
    },
    "claude-anthropic": {
        "title": "How do I use Claude (Anthropic) in LingCode? | Tutorials",
        "h1": "How do I use Claude (Anthropic) in LingCode?",
        "tldr": "Get an API key at console.anthropic.com, paste it into <em>Settings → AI Providers → Claude</em>, and pick a Claude model (Opus 4.7 for hardest tasks, Sonnet 4.6 for default, Haiku 4.5 for speed). Tool use, MCP, and streaming all work out of the box.",
    },
    "openai-gpt4": {
        "title": "How do I use OpenAI (GPT-4o) in LingCode? | Tutorials",
        "h1": "How do I use OpenAI (GPT-4o) in LingCode?",
        "tldr": "Get an API key at platform.openai.com, paste into <em>Settings → AI Providers → OpenAI</em>, and pick a model (GPT-4o for the default balance, GPT-4o-mini for cheap, o1 for hardest reasoning). Works with native function-call tool use and MCP.",
    },
    "magic-deploy-a-website": {
        "title": "How do I deploy a website with Magic Deploy in LingCode? | Tutorials",
        "h1": "How do I deploy a website with Magic Deploy in LingCode?",
        "tldr": "Open the project in the Mac IDE, click <em>Deploy → Magic Deploy</em>, pick a target (Vercel / Netlify / Railway / Fly.io / Heroku), paste the API token, click <em>Ship</em>. LingCode handles the build, the env vars, and the post-deploy verification.",
    },
    "deploy-on-fly-io": {
        "title": "How do I deploy on Fly.io from LingCode? | Tutorials",
        "h1": "How do I deploy on Fly.io from LingCode?",
        "tldr": "Run <code>fly auth login</code> once, run <code>fly launch</code> to scaffold a <code>fly.toml</code> in your project, then <code>fly deploy</code> ships it. Fly.io places your Docker container in 30+ regions automatically — pay per-CPU-second.",
    },
    "deploy-on-railway": {
        "title": "How do I deploy on Railway from LingCode? | Tutorials",
        "h1": "How do I deploy on Railway from LingCode?",
        "tldr": "Push to GitHub, connect the repo to Railway at railway.app, and Railway auto-detects your stack and builds. For LingCode-side deploys, paste a Railway token into Magic Deploy → Railway and click Ship. No Dockerfile needed for most stacks.",
    },
    "set-up-https-with-lets-encrypt": {
        "title": "How do I set up HTTPS with Let's Encrypt? | Tutorials",
        "h1": "How do I set up HTTPS with Let's Encrypt?",
        "tldr": "On Ubuntu: <code>sudo apt install certbot python3-certbot-nginx</code>, then <code>sudo certbot --nginx -d yourdomain.com</code>. Certbot edits your nginx config and renews automatically every 60 days. Free certs, full TLS, 5 minutes total.",
    },
    "write-a-custom-skill": {
        "title": "How do I write a custom skill for LingCode? | Tutorials",
        "h1": "How do I write a custom skill for LingCode?",
        "tldr": "Create a markdown file in <code>.claude/skills/&lt;your-skill&gt;/SKILL.md</code> with YAML frontmatter (<code>name</code>, <code>description</code>) and the instructions below. The agent auto-discovers it and invokes it when a matching task comes up.",
    },
    "write-a-subagent": {
        "title": "How do I write a subagent for LingCode? | Tutorials",
        "h1": "How do I write a subagent for LingCode?",
        "tldr": "Create a markdown file in <code>.claude/agents/&lt;your-agent&gt;.md</code> with frontmatter (<code>name</code>, <code>description</code>, optional <code>tools</code>) and a system prompt below. The main agent can delegate to it via the <code>Agent</code> tool — useful for tasks with isolated context.",
    },
    "explain-terminal-errors-with-ai": {
        "title": "How do I explain terminal errors with AI in LingCode? | Tutorials",
        "h1": "How do I explain terminal errors with AI in LingCode?",
        "tldr": "Select the error text in LingCode's terminal pane, right-click, and pick <em>Explain with AI</em>. A floating popup shows the explanation — out-of-band from your main chat, so it doesn't pollute your conversation context.",
    },
    "dispatch-parallel-agents": {
        "title": "How do I dispatch parallel agents for independent tasks? | Tutorials",
        "h1": "How do I dispatch parallel agents for independent tasks?",
        "tldr": "When you have 2+ tasks with no shared state, send a single message with multiple <code>Agent</code> tool-calls. The agents run concurrently, return independent results, and the main loop continues. Use for parallel searches, parallel test runs, or parallel build checks.",
    },
    "run-a-prompt-on-a-schedule": {
        "title": "How do I run a LingCode prompt on a schedule? | Tutorials",
        "h1": "How do I run a LingCode prompt on a schedule?",
        "tldr": "<code>/loop 5m /check-deploys</code> runs a prompt every 5 minutes <em>in your current session</em>. <code>/schedule</code> creates a cron-style remote routine that runs on Anthropic's infrastructure when you're offline. Pick local /loop for polling, remote /schedule for background work.",
    },
    "auth-with-clerk": {
        "title": "How do I add auth to my app with Clerk? | Tutorials",
        "h1": "How do I add auth to my app with Clerk?",
        "tldr": "Sign up at clerk.com, create an application, install <code>@clerk/nextjs</code> (or your framework's package), wrap the app in <code>&lt;ClerkProvider&gt;</code>, drop in <code>&lt;SignIn /&gt;</code> and <code>&lt;UserButton /&gt;</code>. Free tier: 10,000 MAUs.",
    },
    "auth-with-auth0": {
        "title": "How do I add auth to my app with Auth0? | Tutorials",
        "h1": "How do I add auth to my app with Auth0?",
        "tldr": "Auth0 is the enterprise-grade auth provider (SAML, SSO, SCIM, custom rules). Create a tenant at auth0.com, create an Application, configure callback URLs, drop in their SDK, redirect. Pick over Clerk when you need IT-grade identity-provider plug-in.",
    },
    "install-a-skill": {
        "title": "What is a LingCode skill and how do I install one? | Tutorials",
        "h1": "What is a LingCode skill and how do I install one?",
        "tldr": "A skill is a single markdown file that teaches the agent a habit — drop it in <code>~/.claude/skills/&lt;name&gt;/SKILL.md</code> (user-wide) or <code>.claude/skills/&lt;name&gt;/SKILL.md</code> (project-wide). The agent picks it up automatically based on its description field.",
    },
    "add-custom-hooks": {
        "title": "How do I add custom hooks to LingCode (PreToolUse, UserPromptSubmit)? | Tutorials",
        "h1": "How do I add custom hooks to LingCode?",
        "tldr": "Edit <code>~/.claude/settings.json</code> (or <code>.claude/settings.json</code> in a project) and add a <code>hooks</code> entry mapping events (<code>PreToolUse</code>, <code>UserPromptSubmit</code>, <code>SessionStart</code>, <code>Stop</code>) to shell commands. The harness runs the command, not the agent — useful for guardrails and automation.",
    },
    "author-your-own-mcp-server": {
        "title": "How do I author my own MCP server? | Tutorials",
        "h1": "How do I author my own MCP server?",
        "tldr": "Write a Node or Python program that implements the MCP protocol (a few hundred lines using the official SDK), expose typed tools that wrap your service's API, point LingCode at it with <code>command</code> + <code>args</code> in mcp.json. The agent now has typed access to whatever your service does.",
    },
    "connect-linear-and-github-via-mcp": {
        "title": "How do I connect Linear and GitHub to LingCode via MCP? | Tutorials",
        "h1": "How do I connect Linear and GitHub to LingCode via MCP?",
        "tldr": "Both Linear and GitHub publish official MCP servers. Install via <code>npm i -g @linear/mcp-server</code> (and equivalent for GitHub), add an entry to <code>~/.lingcode/mcp.json</code> with your API token, and the agent can search issues, open PRs, and read ticket context directly.",
    },
    "switch-providers-mid-conversation": {
        "title": "How do I switch providers mid-conversation in LingCode? | Tutorials",
        "h1": "How do I switch providers mid-conversation in LingCode?",
        "tldr": "Click the provider dropdown in the chat header and pick a different model — LingCode carries the conversation history into the new provider. Use when one model stalls on a refactor: send the same chat to a different provider without losing context.",
    },
    "undo-bad-ai-edits": {
        "title": "How do I undo a bad AI edit in LingCode? | Tutorials",
        "h1": "How do I undo a bad AI edit in LingCode?",
        "tldr": "Open <em>Edit → AI History</em> (or press ⌘⇧Z) and pick the agent turn you want to rewind to. LingCode's pre-edit snapshots restore <code>project.pbxproj</code>, <code>Info.plist</code>, <code>build.gradle</code>, and all touched files to their pre-turn state — no git checkout needed.",
    },
    "experiment-safely-with-worktrees": {
        "title": "How do I experiment safely with git worktrees in LingCode? | Tutorials",
        "h1": "How do I experiment safely with git worktrees in LingCode?",
        "tldr": "Run <em>Source Control → New Worktree</em> (or <code>git worktree add ../experiment-X feature-X</code>) to create an isolated working copy on a branch. Point the agent at the worktree; if the experiment fails, delete the worktree — your main branch never touched it.",
    },
}


def already_rewritten(raw: str) -> bool:
    return SENTINEL in raw


def replace_first(raw: str, pattern: str, replacement: str) -> tuple:
    """Replace the first regex match. Return (new_raw, replaced_bool)."""
    new, n = re.subn(pattern, replacement, raw, count=1)
    return new, n > 0


def process(slug: str, spec: dict, dry: bool) -> tuple:
    p = TUTORIALS_DIR / f"{slug}.html"
    if not p.exists():
        return ("err", "file not found")

    raw = p.read_text(encoding="utf-8")
    if already_rewritten(raw):
        return ("skip", "already rewritten")

    new_raw = raw

    # 1) Replace <title>
    new_title = spec["title"]
    new_raw, did_title = replace_first(
        new_raw,
        r"<title>[^<]*</title>",
        f"<title>{new_title}</title>",
    )

    # 2) Replace the first <h1>...</h1> (which is the page H1 inside tutorial-header)
    new_h1 = spec["h1"]
    new_raw, did_h1 = replace_first(
        new_raw,
        r"<h1>[^<]*</h1>",
        f"<h1>{new_h1}</h1>",
    )

    # 3) Insert TL;DR paragraph before the intro paragraph
    tldr_html = f'<p class="tldr"><strong>TL;DR:</strong> {spec["tldr"]}</p>'
    intro_anchor = re.search(r'<p class="intro">', new_raw)
    did_tldr = False
    if intro_anchor:
        new_raw = new_raw[:intro_anchor.start()] + tldr_html + "\n      " + new_raw[intro_anchor.start():]
        did_tldr = True

    # 4) Insert sentinel comment right after the <title> tag so it's visible in source
    new_raw, _ = replace_first(
        new_raw,
        r"(</title>)",
        f"\\1\n  <!-- {SENTINEL} -->",
    )

    if dry:
        return ("dry", f"title={did_title} h1={did_h1} tldr={did_tldr}")

    if not (did_title and did_h1 and did_tldr):
        return ("err", f"partial: title={did_title} h1={did_h1} tldr={did_tldr}")

    p.write_text(new_raw, encoding="utf-8")
    return ("ok", "rewrote title/h1 + inserted TL;DR")


def main():
    args = sys.argv[1:]
    dry = "--dry" in args
    counts = {"ok": 0, "skip": 0, "dry": 0, "err": 0}
    for slug, spec in REWRITES.items():
        try:
            status, msg = process(slug, spec, dry)
        except Exception as e:
            status, msg = "err", repr(e)
        counts[status] = counts.get(status, 0) + 1
        prefix = {"ok": "[+]", "skip": "[-]", "dry": "[?]", "err": "[!]"}[status]
        print(f"{prefix} {slug}: {msg}")
    print(f"\nSummary: {counts}")


if __name__ == "__main__":
    main()
