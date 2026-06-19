// website/try/main-resume.js
// Resume-unfinished-project detection for /try landing page.
// Queries IndexedDB for recent checkpoints from any session and shows
// an inline banner above the prompt when one is found.
//
// CSS for .resume-banner lives in try.html <style>.
// Exported surface:
//   findUnfinishedSession() → Promise<checkpoint | null>
//   showResumeBanner(ckpt, container) → Promise<'resume' | 'new'>

import { openCheckpointsDB } from './checkpoints.js?v=20260602d';

const RESUME_CUTOFF_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ─── Detection ────────────────────────────────────────────────────────────────

/**
 * Return the most recent checkpoint that looks like an unfinished build:
 * - kind === 'auto' or 'manual' (not pending_publish)
 * - created within the last 7 days
 * - has at least one pane with at least one turn
 *
 * Returns null if nothing qualifies or if IndexedDB is unavailable.
 */
export async function findUnfinishedSession() {
  try {
    const db = await openCheckpointsDB();
    const all = await _getAllCheckpoints(db);

    const cutoff = Date.now() - RESUME_CUTOFF_MS;
    const candidates = all.filter(c =>
      (c.kind === 'auto' || c.kind === 'manual') &&
      c.timestamp > cutoff &&
      c.panes?.some(p => p.turns?.length > 0),
    );

    // Sorted newest-first by _getAllCheckpoints; return the most recent.
    return candidates[0] ?? null;
  } catch {
    return null;
  }
}

/** Read all records from the checkpoints store sorted by timestamp desc. */
function _getAllCheckpoints(db) {
  return new Promise((resolve, reject) => {
    const tx   = db.transaction(['checkpoints'], 'readonly');
    const idx  = tx.objectStore('checkpoints').index('by_ts');
    const req  = idx.getAll(); // all entries, unsorted by IndexedDB

    req.onerror   = () => reject(req.error);
    req.onsuccess = () => {
      const rows = req.result || [];
      rows.sort((a, b) => b.timestamp - a.timestamp); // newest first
      resolve(rows);
    };
    tx.onerror = () => reject(tx.error);
  });
}

// ─── Banner UI ────────────────────────────────────────────────────────────────

/**
 * Inject the resume banner above `container` and wait for the user's choice.
 * Resolves to 'resume' if the user clicks "Open that", 'new' if "Start new".
 *
 * @param {object} ckpt — checkpoint entry from findUnfinishedSession()
 * @param {HTMLElement} container — element to prepend the banner to
 * @returns {Promise<'resume'|'new'>}
 */
export function showResumeBanner(ckpt, container) {
  return new Promise(resolve => {
    const name = _ckptName(ckpt);
    const when = _formatAge(ckpt.timestamp);

    const banner = document.createElement('div');
    banner.className = 'resume-banner';
    banner.innerHTML =
      '<div class="resume-banner-inner">' +
        '<span class="resume-icon">⟳</span>' +
        `<span class="resume-text">You have an unfinished project — ` +
          `<strong>${_escHtml(name)}</strong> (${_escHtml(when)})</span>` +
        '<div class="resume-actions">' +
          '<button class="resume-open-btn" type="button">Open that</button>' +
          '<button class="resume-new-btn"  type="button">Start new</button>' +
        '</div>' +
      '</div>';

    container.prepend(banner);

    function done(choice) {
      banner.querySelectorAll('button').forEach(b => { b.disabled = true; });
      banner.remove();
      resolve(choice);
    }

    banner.querySelector('.resume-open-btn').addEventListener('click', () => done('resume'));
    banner.querySelector('.resume-new-btn') .addEventListener('click', () => done('new'));
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _ckptName(ckpt) {
  if (ckpt.name && ckpt.name.trim()) return ckpt.name.trim();
  // Fall back to the first user turn text (truncated)
  const firstTurn = ckpt.panes?.[0]?.turns?.[0]?.userText;
  if (firstTurn) return firstTurn.slice(0, 48) + (firstTurn.length > 48 ? '…' : '');
  return 'Unfinished project';
}

function _formatAge(ts) {
  const diff = Date.now() - ts;
  const min  = Math.floor(diff / 60000);
  if (min < 1)   return 'just now';
  if (min < 60)  return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr  < 24)  return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function _escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
