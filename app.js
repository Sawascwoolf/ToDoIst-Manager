const API_BASE = 'https://api.todoist.com/api/v1';

let token = '';
let allTasks = [];
let filteredTasks = [];
let sections = {};
let collaborators = {};
let selectedIds = new Set();
let sortField = 'content';
let sortAsc = true;
let collapsedIds = new Set();
let ctxTaskId = null;
let currentProjectId = null;

// ── Cache ──
const taskCache = {};
const CACHE_TTL = 5 * 60 * 1000;
function getCached(pid) { const e = taskCache[pid]; return e && Date.now() - e.ts < CACHE_TTL ? e : null; }
function invalidateCache(pid) { delete taskCache[pid]; }

// ── API ──
async function api(method, path, body) {
    const h = { 'Authorization': `Bearer ${token}` };
    if (body) h['Content-Type'] = 'application/json';
    const opts = { method, headers: h };
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch(`${API_BASE}${path}`, opts);
    if (!r.ok) throw new Error(`API ${r.status}: ${await r.text()}`);
    return r.status === 204 ? null : r.json();
}

async function apiPaginated(path) {
    let all = [], cursor = null;
    do {
        let url = cursor ? path + (path.includes('?') ? '&' : '?') + 'cursor=' + cursor : path;
        if (!url.includes('limit=')) url += (url.includes('?') ? '&' : '?') + 'limit=200';
        const d = await api('GET', url);
        if (!d) return all;
        if (Array.isArray(d)) return all.concat(d);
        all = all.concat(d.results || []);
        cursor = d.nextCursor || null;
    } while (cursor);
    return all;
}

async function fetchAllCompleted(projectId) {
    let all = [], offset = 0;
    do {
        const d = await api('GET', `/tasks/completed?projectId=${projectId}&limit=200&offset=${offset}`);
        if (!d) break;
        const items = d.items || d.results || [];
        all = all.concat(items);
        if (items.length < 200) break;
        offset += items.length;
    } while (true);
    return all.map(i => ({
        id: i.taskId || i.task_id || i.id, content: i.content, description: '',
        priority: i.priority || 1, labels: i.labels || [], due: i.due || null,
        sectionId: i.sectionId || i.section_id || null,
        parentId: i.parentId || i.parent_id || null,
        responsible_uid: i.responsible_uid || i.responsibleUid || null, _status: 'completed',
    }));
}

// ── Parallel exec ──
async function parallelLimit(tasks, limit, onProgress) {
    let ok = 0, fail = 0, idx = 0;
    async function run() {
        while (idx < tasks.length) {
            const i = idx++;
            try { await tasks[i](); ok++; } catch { fail++; }
            if (onProgress) await onProgress(ok + fail, tasks.length);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, run));
    return { completed: ok, failed: fail };
}

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

// ── Toggle Buttons ──
function handleToggle(e) {
    const btn = e.currentTarget;
    const container = btn.parentElement;
    const isMulti = e.ctrlKey || e.metaKey;

    if (btn.dataset.value === '__select_all__') {
        const others = container.querySelectorAll('.toggle-btn:not([data-value="__select_all__"])');
        const allActive = [...others].every(b => b.classList.contains('active'));
        others.forEach(b => b.classList.toggle('active', !allActive));
        applyFilters();
        return;
    }

    if (isMulti) {
        btn.classList.toggle('active');
    } else {
        const siblings = container.querySelectorAll('.toggle-btn:not([data-value="__select_all__"])');
        const wasOnlyActive = btn.classList.contains('active') &&
            [...siblings].filter(b => b.classList.contains('active')).length === 1;
        if (wasOnlyActive) {
            siblings.forEach(b => b.classList.add('active'));
        } else {
            siblings.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        }
    }
    applyFilters();
}

// Mobile: long press = multi-select
let longPressTimer = null;
function handleTouchStart(e) {
    const btn = e.currentTarget;
    longPressTimer = setTimeout(() => {
        longPressTimer = null;
        btn.classList.toggle('active');
        applyFilters();
    }, 500);
}
function handleTouchEnd(e) {
    if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
        const btn = e.currentTarget;
        const container = btn.parentElement;
        if (btn.dataset.value === '__select_all__') { handleToggle(e); return; }
        const siblings = container.querySelectorAll('.toggle-btn:not([data-value="__select_all__"])');
        const wasOnlyActive = btn.classList.contains('active') &&
            [...siblings].filter(b => b.classList.contains('active')).length === 1;
        if (wasOnlyActive) { siblings.forEach(b => b.classList.add('active')); }
        else { siblings.forEach(b => b.classList.remove('active')); btn.classList.add('active'); }
        applyFilters();
        e.preventDefault();
    }
}

function bindToggleButtons() {
    document.querySelectorAll('.toggle-btn').forEach(btn => {
        btn.onclick = handleToggle;
        btn.addEventListener('touchstart', handleTouchStart, { passive: true });
        btn.addEventListener('touchend', handleTouchEnd);
    });
}

function getActiveValues(containerId) {
    return [...document.querySelectorAll(`#${containerId} .toggle-btn.active:not([data-value="__select_all__"])`)].map(b => b.dataset.value);
}

// ── Connect ──
async function connect() {
    token = document.getElementById('token-input').value.trim();
    const err = document.getElementById('auth-error');
    err.classList.add('hidden');
    if (!token) { err.textContent = 'Bitte Token eingeben.'; err.classList.remove('hidden'); return; }

    const mainErr = document.getElementById('main-error');
    mainErr.classList.add('hidden');

    try {
        const r = await fetch(`${API_BASE}/projects`, { headers: { 'Authorization': `Bearer ${token}` } });
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
        localStorage.setItem('todoist_token', token);
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
    currentProjectId = pid;

    if (!force) {
        const c = getCached(pid);
        if (c) {
            sections = c.sections; collaborators = c.collaborators; allTasks = [...c.open, ...c.completed];
            showUI(); showToast(`${allTasks.length} Aufgaben (Cache).`, 'success'); return;
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

        const secs = {}; secList.forEach(s => { secs[s.id] = s.name; }); sections = secs;
        const cols = {}; collabList.forEach(c => { cols[c.id] = c.name || c.email || c.id; });
        [...open, ...completed].forEach(t => {
            const uid = t.responsible_uid || t.responsibleUid || t.assignee_id || t.assigneeId;
            if (uid && !cols[uid]) cols[uid] = uid;
        });
        collaborators = cols;

        taskCache[pid] = { open, completed, sections: secs, collaborators: cols, ts: Date.now() };
        allTasks = [...open, ...completed];
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

// ── Populate dynamic filters ──
function populateAssigneeToggles() {
    const c = document.getElementById('filter-assignee-toggles');
    const names = Object.entries(collaborators);
    const group = document.getElementById('assignee-toggle-group');
    if (!group || !c) return;
    if (names.length === 0) { group.style.display = 'none'; return; }
    group.style.display = '';
    c.innerHTML = '';

    const allBtn = mk('button', 'toggle-btn meta-btn', 'Alle');
    allBtn.dataset.value = '__select_all__';
    c.appendChild(allBtn);

    const noneBtn = mk('button', 'toggle-btn active', 'Ohne');
    noneBtn.dataset.value = '__none__';
    c.appendChild(noneBtn);

    names.forEach(([id, name]) => {
        const b = mk('button', 'toggle-btn active', name);
        b.dataset.value = id;
        c.appendChild(b);
    });
    bindToggleButtons();
}

function populateLabelFilter() {
    const labels = new Set();
    allTasks.forEach(t => (t.labels || []).forEach(l => labels.add(l)));
    const sel = document.getElementById('filter-label');
    const cur = sel.value;
    sel.innerHTML = '<option value="">Label: Alle</option>';
    [...labels].sort().forEach(l => { const o = document.createElement('option'); o.value = l; o.textContent = l; sel.appendChild(o); });
    sel.value = cur;
}

function mk(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text) el.textContent = text;
    return el;
}

// ── Hierarchy ──
function buildHierarchy(tasks) {
    const map = new Map(); tasks.forEach(t => map.set(t.id, t));
    tasks.forEach(t => {
        let depth = 0, cur = t, pid = cur.parentId || cur.parent_id;
        while (pid && map.has(pid)) { depth++; cur = map.get(pid); pid = cur.parentId || cur.parent_id; }
        t._depth = depth;
    });
    const byParent = new Map();
    tasks.filter(t => t._depth > 0).forEach(c => {
        const pid = c.parentId || c.parent_id;
        if (!byParent.has(pid)) byParent.set(pid, []);
        byParent.get(pid).push(c);
    });
    const result = [];
    function add(t) { result.push(t); t._hasChildren = byParent.has(t.id); (byParent.get(t.id) || []).forEach(add); }
    tasks.filter(t => t._depth === 0).forEach(add);
    tasks.forEach(t => { if (!result.includes(t)) { t._depth = 0; result.push(t); } });
    return result;
}

function isHiddenByCollapse(task) {
    const map = new Map(); filteredTasks.forEach(t => map.set(t.id, t));
    let pid = task.parentId || task.parent_id;
    while (pid) {
        if (collapsedIds.has(pid)) return true;
        const parent = map.get(pid);
        if (!parent) break;
        pid = parent.parentId || parent.parent_id;
    }
    const sid = task.sectionId || task.section_id || '__none__';
    return collapsedIds.has('sec_' + sid);
}

// ── Reset all filters ──
function resetAllFilters() {
    document.getElementById('filter-search').value = '';
    document.getElementById('filter-label').value = '';
    document.querySelectorAll('#filter-status-toggles .toggle-btn').forEach(b => b.classList.add('active'));
    document.querySelectorAll('#filter-priority-toggles .toggle-btn').forEach(b => b.classList.add('active'));
    document.querySelectorAll('#filter-assignee-toggles .toggle-btn:not([data-value="__select_all__"])').forEach(b => b.classList.add('active'));
    applyFilters();
}

// ── Filters ──
function applyFilters() {
    const search = document.getElementById('filter-search').value.toLowerCase();
    const label = document.getElementById('filter-label').value;
    const statuses = getActiveValues('filter-status-toggles');
    const priorities = getActiveValues('filter-priority-toggles');
    const assignees = getActiveValues('filter-assignee-toggles');

    filteredTasks = allTasks.filter(t => {
        if (search && !t.content.toLowerCase().includes(search) && !(t.description || '').toLowerCase().includes(search)) return false;
        if (statuses.length > 0 && statuses.length < 2) {
            const s = (t._status === 'completed' || t.is_completed || t.checked) ? 'completed' : 'open';
            if (!statuses.includes(s)) return false;
        }
        if (priorities.length > 0 && priorities.length < 4) {
            if (!priorities.includes(String(t.priority))) return false;
        }
        if (label && !(t.labels || []).includes(label)) return false;
        if (assignees.length > 0) {
            const uid = t.responsible_uid || t.responsibleUid || t.assignee_id || t.assigneeId;
            if (!uid && !assignees.includes('__none__')) return false;
            if (uid && !assignees.includes(uid)) return false;
        }
        return true;
    });

    sortTasks();
    filteredTasks = buildHierarchy(filteredTasks);
    selectedIds.clear();
    document.getElementById('select-all').checked = false;
    updateSelectionUI();
    renderTable();
    updateStats();
}

// ── Sorting ──
function sortBy(field) {
    if (sortField === field) sortAsc = !sortAsc; else { sortField = field; sortAsc = true; }
    document.querySelectorAll('th.sortable').forEach(th => th.classList.remove('sort-asc', 'sort-desc'));
    const ths = document.querySelectorAll('th.sortable');
    const idx = ['content', 'priority', 'due', 'assignee'].indexOf(field);
    if (idx >= 0 && ths[idx]) ths[idx].classList.add(sortAsc ? 'sort-asc' : 'sort-desc');
    sortTasks(); filteredTasks = buildHierarchy(filteredTasks); renderTable();
}

function sortTasks() {
    filteredTasks.sort((a, b) => {
        let va, vb;
        switch (sortField) {
            case 'content': va = a.content.toLowerCase(); vb = b.content.toLowerCase(); break;
            case 'priority': va = a.priority; vb = b.priority; return sortAsc ? vb - va : va - vb;
            case 'due': va = a.due ? a.due.date : 'z'; vb = b.due ? b.due.date : 'z'; break;
            case 'assignee': va = getAssignee(a).toLowerCase(); vb = getAssignee(b).toLowerCase(); break;
            default: return 0;
        }
        return va < vb ? (sortAsc ? -1 : 1) : va > vb ? (sortAsc ? 1 : -1) : 0;
    });
}

// ── Helpers ──
const PRIO = { 4: 'P1', 3: 'P2', 2: 'P3', 1: 'P4' };
function getSid(t) { return t.sectionId || t.section_id || null; }
function getAssignee(t) { const u = t.responsible_uid || t.responsibleUid || t.assignee_id || t.assigneeId; return u ? (collaborators[u] || u) : ''; }
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function fmtDate(s) { return new Date(s).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }); }

function todoistUrl(taskId) {
    return `https://todoist.com/app/task/${taskId}`;
}

// ── Stats ──
function updateStats() {
    const total = allTasks.length;
    const openCount = allTasks.filter(t => t._status !== 'completed' && !t.is_completed && !t.checked).length;
    const completedCount = total - openCount;
    const visible = filteredTasks.length;
    const txt = `${visible} von ${total} | ${openCount} offen, ${completedCount} erledigt`;
    document.getElementById('stats-top').textContent = txt;
    document.getElementById('stats-bottom').textContent = txt;
}

// ── Rendering ──
function renderTable() {
    const tbody = document.getElementById('task-body');
    const noTasks = document.getElementById('no-tasks');

    if (filteredTasks.length === 0) { tbody.innerHTML = ''; noTasks.classList.remove('hidden'); return; }
    noTasks.classList.add('hidden');

    const groups = []; const gmap = new Map();
    filteredTasks.forEach(t => {
        const sid = getSid(t) || '__none__';
        if (!gmap.has(sid)) { const g = { id: sid, name: sid === '__none__' ? '(Ohne Abschnitt)' : (sections[sid] || '?'), tasks: [] }; groups.push(g); gmap.set(sid, g); }
        gmap.get(sid).tasks.push(t);
    });

    const hasSections = groups.length > 1 || groups[0]?.id !== '__none__';

    const today = new Date(); today.setHours(0, 0, 0, 0);
    let html = '';

    groups.forEach(g => {
        const secKey = 'sec_' + g.id;
        const secCollapsed = collapsedIds.has(secKey);
        if (hasSections) {
            html += `<tr class="section-row ${secCollapsed ? 'collapsed' : ''}" onclick="toggleCollapse('${secKey}')">
                <td colspan="8"><span class="section-toggle">&#9660;</span> ${esc(g.name)} <span class="section-count">(${g.tasks.length})</span></td></tr>`;
        }
        if (!secCollapsed) {
            g.tasks.forEach(t => {
                if (isHiddenByCollapse(t)) return;
                html += taskRow(t, today);
            });
        }
    });

    tbody.innerHTML = html;
}

function taskRow(t, today) {
    const sel = selectedIds.has(t.id);
    const depth = t._depth || 0;
    const pad = depth > 0 ? `padding-left:${depth * 20 + 10}px` : '';
    const prefix = depth > 0 ? '<span class="subtask-indicator">&#x2514; </span>' : '';

    let collapseBtn = '';
    if (t._hasChildren) {
        const isColl = collapsedIds.has(t.id);
        collapseBtn = `<span class="collapse-toggle ${isColl ? 'collapsed' : ''}" onclick="event.stopPropagation();toggleCollapse('${t.id}')">&#9660;</span>`;
    }

    const desc = t.description ? `<span class="task-description">${esc(t.description.substring(0, 80))}${t.description.length > 80 ? '...' : ''}</span>` : '';
    const isComp = t._status === 'completed' || t.is_completed || t.checked;
    const statusCb = `<input type="checkbox" class="status-cb" ${isComp ? 'checked' : ''} onchange="toggleTaskStatus('${t.id}',this)" title="${isComp ? 'Unerledigt' : 'Erledigt'}">`;

    let dueHtml = '';
    if (t.due) {
        const d = new Date(t.due.date), ov = d < today;
        dueHtml = `<span class="due-date${ov ? ' overdue' : ''}">${fmtDate(t.due.date)}${ov ? ' !' : ''}</span>`;
    }

    const labels = (t.labels || []).map(l => `<span class="label-tag">${esc(l)}</span>`).join('');
    const assignee = getAssignee(t);
    const taskLink = `<a href="${todoistUrl(t.id)}" target="_blank" rel="noopener" class="task-link" title="In Todoist öffnen">${esc(t.content)}</a>`;

    return `<tr class="${sel ? 'selected' : ''}" data-id="${t.id}">
        <td class="col-check"><input type="checkbox" ${sel ? 'checked' : ''} onchange="toggleSelect('${t.id}')"></td>
        <td style="${pad}"><div class="task-content">${collapseBtn}${prefix}<span>${taskLink}</span>${desc}</div></td>
        <td class="col-status">${statusCb}</td>
        <td><span class="priority-badge priority-${t.priority}">${PRIO[t.priority] || 'P4'}</span></td>
        <td>${dueHtml || '—'}</td>
        <td>${assignee ? esc(assignee) : '—'}</td>
        <td>${labels || '—'}</td>
        <td class="col-actions"><button class="actions-btn" onclick="showCtxMenu(event,'${t.id}')">&#8943;</button></td>
    </tr>`;
}

// ── Local status update (no reload) ──
function updateTaskStatusLocally(taskId, newStatus) {
    const pid = currentProjectId;
    const cache = taskCache[pid];
    if (!cache) return;

    if (newStatus === 'completed') {
        // Move from open to completed
        const idx = cache.open.findIndex(t => t.id === taskId);
        if (idx >= 0) {
            const task = cache.open.splice(idx, 1)[0];
            task._status = 'completed';
            cache.completed.push(task);
        }
    } else {
        // Move from completed to open
        const idx = cache.completed.findIndex(t => t.id === taskId);
        if (idx >= 0) {
            const task = cache.completed.splice(idx, 1)[0];
            task._status = 'open';
            cache.open.push(task);
        }
    }

    // Also update allTasks reference
    const task = allTasks.find(t => t.id === taskId);
    if (task) task._status = newStatus;
}

// ── Collapse ──
function toggleCollapse(id) { collapsedIds.has(id) ? collapsedIds.delete(id) : collapsedIds.add(id); renderTable(); }
function expandAll() { collapsedIds.clear(); renderTable(); }
function collapseAll() {
    filteredTasks.forEach(t => { if (t._hasChildren) collapsedIds.add(t.id); });
    const groups = new Set(); filteredTasks.forEach(t => groups.add('sec_' + (getSid(t) || '__none__')));
    groups.forEach(id => collapsedIds.add(id));
    renderTable();
}

// ── Context Menu ──
function showCtxMenu(e, taskId) {
    e.stopPropagation();
    ctxTaskId = taskId;
    hideListMenu();
    const menu = document.getElementById('context-menu');
    if (!menu) return;

    // Populate assignee submenu
    const assigneeSub = document.getElementById('ctx-assignee-sub');
    if (assigneeSub) {
        assigneeSub.innerHTML = '<button onclick="ctxAction(\'assignee\',null)">Niemand</button>';
        Object.entries(collaborators).forEach(([uid, name]) => {
            assigneeSub.innerHTML += `<button onclick="ctxAction('assignee','${uid}')">${esc(name)}</button>`;
        });
    }

    // Populate labels submenu for this task
    const task = allTasks.find(t => t.id === taskId);
    const labelsWrap = document.getElementById('ctx-labels-wrap');
    const labelsSub = document.getElementById('ctx-labels-sub');
    if (labelsWrap && labelsSub && task && task.labels && task.labels.length > 0) {
        labelsWrap.style.display = '';
        labelsSub.innerHTML = '';
        task.labels.forEach(l => {
            labelsSub.innerHTML += `<button onclick="ctxAction('removeLabel','${esc(l)}')">${esc(l)} &times;</button>`;
        });
    } else if (labelsWrap) {
        labelsWrap.style.display = 'none';
    }

    menu.classList.remove('hidden');
    const rect = e.currentTarget.getBoundingClientRect();
    const menuH = menu.offsetHeight || 380;
    const top = (rect.bottom + menuH > window.innerHeight) ? Math.max(4, rect.top - menuH) : rect.bottom + 4;
    const left = Math.min(rect.left, window.innerWidth - 220);
    menu.style.top = top + 'px';
    menu.style.left = left + 'px';

    // Flip submenus to open left if they'd overflow the right edge
    const openLeft = left + 220 + 140 > window.innerWidth;
    menu.querySelectorAll('.ctx-submenu').forEach(s => s.classList.toggle('open-left', openLeft));
}

function hideCtxMenu() { const m = document.getElementById('context-menu'); if (m) m.classList.add('hidden'); ctxTaskId = null; }

async function ctxAction(action, value) {
    const id = ctxTaskId;
    hideCtxMenu();
    if (!id) return;
    const task = allTasks.find(t => t.id === id);
    try {
        if (action === 'complete') {
            await api('POST', `/tasks/${id}/close`);
            updateTaskStatusLocally(id, 'completed');
            showToast('Erledigt.', 'success', async () => {
                await api('POST', `/tasks/${id}/reopen`);
                updateTaskStatusLocally(id, 'open');
                applyFilters();
            });
        } else if (action === 'reopen') {
            await api('POST', `/tasks/${id}/reopen`);
            updateTaskStatusLocally(id, 'open');
            showToast('Wieder geöffnet.', 'success', async () => {
                await api('POST', `/tasks/${id}/close`);
                updateTaskStatusLocally(id, 'completed');
                applyFilters();
            });
        } else if (action === 'priority') {
            const oldPrio = task ? task.priority : null;
            await api('POST', `/tasks/${id}`, { priority: value });
            if (task) task.priority = value;
            invalidateCache(currentProjectId);
            showToast(`Priorität → ${PRIO[value]}`, 'success', oldPrio != null ? async () => {
                await api('POST', `/tasks/${id}`, { priority: oldPrio });
                if (task) task.priority = oldPrio;
                invalidateCache(currentProjectId);
                applyFilters();
            } : null);
        } else if (action === 'assignee') {
            const oldUid = task ? (task.responsible_uid || task.responsibleUid || task.assignee_id || task.assigneeId || null) : null;
            const body = value ? { responsible_uid: value } : { responsible_uid: null };
            await api('POST', `/tasks/${id}`, body);
            if (task) { task.responsible_uid = value; task.responsibleUid = value; task.assignee_id = value; }
            invalidateCache(currentProjectId);
            const name = value ? (collaborators[value] || value) : 'Niemand';
            showToast(`Verantwortlich: ${name}`, 'success', async () => {
                await api('POST', `/tasks/${id}`, { responsible_uid: oldUid });
                if (task) { task.responsible_uid = oldUid; task.responsibleUid = oldUid; task.assignee_id = oldUid; }
                invalidateCache(currentProjectId);
                applyFilters();
            });
        } else if (action === 'removeLabel') {
            if (!task) return;
            const oldLabels = [...(task.labels || [])];
            const newLabels = oldLabels.filter(l => l !== value);
            await api('POST', `/tasks/${id}`, { labels: newLabels });
            task.labels = newLabels;
            invalidateCache(currentProjectId);
            showToast(`Label "${value}" entfernt.`, 'success', async () => {
                await api('POST', `/tasks/${id}`, { labels: oldLabels });
                task.labels = oldLabels;
                invalidateCache(currentProjectId);
                applyFilters();
            });
        } else if (action === 'editDue') {
            const input = document.getElementById('due-date-input');
            input.value = task && task.due ? task.due.date : '';
            const dlg = document.getElementById('due-dialog');
            dlg._taskId = id;
            dlg.classList.remove('hidden');
            return;
        } else if (action === 'duplicate') {
            if (!task) return;
            const body = { content: task.content, project_id: currentProjectId, priority: task.priority };
            if (task.description) body.description = task.description;
            if (task.labels && task.labels.length) body.labels = task.labels;
            if (task.due) body.due_date = task.due.date;
            if (task.parent_id || task.parentId) body.parent_id = task.parent_id || task.parentId;
            if (task.section_id || task.sectionId) body.section_id = task.section_id || task.sectionId;
            const newTask = await api('POST', '/tasks', body);
            invalidateCache(currentProjectId);
            await loadTasks(true);
            showToast('Aufgabe dupliziert.', 'success');
        } else if (action === 'delete') {
            await api('DELETE', `/tasks/${id}`);
            allTasks = allTasks.filter(t => t.id !== id);
            invalidateCache(currentProjectId);
            showToast('Aufgabe gelöscht.', 'success');
        } else if (action === 'openTodoist') {
            window.open(todoistUrl(id), '_blank');
            return;
        }
        applyFilters();
    } catch (e) { showToast('Fehler: ' + e.message, 'error'); }
}

// ── Due Date Dialog ──
function closeDueDialog() { document.getElementById('due-dialog').classList.add('hidden'); }
async function saveDueDate(dateVal) {
    const id = ctxTaskId || document.getElementById('due-dialog')._taskId;
    closeDueDialog();
    if (!id) return;
    const task = allTasks.find(t => t.id === id);
    const oldDue = task && task.due ? task.due.date : null;
    try {
        const body = dateVal ? { due_date: dateVal } : { due_string: 'no date' };
        await api('POST', `/tasks/${id}`, body);
        if (task) task.due = dateVal ? { date: dateVal } : null;
        invalidateCache(currentProjectId);
        showToast(dateVal ? `Fällig: ${fmtDate(dateVal)}` : 'Fälligkeitsdatum entfernt.', 'success', async () => {
            const undoBody = oldDue ? { due_date: oldDue } : { due_string: 'no date' };
            await api('POST', `/tasks/${id}`, undoBody);
            if (task) task.due = oldDue ? { date: oldDue } : null;
            invalidateCache(currentProjectId);
            applyFilters();
        });
        applyFilters();
    } catch (e) { showToast('Fehler: ' + e.message, 'error'); }
}

// ── List Menu (replaces bulk action buttons) ──
function showListMenu(e) {
    e.stopPropagation();
    hideCtxMenu();
    const menu = document.getElementById('list-menu');
    if (!menu) return;
    const hasSel = selectedIds.size > 0;
    menu.querySelectorAll('button').forEach(b => {
        if (b.textContent.startsWith('Auswahl:')) b.style.display = hasSel ? '' : 'none';
    });
    // Hide first separator if no selection buttons visible
    const seps = menu.querySelectorAll('.ctx-separator');
    if (seps[0]) seps[0].style.display = hasSel ? '' : 'none';
    menu.classList.remove('hidden');
    const rect = e.currentTarget.getBoundingClientRect();
    menu.style.top = rect.bottom + 4 + 'px';
    menu.style.left = Math.min(rect.right - 200, window.innerWidth - 220) + 'px';
}
function hideListMenu() { const m = document.getElementById('list-menu'); if (m) m.classList.add('hidden'); }

function listMenuAction(action) {
    hideListMenu();
    if (action === 'reopenSelected') reopenSelected();
    else if (action === 'completeSelected') completeSelected();
    else if (action === 'expandAll') expandAll();
    else if (action === 'collapseAll') collapseAll();
    else if (action === 'refresh') loadTasks(true);
}

document.addEventListener('click', e => {
    if (!e.target.closest('.context-menu') && !e.target.closest('.actions-btn') && !e.target.closest('.list-actions-btn')) {
        hideCtxMenu();
        hideListMenu();
    }
});

// ── Inline status toggle (no page reload!) ──
async function toggleTaskStatus(taskId, cb) {
    cb.disabled = true;
    const was = !cb.checked;
    try {
        if (cb.checked) {
            await api('POST', `/tasks/${taskId}/close`);
            updateTaskStatusLocally(taskId, 'completed');
            showToast('Erledigt.', 'success', async () => {
                await api('POST', `/tasks/${taskId}/reopen`);
                updateTaskStatusLocally(taskId, 'open');
                applyFilters();
            });
        } else {
            await api('POST', `/tasks/${taskId}/reopen`);
            updateTaskStatusLocally(taskId, 'open');
            showToast('Wieder geöffnet.', 'success', async () => {
                await api('POST', `/tasks/${taskId}/close`);
                updateTaskStatusLocally(taskId, 'completed');
                applyFilters();
            });
        }
        applyFilters();
    } catch (e) {
        cb.checked = was;
        cb.disabled = false;
        showToast('Fehler: ' + e.message, 'error');
    }
}

// ── Selection ──
function toggleSelect(id) {
    selectedIds.has(id) ? selectedIds.delete(id) : selectedIds.add(id);
    updateSelectionUI();
    const row = document.querySelector(`tr[data-id="${id}"]`);
    if (row) row.classList.toggle('selected', selectedIds.has(id));
}

function toggleSelectAll() {
    const ch = document.getElementById('select-all').checked;
    selectedIds.clear();
    if (ch) filteredTasks.forEach(t => selectedIds.add(t.id));
    updateSelectionUI();
    renderTable();
}

function updateSelectionUI() {
    const n = selectedIds.size;
    document.getElementById('selection-count').textContent = n > 0 ? `${n} ausgewählt` : '';
    document.getElementById('select-all').checked = filteredTasks.length > 0 && n === filteredTasks.length;
}

// ── Bulk Actions ──
async function reopenSelected() {
    if (!selectedIds.size) return;
    const ids = [...selectedIds];
    const { completed, failed } = await parallelLimit(
        ids.map(id => () => api('POST', `/tasks/${id}/reopen`)), 5,
        (d, t) => showProgress(d, t, 'Unerledigt'));
    hideProgress();
    ids.forEach(id => updateTaskStatusLocally(id, 'open'));
    const msg = failed ? `${completed} ok, ${failed} Fehler.` : `${completed} als unerledigt markiert.`;
    showToast(msg, failed ? 'error' : 'success', !failed ? async () => {
        await parallelLimit(ids.map(id => () => api('POST', `/tasks/${id}/close`)), 5);
        ids.forEach(id => updateTaskStatusLocally(id, 'completed'));
        applyFilters();
    } : null);
    selectedIds.clear();
    applyFilters();
}

async function completeSelected() {
    if (!selectedIds.size) return;
    const ids = [...selectedIds];
    const { completed, failed } = await parallelLimit(
        ids.map(id => () => api('POST', `/tasks/${id}/close`)), 5,
        (d, t) => showProgress(d, t, 'Erledigt'));
    hideProgress();
    ids.forEach(id => updateTaskStatusLocally(id, 'completed'));
    const msg = failed ? `${completed} ok, ${failed} Fehler.` : `${completed} als erledigt markiert.`;
    showToast(msg, failed ? 'error' : 'success', !failed ? async () => {
        await parallelLimit(ids.map(id => () => api('POST', `/tasks/${id}/reopen`)), 5);
        ids.forEach(id => updateTaskStatusLocally(id, 'open'));
        applyFilters();
    } : null);
    selectedIds.clear();
    applyFilters();
}

// ── Toast with Undo ──
let undoFn = null;
function showToast(msg, type, undoCallback) {
    const t = document.getElementById('toast');
    if (!t) return;
    const msgEl = document.getElementById('toast-msg');
    const undoBtn = document.getElementById('toast-undo');
    if (!msgEl) { t.textContent = msg; } else { msgEl.textContent = msg; }
    t.className = 'toast' + (type ? ' toast-' + type : '');
    t.classList.remove('hidden');
    undoFn = undoCallback || null;
    if (undoBtn) {
        if (undoCallback) { undoBtn.classList.remove('hidden'); } else { undoBtn.classList.add('hidden'); }
    }
    clearTimeout(t._t);
    t._t = setTimeout(() => { t.classList.add('hidden'); undoFn = null; }, undoCallback ? 8000 : 4000);
}
async function executeUndo() {
    if (!undoFn) return;
    const fn = undoFn;
    undoFn = null;
    document.getElementById('toast').classList.add('hidden');
    try { await fn(); } catch (e) { showToast('Rückgängig fehlgeschlagen: ' + e.message, 'error'); }
}

// ── Init ──
document.getElementById('token-input').addEventListener('keydown', e => { if (e.key === 'Enter') connect(); });
bindToggleButtons();

(function () {
    const t = localStorage.getItem('todoist_token');
    if (t) { document.getElementById('token-input').value = t; connect(); }
})();
