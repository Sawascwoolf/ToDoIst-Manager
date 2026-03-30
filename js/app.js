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
        const r = await fetch(`${API_BASE}/projects`, { headers: { 'Authorization': `Bearer ${S.token}` } });
        if (!r.ok) {
            const body = await r.text().catch(() => '');
            const msg = r.status === 401 || r.status === 403
                ? `Token ungültig (HTTP ${r.status}).`
                : r.status === 410
                ? `API v1 nicht erreichbar (HTTP 410). API-Version hat sich möglicherweise geändert.`
                : `API-Fehler HTTP ${r.status}: ${body.substring(0, 150)}`;
            err.textContent = msg; err.classList.remove('hidden');
            mainErr.textContent = msg; mainErr.classList.remove('hidden');
            return;
        }
        const data = await r.json();
        const projects = data.results || data;
        const sel = document.getElementById('project-select');
        sel.innerHTML = '<option value="">Projekt wählen...</option>';
        projects.forEach(p => { const o = document.createElement('option'); o.value = p.id; o.textContent = p.name; sel.appendChild(o); });
        sel.disabled = false;
        localStorage.setItem('todoist_token', S.token);
        // Restore last project
        const lastPid = localStorage.getItem('todoist_last_project');
        if (lastPid) {
            const match = [...sel.options].find(o => String(o.value) === String(lastPid));
            if (match) {
                sel.value = match.value;
                loadTasks();
            }
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
        const [open, completed, secList, collabList] = await Promise.all([
            apiPaginated(`/tasks?projectId=${pid}`),
            fetchAllCompleted(pid),
            apiPaginated(`/sections?projectId=${pid}`),
            apiPaginated(`/projects/${pid}/collaborators`).catch(() => []),
        ]);
        open.forEach(t => { t._status = 'open'; });

        const secs = {}; secList.forEach(s => { secs[s.id] = s.name; }); S.sections = secs;
        const cols = {}; collabList.forEach(c => { cols[c.id] = c.name || c.email || c.id; });
        [...open, ...completed].forEach(t => {
            const uid = t.responsible_uid || t.responsibleUid || t.assignee_id || t.assigneeId;
            if (uid && !cols[uid]) cols[uid] = uid;
        });
        S.collaborators = cols;

        taskCache[pid] = { open, completed, sections: secs, collaborators: cols, ts: Date.now() };
        S.allTasks = deduplicateTasks(open, completed);
        showUI();
        showToast(`${open.length} offen + ${completed.length} erledigt.`, 'success');
    } catch (e) {
        console.error('loadTasks error:', e);
        showToast('Fehler: ' + e.message, 'error');
    } finally {
        document.getElementById('loading').classList.add('hidden');
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

// ── Init ──
document.getElementById('token-input').addEventListener('keydown', e => { if (e.key === 'Enter') connect(); });
document.getElementById('view-name-input').addEventListener('keydown', e => { if (e.key === 'Enter') confirmSaveView(); });
bindToggleButtons();
renderViewSlots();
updateGroupToggleUI();
updateHierarchyToggleUI();

(function () {
    const t = localStorage.getItem('todoist_token');
    if (t) { document.getElementById('token-input').value = t; connect(); }
})();
