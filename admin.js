const SUPABASE_URL = 'https://roirvcdajfhpcdqkywnk.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_bLZYW_xI8bkswKxZJPGMig_CqTksaUI';

let supabaseClient = null;

async function getSupabase() {
  if (!supabaseClient) {
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2.38.0');
    supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
  return supabaseClient;
}

export async function initAdmin() {
  await loadUsers();

  // Add event listeners
  document.getElementById('search-box').addEventListener('input', loadUsers);
  document.getElementById('tier-filter').addEventListener('change', loadUsers);
}

async function loadUsers() {
  const container = document.getElementById('users-container');
  container.innerHTML = '<div class="loading">Loading users...</div>';

  try {
    const supabase = await getSupabase();

    // Get search and filter values
    const search = document.getElementById('search-box').value.toLowerCase();
    const tierFilter = document.getElementById('tier-filter').value;

    // Fetch users
    let query = supabase.from('users').select('id, email, subscription_tier, lingmodel_pro_status, apps_generated_this_month, created_at');

    const { data: users, error } = await query;

    if (error) throw error;

    // Filter locally
    let filtered = users || [];
    if (search) {
      filtered = filtered.filter(u => u.email?.toLowerCase().includes(search));
    }
    if (tierFilter) {
      filtered = filtered.filter(u => {
        if (tierFilter === 'pro' && u.lingmodel_pro_status === 'active') return true;
        if (tierFilter !== 'pro' && u.subscription_tier === tierFilter) return true;
        return false;
      });
    }

    // Get app counts
    const { data: appCounts, error: appError } = await supabase
      .from('generated_apps')
      .select('user_id');

    const appsByUser = {};
    (appCounts || []).forEach(app => {
      appsByUser[app.user_id] = (appsByUser[app.user_id] || 0) + 1;
    });

    // Update stats
    updateStats(users, appsByUser);

    // Render table
    renderUsersTable(filtered, appsByUser);
  } catch (error) {
    showMessage(`Error: ${error.message}`, 'error');
  }
}

function updateStats(users, appsByUser) {
  const total = users.length;
  const free = users.filter(u => u.subscription_tier === 'free').length;
  const pro = users.filter(u => u.subscription_tier === 'pro' || u.lingmodel_pro_status === 'active').length;
  const maxPro = users.filter(u => u.subscription_tier === 'max_pro').length;
  const totalApps = Object.values(appsByUser).reduce((a, b) => a + b, 0);

  document.getElementById('total-users').textContent = total;
  document.getElementById('free-users').textContent = free;
  document.getElementById('pro-users').textContent = pro;
  document.getElementById('max-users').textContent = maxPro;
  document.getElementById('total-apps').textContent = totalApps;
}

function renderUsersTable(users, appsByUser) {
  const container = document.getElementById('users-container');

  if (users.length === 0) {
    container.innerHTML = '<div class="loading">No users found</div>';
    return;
  }

  let html = `
    <table class="users-table">
      <thead>
        <tr>
          <th>Email</th>
          <th>Tier</th>
          <th>LingModel Pro</th>
          <th>Apps Generated</th>
          <th>Joined</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
  `;

  users.forEach(user => {
    const tier = user.lingmodel_pro_status === 'active' ? 'pro' : user.subscription_tier;
    const tierBadgeClass = {
      'free': 'tier-free',
      'pro': 'tier-pro',
      'max_pro': 'tier-max',
    }[tier] || 'tier-free';

    const tierLabel = {
      'free': 'Free',
      'pro': 'Pro',
      'max_pro': 'Max Pro',
    }[tier] || 'Free';

    const joined = new Date(user.created_at).toLocaleDateString();
    const appCount = appsByUser[user.id] || 0;

    html += `
      <tr>
        <td>${user.email}</td>
        <td>
          <select class="tier-dropdown" onchange="changeTier('${user.id}', this.value)">
            <option value="free" ${tier === 'free' ? 'selected' : ''}>Free</option>
            <option value="pro" ${tier === 'pro' ? 'selected' : ''}>Pro</option>
            <option value="max_pro" ${tier === 'max_pro' ? 'selected' : ''}>Max Pro</option>
          </select>
        </td>
        <td>${user.lingmodel_pro_status === 'active' ? '✓ Active' : '—'}</td>
        <td>${appCount}</td>
        <td>${joined}</td>
        <td>
          <button class="action-btn" onclick="toggleLingModelPro('${user.id}', ${user.lingmodel_pro_status === 'active'})">
            ${user.lingmodel_pro_status === 'active' ? 'Disable LM' : 'Enable LM'}
          </button>
          <button class="action-btn" onclick="resetUsage('${user.id}')">Reset Usage</button>
        </td>
      </tr>
    `;
  });

  html += `
      </tbody>
    </table>
  `;

  container.innerHTML = html;
}

async function changeTier(userId, newTier) {
  try {
    const supabase = await getSupabase();
    const { error } = await supabase
      .from('users')
      .update({ subscription_tier: newTier })
      .eq('id', userId);

    if (error) throw error;
    showMessage(`Tier updated to ${newTier}`, 'success');
    await loadUsers();
  } catch (error) {
    showMessage(`Error: ${error.message}`, 'error');
  }
}

async function toggleLingModelPro(userId, isActive) {
  try {
    const supabase = await getSupabase();
    const { error } = await supabase
      .from('users')
      .update({ lingmodel_pro_status: isActive ? null : 'active' })
      .eq('id', userId);

    if (error) throw error;
    showMessage(`LingModel Pro ${isActive ? 'disabled' : 'enabled'}`, 'success');
    await loadUsers();
  } catch (error) {
    showMessage(`Error: ${error.message}`, 'error');
  }
}

async function resetUsage(userId) {
  if (!confirm('Reset this user\'s monthly usage counter?')) return;

  try {
    const supabase = await getSupabase();
    const today = new Date().toISOString().split('T')[0];

    const { error } = await supabase
      .from('users')
      .update({
        apps_generated_this_month: 0,
        month_reset_date: today,
      })
      .eq('id', userId);

    if (error) throw error;
    showMessage('Usage reset', 'success');
    await loadUsers();
  } catch (error) {
    showMessage(`Error: ${error.message}`, 'error');
  }
}

function showMessage(msg, type) {
  const container = document.getElementById('message');
  const className = type === 'success' ? 'success' : 'error';
  container.innerHTML = `<div class="${className}">${msg}</div>`;
  setTimeout(() => {
    container.innerHTML = '';
  }, 4000);
}

// Export for HTML inline handlers
window.changeTier = changeTier;
window.toggleLingModelPro = toggleLingModelPro;
window.resetUsage = resetUsage;
