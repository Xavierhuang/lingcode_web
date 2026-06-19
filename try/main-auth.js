// main-auth.js — top-nav auth state swap.
//
// The top nav defaults to Sign in / Sign up. When checkEntitlement
// (main.js) confirms a logged-in user, callers invoke setNavAuthState(true)
// to flip to Account / Sign out. Sign out POSTs /api/account/logout (the
// same endpoint used by account.html) then reloads the page so the next
// entitlement check sees a fresh session.
//
// A `lingcode:auth-changed` CustomEvent is dispatched on window so other
// modules — currently preview.js's Save button — react without reaching
// into this module's internals.
//
// NOTE: maybeAutoOpenAdvanced() (formerly adjacent in main.js) stayed in
// main.js for now — it reads providers/workspace module-level state that
// has no export surface yet. Move it here (or into main-providers.js)
// when tier 0b lands.

// Whether the entitlement check confirmed a signed-in session.
// Starts null (unknown) — set to true/false once the check resolves.
let _signedIn = null;

/** True = signed in, false = anonymous/signed-out, null = not yet resolved. */
export const getNavAuthSignedIn = () => _signedIn;

export function setNavAuthState(signedIn) {
  _signedIn = signedIn;
  const signin  = document.getElementById('nav-signin');
  const signup  = document.getElementById('nav-signup');
  const account = document.getElementById('nav-account');
  const signout = document.getElementById('nav-signout');
  if (!signin || !signout) return;
  signin.hidden  = signedIn;
  signout.hidden = !signedIn;
  if (signup)  signup.hidden  = signedIn;
  if (account) account.hidden = !signedIn;
  const toolbar = document.getElementById('workspace-toolbar');
  if (toolbar) {
    const veToggle = document.getElementById('visual-edits-toggle');
    if (veToggle) {
      // ✏ Visual edits is a pure client-side feature (local preview element
      // picker) — keep it usable signed-out. Gate every other toolbar control
      // (provider modes, checkpoints, Tools, close) on sign-in.
      toolbar.hidden = false;
      toolbar.querySelectorAll(':scope > *').forEach((el) => {
        if (el !== veToggle) el.hidden = !signedIn;
      });
    } else {
      toolbar.hidden = !signedIn; // pages without the toggle keep old behavior
    }
  }
  if (signedIn && !signout.dataset.bound) {
    signout.dataset.bound = '1';
    signout.addEventListener('click', async (e) => {
      e.preventDefault();
      try { await fetch('/api/account/logout', { method: 'POST', credentials: 'same-origin' }); }
      catch { /* ignore — reloading anyway forces a fresh entitlement check */ }
      location.reload();
    });
  }
  try {
    window.dispatchEvent(new CustomEvent('lingcode:auth-changed', {
      detail: { signedIn },
    }));
  } catch { /* CustomEvent constructor missing in ancient browsers — non-fatal */ }
}
