// ── Toast with Undo ──
function showToast(msg, type, undoCallback) {
    const t = document.getElementById('toast');
    if (!t) return;
    const msgEl = document.getElementById('toast-msg');
    const undoBtn = document.getElementById('toast-undo');
    if (!msgEl) { t.textContent = msg; } else { msgEl.textContent = msg; }
    t.className = 'toast' + (type ? ' toast-' + type : '');
    t.classList.remove('hidden');
    S.undoFn = undoCallback || null;
    if (undoBtn) {
        if (undoCallback) { undoBtn.classList.remove('hidden'); } else { undoBtn.classList.add('hidden'); }
    }
    clearTimeout(t._t);
    t._t = setTimeout(() => { t.classList.add('hidden'); S.undoFn = null; }, undoCallback ? 8000 : 4000);
}

async function executeUndo() {
    if (!S.undoFn) return;
    const fn = S.undoFn;
    S.undoFn = null;
    document.getElementById('toast').classList.add('hidden');
    try { await fn(); } catch (e) { showToast('Rückgängig fehlgeschlagen: ' + e.message, 'error'); }
}
