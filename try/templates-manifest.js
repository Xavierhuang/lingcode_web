// templates-manifest.js — Tier-1 starter prototypes for the /try gallery.
//
// Each template is a single self-contained HTML file under
// /try/templates/<id>/index.html. The gallery click handler fetches the
// HTML and feeds it straight into the existing shared-prototype path
// (openPreview / readSharedHTML), so users see the same modal they'd see
// for a published share link — no new pane code required.
//
// Adding a new template:
//   1. Drop /try/templates/<id>/index.html
//   2. Append an entry to TEMPLATES with id, label, blurb, accent color
//   3. (Optional) Add an inline SVG preview by replacing the gradient

export const TEMPLATES = [
  {
    id: 'saas-landing',
    label: 'SaaS landing',
    label_zh: 'SaaS 落地页',
    blurb: 'Hero, features, pricing, CTA. Tailwind + dark mode out of the box.',
    blurb_zh: 'Hero、功能、价格、行动召唤。Tailwind + 暗色模式开箱即用。',
    icon: '◆',
    accent: 'from-indigo-500 to-fuchsia-500',
  },
  {
    id: 'dashboard',
    label: 'Admin dashboard',
    label_zh: '管理后台',
    blurb: 'Sidebar nav, KPI cards, activity chart, project table.',
    blurb_zh: '侧边栏导航、KPI 卡片、活跃度图表、项目表格。',
    icon: '▦',
    accent: 'from-emerald-500 to-cyan-500',
  },
  {
    id: 'todo-app',
    label: 'Interactive todo',
    label_zh: '互动待办',
    blurb: 'Add, complete, filter, persist. Demonstrates client state + localStorage.',
    blurb_zh: '添加、完成、筛选、持久化。演示客户端状态 + localStorage。',
    icon: '◉',
    accent: 'from-rose-500 to-amber-500',
  },
  {
    id: 'login-form',
    label: 'Sign in / sign up',
    label_zh: '登录 / 注册',
    blurb: 'Email + password and Google OAuth. Auto-wires to Supabase when you connect.',
    blurb_zh: '邮箱 + 密码与 Google OAuth。连接后自动接入 Supabase。',
    icon: '◐',
    accent: 'from-sky-500 to-violet-500',
  },
  {
    id: 'marketplace',
    label: 'Marketplace + cart',
    label_zh: '商城 + 购物车',
    blurb: 'Product grid, filters, cart drawer, Stripe checkout when you add payments.',
    blurb_zh: '商品网格、筛选器、购物车抽屉，添加支付后接入 Stripe 收银台。',
    icon: '◈',
    accent: 'from-amber-500 to-pink-500',
  },
];

export function getTemplate(id) {
  return TEMPLATES.find((t) => t.id === id) || null;
}

// Fetches a template's HTML from /try/templates/<id>/index.html. Throws
// on network failure rather than returning a partial — empty templates
// would just confuse users.
export async function loadTemplateHtml(id, { baseUrl = '/try/templates' } = {}) {
  const tmpl = getTemplate(id);
  if (!tmpl) throw new Error(`Unknown template id: ${id}`);
  const res = await fetch(`${baseUrl}/${tmpl.id}/index.html`);
  if (!res.ok) throw new Error(`Template fetch failed: ${tmpl.id} (${res.status})`);
  return res.text();
}
