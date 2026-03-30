// ── Progress ──
async function showProgress(cur, total, label) {
    const bar = document.getElementById('progress-bar');
    if (!bar) return;
    bar.classList.remove('hidden');
    const fill = bar.querySelector('.progress-fill');
    const txt = bar.querySelector('.progress-text');
    if (fill) fill.style.width = Math.round(cur / total * 100) + '%';
    if (txt) txt.textContent = `${label}: ${cur}/${total}`;
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
}
function hideProgress() { document.getElementById('progress-bar').classList.add('hidden'); }

// ── Sidebar ──
function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('open');
    document.getElementById('sidebar-overlay').classList.toggle('hidden');
}

// ── Connect ──
async function connect() {
    S.token = document.getElementById('token-input').value.trim();
    const err = document.getElementById('auth-error');
    err.classList.add('hidden');
    if (!S.token) { err.textContent = 'Bitte Token eingeben.'; err.classList.remove('hidden'); return; }

    const mainErr = document.getElementById('main-error');
    mainErr.classList.add('hidden');

    try {
        // Use Sync API to load projects (1 call instead of paginated REST)
        const data = await syncRead(['projects'], true);
        const projects = data.projects || [];
        if (!projects.length) throw new Error('Keine Projekte gefunden.');

        const sel = document.getElementById('project-select');
        sel.innerHTML = '<option value="">Projekt wählen...</option>';
        projects.filter(p => !p.is_deleted && !p.is_archived).forEach(p => {
            const o = document.createElement('option');
            o.value = p.id; o.textContent = p.name; sel.appendChild(o);
        });
        sel.disabled = false;
        localStorage.setItem('todoist_token', S.token);

        const lastPid = localStorage.getItem('todoist_last_project');
        if (lastPid) {
            const match = [...sel.options].find(o => String(o.value) === String(lastPid));
            if (match) { sel.value = match.value; loadTasks(); }
        }
        showToast(`${projects.length} Projekte geladen.`, 'success');
        if (document.getElementById('sidebar').classList.contains('open')) toggleSidebar();
    } catch (e) {
        const detail = e.message || String(e);
        const msg = e instanceof TypeError
            ? `Netzwerkfehler: ${detail}. Prüfe Internetverbindung, Adblocker oder ob api.todoist.com erreichbar ist.`
            : `Fehler: ${detail}`;
        err.textContent = msg; err.classList.remove('hidden');
        mainErr.textContent = msg; mainErr.classList.remove('hidden');
        console.error('Connect error:', e);
    }
}

// ── Load Tasks ──
async function loadTasks(force) {
    const pid = document.getElementById('project-select').value;
    if (!pid) return;
    S.currentProjectId = pid;
    localStorage.setItem('todoist_last_project', String(pid));

    if (!force) {
        const c = getCached(pid);
        if (c) {
            S.sections = c.sections; S.collaborators = c.collaborators;
            S.allTasks = deduplicateTasks(c.open, c.completed);
            showUI(); showToast(`${S.allTasks.length} Aufgaben (Cache).`, 'success'); return;
        }
    }

    document.getElementById('filter-section').classList.remove('hidden');
    document.getElementById('task-section').classList.remove('hidden');
    document.getElementById('loading').classList.remove('hidden');
    document.getElementById('task-body').innerHTML = '';

    try {
        // Sync API: 1 call for open tasks + sections + collaborators
        const syncData = await syncRead(['items', 'sections', 'collaborators'], true);
        const allItems = syncData.items || [];
        const open = allItems.filter(t => !t.is_completed && !t.is_deleted && String(t.project_id) === String(pid));
        open.forEach(t => { t._status = 'open'; });

        // Completed tasks via REST (Sync API doesn't include them)
        const completed = await fetchAllCompleted(pid);

        const secList = (syncData.sections || []).filter(s => String(s.project_id) === String(pid) && !s.is_deleted);
        const collabList = syncData.collaborators || [];

        const secs = {}; secList.forEach(s => { secs[s.id] = s.name; }); S.sections = secs;
        const cols = {}; collabList.forEach(c => { cols[c.id] = c.full_name || c.name || c.email || c.id; });
        [...open, ...completed].forEach(t => {
            const uid = t.responsible_uid;
            if (uid && !cols[uid]) cols[uid] = uid;
        });
        S.collaborators = cols;

        taskCache[pid] = { open, completed, sections: secs, collaborators: cols, ts: Date.now() };
        S.allTasks = deduplicateTasks(open, completed);
        showUI();
        startAutoRefresh();
        showToast(`${open.length} offen + ${completed.length} erledigt.`, 'success');
    } catch (e) {
        console.error('loadTasks error:', e);
        showToast('Fehler: ' + e.message, 'error');
    } finally {
        document.getElementById('loading').classList.add('hidden');
    }
}

// ── Delta Refresh (incremental sync) ──
async function deltaRefresh() {
    if (!S.currentProjectId || !S.syncToken) return;
    try {
        const data = await syncRead(['items', 'sections', 'collaborators'], false);
        if (data.full_sync) {
            // Server forced full sync, do a full reload
            invalidateCache(S.currentProjectId);
            await loadTasks(true);
            return;
        }
        const changedItems = data.items || [];
        const pid = S.currentProjectId;
        if (changedItems.length === 0 && !(data.sections || []).length) return; // nothing changed

        // Apply changes to local state
        changedItems.forEach(item => {
            if (String(item.project_id) !== String(pid)) return;
            const idx = S.allTasks.findIndex(t => t.id === item.id);
            if (item.is_deleted) {
                if (idx >= 0) S.allTasks.splice(idx, 1);
            } else if (idx >= 0) {
                Object.assign(S.allTasks[idx], item);
                S.allTasks[idx]._status = item.is_completed ? 'completed' : 'open';
            } else if (!item.is_completed) {
                item._status = 'open';
                S.allTasks.push(item);
            }
        });

        // Update sections
        if (data.sections) {
            data.sections.filter(s => String(s.project_id) === String(pid)).forEach(s => {
                if (s.is_deleted) delete S.sections[s.id];
                else S.sections[s.id] = s.name;
            });
        }

        invalidateCache(pid);
        applyFilters();
    } catch (e) {
        console.error('Delta refresh error:', e);
    }
}

function showUI() {
    try {
        populateAssigneeToggles();
        populateLabelFilter();
        document.getElementById('filter-section').classList.remove('hidden');
        document.getElementById('task-section').classList.remove('hidden');
        applyFilters();
    } catch (e) {
        console.error('showUI error:', e);
        throw e;
    }
}

// ── Auto-Refresh (delta sync) ──
const AUTO_REFRESH_INTERVAL = 60 * 1000;
let autoRefreshTimer = null;

function startAutoRefresh() {
    stopAutoRefresh();
    autoRefreshTimer = setInterval(() => {
        if (!S.currentProjectId) return;
        if (document.hidden) return;
        deltaRefresh();
    }, AUTO_REFRESH_INTERVAL);
}

function stopAutoRefresh() {
    if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
}

document.addEventListener('visibilitychange', () => {
    if (!document.hidden && S.currentProjectId) deltaRefresh();
});

// ── Init ──
document.getElementById('token-input').addEventListener('keydown', e => { if (e.key === 'Enter') connect(); });
document.getElementById('view-name-input').addEventListener('keydown', e => { if (e.key === 'Enter') confirmSaveView(); });
document.getElementById('new-task-content').addEventListener('keydown', e => { if (e.key === 'Enter') confirmCreateTask(); });
bindToggleButtons();
renderViewSlots();
updateGroupToggleUI();
updateHierarchyToggleUI();

(function () {
    const t = localStorage.getItem('todoist_token');
    if (t) { document.getElementById('token-input').value = t; connect(); }
})();
