// nav-auth.js — shared nav Sign in → Sign out swap for all static pages.
// Hits /api/entitlement (same endpoint as /try) to detect a live session.
// On 200: hides nav-signin + nav-signup, reveals nav-account + nav-signout.
// On anything else (401, network error): leaves nav as-is (Sign in visible).
(function () {
  function swap(signedIn) {
    var signin  = document.getElementById('nav-signin');
    var signup  = document.getElementById('nav-signup');
    var account = document.getElementById('nav-account');
    var signout = document.getElementById('nav-signout');
    if (!signin || !signout) return;
    signin.hidden  = signedIn;
    if (signup)  signup.hidden  = signedIn;
    if (account) account.hidden = !signedIn;
    signout.hidden = !signedIn;
    if (signedIn && !signout.dataset.bound) {
      signout.dataset.bound = '1';
      signout.addEventListener('click', function (e) {
        e.preventDefault();
        fetch('/api/account/logout', { method: 'POST', credentials: 'same-origin' })
          .then(function () { location.reload(); })
          .catch(function () { location.reload(); });
      });
    }
  }

  fetch('/api/entitlement', { credentials: 'include' })
    .then(function (r) { if (r.ok) swap(true); })
    .catch(function () {});
})();
