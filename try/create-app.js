export async function initCreateAppButton() {
  const { getCurrentUser, getSession } = await import('./monetization.js?v=' + Date.now());

  const header = document.querySelector('.try-header');
  if (!header) return;

  // Check if user is logged in
  const session = await getSession();

  const createBtn = document.createElement('button');
  createBtn.className = 'try-create-app-btn';
  createBtn.title = 'Generate a full-stack app using Claude AI';

  if (!session) {
    createBtn.innerHTML = '🔓 Sign In to Create Apps';
    createBtn.addEventListener('click', () => {
      openAuthModal();
    });
  } else {
    createBtn.innerHTML = '✨ Create Full App';
    createBtn.addEventListener('click', openCreateAppDialog);
  }

  header.appendChild(createBtn);

  // Add auth status indicator
  if (session) {
    const user = await getCurrentUser();
    const statusDiv = document.createElement('div');
    statusDiv.className = 'auth-status';
    statusDiv.innerHTML = `${user.email} <button class="sign-out-btn">Sign Out</button>`;
    statusDiv.querySelector('.sign-out-btn').addEventListener('click', async () => {
      const { signOut } = await import('./monetization.js?v=' + Date.now());
      await signOut();
    });
    header.appendChild(statusDiv);
  }
}

async function showUpgradeOptions(upgrade, userId) {
  const { initiateStripeCheckout } = await import('./monetization.js?v=' + Date.now());

  const modal = document.createElement('div');
  modal.className = 'create-app-modal-overlay';
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });

  const dialog = document.createElement('div');
  dialog.className = 'create-app-modal upgrade-modal';

  let optionsHtml = '<div class="upgrade-options">';
  upgrade.options.forEach((option) => {
    optionsHtml += `
      <button class="upgrade-option" data-action="${option.action}" data-price-id="${option.priceId || ''}">
        <div class="upgrade-option-text">${option.text}</div>
      </button>
    `;
  });
  optionsHtml += '</div>';

  dialog.innerHTML = `
    <div class="create-app-header">
      <h2>${upgrade.title}</h2>
      <button class="create-app-close" aria-label="Close">✕</button>
    </div>
    <div class="create-app-body">
      <p class="upgrade-message">${upgrade.message}</p>
      ${optionsHtml}
    </div>
  `;

  modal.appendChild(dialog);
  document.body.appendChild(modal);

  const closeBtn = dialog.querySelector('.create-app-close');
  const optionBtns = dialog.querySelectorAll('.upgrade-option');

  closeBtn.addEventListener('click', () => modal.remove());

  optionBtns.forEach((btn) => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.action;
      const priceId = btn.dataset.priceId;

      if (action === 'lingmodel-pro') {
        window.open('https://lingcode.dev/pricing', '_blank');
        modal.remove();
      } else if (priceId) {
        modal.remove();
        await initiateStripeCheckout(userId, priceId);
      }
    });
  });
}

async function openAuthModal() {
  const { signUpWithEmail, signInWithEmail } = await import('./monetization.js?v=' + Date.now());

  const modal = document.createElement('div');
  modal.className = 'create-app-modal-overlay';
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });

  const dialog = document.createElement('div');
  dialog.className = 'create-app-modal auth-modal';

  dialog.innerHTML = `
    <div class="create-app-header">
      <h2>Sign In to Create Apps</h2>
      <button class="create-app-close" aria-label="Close">✕</button>
    </div>
    <div class="create-app-body">
      <div class="auth-tabs">
        <button class="auth-tab active" data-tab="signin">Sign In</button>
        <button class="auth-tab" data-tab="signup">Sign Up</button>
      </div>

      <div id="signin-tab" class="auth-tab-content active">
        <div class="form-group">
          <label>Email</label>
          <input type="email" class="signin-email" placeholder="you@example.com" />
        </div>
        <div class="form-group">
          <label>Password</label>
          <input type="password" class="signin-password" placeholder="••••••••" />
        </div>
        <button class="btn-primary signin-btn">Sign In</button>
      </div>

      <div id="signup-tab" class="auth-tab-content">
        <div class="form-group">
          <label>Email</label>
          <input type="email" class="signup-email" placeholder="you@example.com" />
        </div>
        <div class="form-group">
          <label>Password</label>
          <input type="password" class="signup-password" placeholder="••••••••" />
        </div>
        <div class="form-hint">At least 8 characters recommended</div>
        <button class="btn-primary signup-btn">Create Account</button>
      </div>
    </div>
  `;

  modal.appendChild(dialog);
  document.body.appendChild(modal);

  const closeBtn = dialog.querySelector('.create-app-close');
  const tabs = dialog.querySelectorAll('.auth-tab');
  const signinEmail = dialog.querySelector('.signin-email');
  const signinPassword = dialog.querySelector('.signin-password');
  const signinBtn = dialog.querySelector('.signin-btn');
  const signupEmail = dialog.querySelector('.signup-email');
  const signupPassword = dialog.querySelector('.signup-password');
  const signupBtn = dialog.querySelector('.signup-btn');

  closeBtn.addEventListener('click', () => modal.remove());

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      dialog.querySelectorAll('.auth-tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(tab.dataset.tab + '-tab').classList.add('active');
    });
  });

  signinBtn.addEventListener('click', async () => {
    try {
      signinBtn.disabled = true;
      signinBtn.textContent = 'Signing in...';
      await signInWithEmail(signinEmail.value, signinPassword.value);
      modal.remove();
      window.location.reload();
    } catch (error) {
      alert(`Sign in failed: ${error.message}`);
      signinBtn.disabled = false;
      signinBtn.textContent = 'Sign In';
    }
  });

  signupBtn.addEventListener('click', async () => {
    try {
      signupBtn.disabled = true;
      signupBtn.textContent = 'Creating account...';
      await signUpWithEmail(signupEmail.value, signupPassword.value);
      alert('Account created! Check your email to verify, then sign in.');
      modal.remove();
    } catch (error) {
      alert(`Sign up failed: ${error.message}`);
      signupBtn.disabled = false;
      signupBtn.textContent = 'Create Account';
    }
  });
}

function openCreateAppDialog() {
  const modal = document.createElement('div');
  modal.className = 'create-app-modal-overlay';
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });

  const dialog = document.createElement('div');
  dialog.className = 'create-app-modal';

  dialog.innerHTML = `
    <div class="create-app-header">
      <h2>Create Full App with Claude AI</h2>
      <button class="create-app-close" aria-label="Close">✕</button>
    </div>
    <div class="create-app-body">
      <div class="create-app-form">
        <div class="form-group">
          <label>App Name</label>
          <input type="text" class="app-name-input" placeholder="My Awesome App" />
        </div>
        <div class="form-group">
          <label>What would you like to build?</label>
          <textarea class="app-description-input" placeholder="A task management system for distributed teams..."></textarea>
          <div class="form-hint">Describe what you want. Be specific about features.</div>
        </div>
        <div class="form-group">
          <label>Template (optional)</label>
          <div class="template-grid">
            <button class="template-option" data-template="task-manager" title="Task Manager SaaS">
              <div class="template-icon">📋</div>
              <div class="template-name">Task Manager</div>
            </button>
            <button class="template-option" data-template="marketplace" title="Peer-to-peer Marketplace">
              <div class="template-icon">🛒</div>
              <div class="template-name">Marketplace</div>
            </button>
            <button class="template-option" data-template="cms" title="Headless CMS">
              <div class="template-icon">📝</div>
              <div class="template-name">CMS</div>
            </button>
            <button class="template-option" data-template="dashboard" title="Analytics Dashboard">
              <div class="template-icon">📊</div>
              <div class="template-name">Dashboard</div>
            </button>
            <button class="template-option" data-template="ecommerce" title="E-commerce Store">
              <div class="template-icon">🏪</div>
              <div class="template-name">E-commerce</div>
            </button>
            <button class="template-option" data-template="chat" title="Real-time Chat">
              <div class="template-icon">💬</div>
              <div class="template-name">Chat</div>
            </button>
          </div>
        </div>
        <div class="form-group">
          <label>Use voice input</label>
          <button class="voice-input-btn" aria-label="Activate voice input">🎤 Describe with voice</button>
        </div>
      </div>
    </div>
    <div class="create-app-footer">
      <button class="btn-secondary" aria-label="Cancel">Cancel</button>
      <button class="btn-primary" aria-label="Generate app">Generate App</button>
    </div>
  `;

  modal.appendChild(dialog);
  document.body.appendChild(modal);

  let selectedTemplate = null;
  const appNameInput = dialog.querySelector('.app-name-input');
  const descriptionInput = dialog.querySelector('.app-description-input');
  const closeBtn = dialog.querySelector('.create-app-close');
  const cancelBtn = dialog.querySelector('.btn-secondary');
  const generateBtn = dialog.querySelector('.btn-primary');
  const voiceBtn = dialog.querySelector('.voice-input-btn');
  const templateOptions = dialog.querySelectorAll('.template-option');

  appNameInput.focus();

  templateOptions.forEach((btn) => {
    btn.addEventListener('click', () => {
      templateOptions.forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      selectedTemplate = btn.dataset.template;
    });
  });

  closeBtn.addEventListener('click', () => modal.remove());
  cancelBtn.addEventListener('click', () => modal.remove());

  voiceBtn.addEventListener('click', () => {
    if (!('webkitSpeechRecognition' in window)) {
      alert('Speech Recognition not supported in this browser');
      return;
    }

    voiceBtn.disabled = true;
    voiceBtn.textContent = '🎤 Listening...';

    const recognition = new webkitSpeechRecognition();
    recognition.lang = localStorage.getItem('lingcode.try.voiceLang') || 'en-US';
    recognition.continuous = false;
    recognition.interimResults = false;

    recognition.onresult = (event) => {
      const transcript = Array.from(event.results)
        .map((result) => result[0].transcript)
        .join('');
      descriptionInput.value = transcript.trim();
      voiceBtn.disabled = false;
      voiceBtn.textContent = '🎤 Describe with voice';
    };

    recognition.onerror = () => {
      voiceBtn.disabled = false;
      voiceBtn.textContent = '🎤 Describe with voice';
    };

    recognition.start();
  });

  generateBtn.addEventListener('click', async () => {
    const { getCurrentUser, canGenerateApp, recordAppGeneration, getUpgradePrompt } = await import('./monetization.js?v=' + Date.now());

    const appName = appNameInput.value.trim();
    const description = descriptionInput.value.trim();

    // Validate inputs
    if (!appName) {
      alert('Please enter an app name');
      appNameInput.focus();
      return;
    }
    if (!description) {
      alert('Please describe what you want to build');
      descriptionInput.focus();
      return;
    }

    // Check tier limit
    const user = await getCurrentUser();
    const canGenerate = await canGenerateApp(user.id);
    if (!canGenerate) {
      const upgrade = getUpgradePrompt('free');
      showUpgradeOptions(upgrade, user.id);
      return;
    }

    generateBtn.disabled = true;
    generateBtn.textContent = 'Generating...';

    try {
      // Call LingModel inference endpoint directly
      const inferenceResponse = await fetch(
        'https://lingcode.dev/api/inference/anthropic/v1/messages',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          credentials: 'include',
          body: JSON.stringify({
            model: 'claude-3-5-sonnet-20241022',
            max_tokens: 4000,
            messages: [
              {
                role: 'user',
                content: `You are a full-stack code generator. Generate a complete ${selectedTemplate || 'dashboard'} app.

App Name: ${appName}
Description: ${description}

Return ONLY valid JSON with this structure:
{
  "frontend": "...html/react code...",
  "backend": "...node/express code...",
  "database": "...sql schema...",
  "config": {
    "name": "${appName}",
    "port": 3000,
    "env": {}
  }
}`,
              },
            ],
          }),
        }
      );

      if (!inferenceResponse.ok) {
        throw new Error(`API error: ${inferenceResponse.statusText}`);
      }

      const inferenceResult = await inferenceResponse.json();

      // Extract the generated code from Claude's response
      const responseText = inferenceResult.content[0].text;
      let code;
      try {
        code = JSON.parse(responseText);
      } catch {
        throw new Error('Failed to parse generated code');
      }

      // Record the generation
      const { recordAppGeneration, sendEmail, getUserTier } = await import('./monetization.js?v=' + Date.now());
      await recordAppGeneration(user.id, appName, '', null);

      // Send app generation email
      const tier = await getUserTier(user.id);
      await sendEmail(user.email, 'app_generated', {
        appName,
        liveUrl: '',
        githubUrl: '',
        appsRemaining: Math.max(0, tier.appsPerMonth - 1),
      });

      showGeneratedAppResult({ appName, code }, modal);
    } catch (error) {
      alert(`Error: ${error.message}`);
      generateBtn.disabled = false;
      generateBtn.textContent = 'Generate App';
    }
  });
}

function showGeneratedAppResult(result, previousModal) {
  previousModal.remove();

  const resultModal = document.createElement('div');
  resultModal.className = 'create-app-modal-overlay';
  resultModal.addEventListener('click', (e) => {
    if (e.target === resultModal) resultModal.remove();
  });

  const dialog = document.createElement('div');
  dialog.className = 'create-app-modal create-app-result';

  dialog.innerHTML = `
    <div class="create-app-header">
      <h2>✨ App Generated Successfully!</h2>
      <button class="create-app-close" aria-label="Close">✕</button>
    </div>
    <div class="create-app-body">
      <div class="result-content">
        <p class="result-app-name">${escapeHtml(result.appName)}</p>
        <p class="result-status">✨ Your app code has been generated!</p>

        <div class="result-details">
          <div class="detail-item">
            <div class="detail-label">Frontend</div>
            <div class="detail-value"><pre>${escapeHtml(result.code.frontend).slice(0, 200)}...</pre></div>
          </div>
          <div class="detail-item">
            <div class="detail-label">Backend</div>
            <div class="detail-value"><pre>${escapeHtml(result.code.backend).slice(0, 200)}...</pre></div>
          </div>
          <div class="detail-item">
            <div class="detail-label">Database Schema</div>
            <div class="detail-value"><pre>${escapeHtml(result.code.database).slice(0, 200)}...</pre></div>
          </div>
        </div>

        <div class="result-next-steps">
          <h3>Next Steps</h3>
          <ol>
            <li>Copy the generated code above</li>
            <li>Create a GitHub repo and push the code</li>
            <li>Deploy to your hosting service (Render, Vercel, Railway, etc.)</li>
            <li>Configure your database and environment variables</li>
          </ol>
        </div>
      </div>
    </div>
    <div class="create-app-footer">
      <button class="btn-secondary" aria-label="Close">Close</button>
      <button class="btn-primary" aria-label="Create another app">Create Another App</button>
    </div>
  `;

  resultModal.appendChild(dialog);
  document.body.appendChild(resultModal);

  const closeBtn = dialog.querySelector('.create-app-close');
  const cancelBtn = dialog.querySelector('.btn-secondary');
  const newAppBtn = dialog.querySelector('.btn-primary');

  closeBtn.addEventListener('click', () => resultModal.remove());
  cancelBtn.addEventListener('click', () => resultModal.remove());
  newAppBtn.addEventListener('click', () => {
    resultModal.remove();
    openCreateAppDialog();
  });
}

function escapeHtml(unsafe) {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
