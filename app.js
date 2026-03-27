const API_BASE = 'https://api.todoist.com/api/v1';

let token = '';
let allTasks = [];       // all tasks from cache (open + completed combined)
let filteredTasks = [];  // after filters applied
let sections = {};       // id -> name
let collaborators = {};  // userId -> name
let selectedIds = new Set();
let sortField = 'content';
let sortAsc = true;
let collapsedSections = new Set();

// ── Task Cache ──
const taskCache = {};
const CACHE_TTL = 5 * 60 * 1000;

function getCached(projectId) {
    const entry = taskCache[projectId];
    if (!entry) return null;
    if (Date.now() - entry.ts > CACHE_TTL) return null;
    return entry;
}

function invalidateCache(projectId) {
    delete taskCache[projectId];
}

// ── API Helpers ──

async function api(method, path, body = null) {
    const headers = { 'Authorization': `Bearer ${token}` };
    if (body) headers['Content-Type'] = 'application/json';
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${API_BASE}${path}`, opts);
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`API ${res.status}: ${text}`);
    }
    if (res.status === 204) return null;
    return res.json();
}

async function apiPaginated(path) {
    let allResults = [];
    let cursor = null;
    do {
        let url = cursor
            ? path + (path.includes('?') ? '&' : '?') + 'cursor=' + cursor
            : path;
        if (!url.includes('limit=')) {
            url += (url.includes('?') ? '&' : '?') + 'limit=200';
        }
        const data = await api('GET', url);
        if (Array.isArray(data)) { allResults = allResults.concat(data); break; }
        allResults = allResults.concat(data.results || []);
        cursor = data.nextCursor || null;
    } while (cursor);
    return allResults;
}

async function fetchAllCompletedTasks(projectId) {
    let allItems = [];
    let offset = 0;
    const pageSize = 200;
    do {
        const data = await api('GET', `/tasks/completed?projectId=${projectId}&limit=${pageSize}&offset=${offset}`);
        const items = data.items || data.results || [];
        allItems = allItems.concat(items);
        if (items.length < pageSize) break;
        offset += items.length;
    } while (true);

    return allItems.map(item => ({
        id: item.taskId || item.task_id || item.id,
        content: item.content,
        description: '',
        priority: 1,
        labels: [],
        due: null,
        sectionId: item.sectionId || item.section_id || null,
        parentId: item.parentId || item.parent_id || null,
        responsibleUid: item.responsibleUid || null,
        _status: 'completed',
    }));
}

// ── Parallel execution with concurrency ──
async function parallelLimit(tasks, limit, onProgress) {
    let completed = 0, failed = 0;
    let index = 0;
    async function runNext() {
        while (index < tasks.length) {
            const i = index++;
            try { await tasks[i](); completed++; }
            catch (e) { failed++; }
            if (onProgress) await onProgress(completed + failed, tasks.length, completed, failed);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => runNext()));
    return { completed, failed };
}

// ── Progress Bar ──
async function showProgress(current, total, label) {
    const bar = document.getElementById('progress-bar');
    if (!bar) return;
    bar.classList.remove('hidden');
    const pct = Math.round((current / total) * 100);
    bar.querySelector('.progress-fill').style.width = pct + '%';
    bar.querySelector('.progress-text').textContent = `${label}: ${current} / ${total}`;
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
}

function hideProgress() {
    const bar = document.getElementById('progress-bar');
    if (bar) bar.classList.add('hidden');
}

// ── Toggle Filter Buttons ──
function toggleFilter(btn) {
    btn.classList.toggle('active');
    applyFilters();
}

function getActiveValues(containerId) {
    const btns = document.querySelectorAll(`#${containerId} .toggle-btn.active`);
    return [...btns].map(b => b.dataset.value);
}

// ── Connect ──
async function connect() {
    token = document.getElementById('token-input').value.trim();
    const errEl = document.getElementById('auth-error');
    errEl.classList.add('hidden');

    if (!token) {
        errEl.textContent = 'Bitte Token eingeben.';
        errEl.classList.remove('hidden');
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/projects`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${token}` },
        });

        if (!res.ok) {
            const body = await res.text().catch(() => '');
            if (res.status === 401 || res.status === 403) {
                errEl.textContent = `Authentifizierung fehlgeschlagen (HTTP ${res.status}). Token ungültig oder abgelaufen.`;
            } else if (res.status === 410) {
                errEl.textContent = `API-Endpunkt nicht mehr verfügbar (HTTP 410).`;
            } else {
                errEl.textContent = `API-Fehler HTTP ${res.status}: ${body.substring(0, 200)}`;
            }
            errEl.classList.remove('hidden');
            return;
        }

        const data = await res.json();
        const projects = data.results || data;

        const select = document.getElementById('project-select');
        select.innerHTML = '<option value="">-- Projekt wählen --</option>';
        projects.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = p.name;
            select.appendChild(opt);
        });
        document.getElementById('project-section').classList.remove('hidden');
        localStorage.setItem('todoist_token', token);
        showToast('Verbunden! Bitte Projekt auswählen.', 'success');
    } catch (e) {
        if (e instanceof TypeError) {
            errEl.textContent = 'Netzwerkfehler: Keine Verbindung möglich. Internetverbindung/Adblocker prüfen.';
        } else {
            errEl.textContent = `Fehler: ${e.message}`;
        }
        errEl.classList.remove('hidden');
        console.error('Connect error:', e);
    }
}

// ── Load Tasks ──
async function loadTasks(forceRefresh = false) {
    const projectId = document.getElementById('project-select').value;
    if (!projectId) return;

    const filterSection = document.getElementById('filter-section');
    const taskSection = document.getElementById('task-section');
    const loading = document.getElementById('loading');

    if (!forceRefresh) {
        const cached = getCached(projectId);
        if (cached) {
            sections = cached.sections;
            collaborators = cached.collaborators;
            allTasks = [...cached.open, ...cached.completed];
            filterSection.classList.remove('hidden');
            taskSection.classList.remove('hidden');
            populateAssigneeToggles();
            populateLabelFilter(allTasks);
            applyFilters();
            showToast(`${allTasks.length} Aufgaben (Cache).`, 'success');
            return;
        }
    }

    filterSection.classList.remove('hidden');
    taskSection.classList.remove('hidden');
    loading.classList.remove('hidden');
    document.getElementById('task-body').innerHTML = '';
    document.getElementById('no-tasks').classList.add('hidden');

    try {
        const [openTasks, completedTasks, sectionList, collabList] = await Promise.all([
            apiPaginated(`/tasks?projectId=${projectId}`),
            fetchAllCompletedTasks(projectId),
            apiPaginated(`/sections?projectId=${projectId}`),
            apiPaginated(`/projects/${projectId}/collaborators`).catch(() => []),
        ]);

        openTasks.forEach(t => { t._status = 'open'; });

        const secs = {};
        sectionList.forEach(s => { secs[s.id] = s.name; });
        sections = secs;

        const collabs = {};
        collabList.forEach(c => { collabs[c.id] = c.name || c.email || c.id; });
        // Also extract assignees from tasks themselves if collaborators endpoint failed
        [...openTasks, ...completedTasks].forEach(t => {
            const uid = t.responsibleUid || t.assigneeId || t.assignee_id;
            if (uid && !collabs[uid]) collabs[uid] = uid;
        });
        collaborators = collabs;

        taskCache[projectId] = {
            open: openTasks,
            completed: completedTasks,
            sections: secs,
            collaborators: collabs,
            ts: Date.now(),
        };

        allTasks = [...openTasks, ...completedTasks];
        populateAssigneeToggles();
        populateLabelFilter(allTasks);
        applyFilters();
        showToast(`${openTasks.length} offen + ${completedTasks.length} erledigt geladen.`, 'success');
    } catch (e) {
        showToast('Fehler: ' + e.message, 'error');
    } finally {
        loading.classList.add('hidden');
    }
}

// ── Populate dynamic filters ──
function populateAssigneeToggles() {
    const container = document.getElementById('filter-assignee-toggles');
    const names = Object.entries(collaborators);
    if (names.length === 0) {
        container.innerHTML = '<button class="toggle-btn active" data-value="__all__" onclick="toggleFilter(this)">Alle</button>';
        return;
    }
    container.innerHTML = '';
    // "Alle" toggle
    const allBtn = document.createElement('button');
    allBtn.className = 'toggle-btn active';
    allBtn.dataset.value = '__all__';
    allBtn.textContent = 'Alle';
    allBtn.onclick = function() { toggleFilter(this); };
    container.appendChild(allBtn);
    // "Keine" toggle (unassigned)
    const noneBtn = document.createElement('button');
    noneBtn.className = 'toggle-btn active';
    noneBtn.dataset.value = '__none__';
    noneBtn.textContent = 'Ohne';
    noneBtn.onclick = function() { toggleFilter(this); };
    container.appendChild(noneBtn);

    names.forEach(([id, name]) => {
        const btn = document.createElement('button');
        btn.className = 'toggle-btn active';
        btn.dataset.value = id;
        btn.textContent = name;
        btn.onclick = function() { toggleFilter(this); };
        container.appendChild(btn);
    });
}

function populateLabelFilter(tasks) {
    const labelSet = new Set();
    tasks.forEach(t => (t.labels || []).forEach(l => labelSet.add(l)));
    const select = document.getElementById('filter-label');
    const current = select.value;
    select.innerHTML = '<option value="">Alle</option>';
    [...labelSet].sort().forEach(l => {
        const opt = document.createElement('option');
        opt.value = l;
        opt.textContent = l;
        select.appendChild(opt);
    });
    select.value = current;
}

// ── Hierarchy ──
function buildHierarchy(tasks) {
    const taskMap = new Map();
    tasks.forEach(t => taskMap.set(t.id, t));

    tasks.forEach(t => {
        let depth = 0;
        let current = t;
        let pid = current.parentId || current.parent_id;
        while (pid && taskMap.has(pid)) {
            depth++;
            current = taskMap.get(pid);
            pid = current.parentId || current.parent_id;
        }
        t._depth = depth;
    });

    const roots = tasks.filter(t => t._depth === 0);
    const childrenByParent = new Map();
    tasks.filter(t => t._depth > 0).forEach(c => {
        const pid = c.parentId || c.parent_id;
        if (!childrenByParent.has(pid)) childrenByParent.set(pid, []);
        childrenByParent.get(pid).push(c);
    });

    const result = [];
    function addWithChildren(task) {
        result.push(task);
        (childrenByParent.get(task.id) || []).forEach(kid => addWithChildren(kid));
    }
    roots.forEach(r => addWithChildren(r));

    // Orphans
    tasks.forEach(t => {
        if (!result.includes(t)) { t._depth = 0; result.push(t); }
    });
    return result;
}

// ── Filters ──
function applyFilters() {
    const search = document.getElementById('filter-search').value.toLowerCase();
    const label = document.getElementById('filter-label').value;
    const activeStatuses = getActiveValues('filter-status-toggles');
    const activePriorities = getActiveValues('filter-priority-toggles');
    const activeAssignees = getActiveValues('filter-assignee-toggles');

    filteredTasks = allTasks.filter(t => {
        // Search
        if (search && !t.content.toLowerCase().includes(search) &&
            !(t.description || '').toLowerCase().includes(search)) return false;

        // Status
        if (activeStatuses.length > 0) {
            const isCompleted = t._status === 'completed' || t.is_completed || t.checked;
            const taskStatus = isCompleted ? 'completed' : 'open';
            if (!activeStatuses.includes(taskStatus)) return false;
        }

        // Priority
        if (activePriorities.length > 0 && activePriorities.length < 4) {
            if (!activePriorities.includes(String(t.priority))) return false;
        }

        // Label
        if (label && !(t.labels || []).includes(label)) return false;

        // Assignee
        if (activeAssignees.length > 0 && !activeAssignees.includes('__all__')) {
            const uid = t.responsibleUid || t.assigneeId || t.assignee_id;
            if (!uid && !activeAssignees.includes('__none__')) return false;
            if (uid && !activeAssignees.includes(uid)) return false;
        }

        return true;
    });

    sortTasks();
    filteredTasks = buildHierarchy(filteredTasks);
    selectedIds.clear();
    document.getElementById('select-all').checked = false;
    updateSelectionCount();
    renderTable();
}

// ── Sorting ──
function sortBy(field) {
    if (sortField === field) sortAsc = !sortAsc;
    else { sortField = field; sortAsc = true; }

    document.querySelectorAll('th.sortable').forEach(th => th.classList.remove('sort-asc', 'sort-desc'));
    const sortableThs = document.querySelectorAll('th.sortable');
    const idx = ['content', 'priority', 'due', 'assignee'].indexOf(field);
    if (idx >= 0 && sortableThs[idx]) sortableThs[idx].classList.add(sortAsc ? 'sort-asc' : 'sort-desc');

    sortTasks();
    filteredTasks = buildHierarchy(filteredTasks);
    renderTable();
}

function sortTasks() {
    filteredTasks.sort((a, b) => {
        let va, vb;
        switch (sortField) {
            case 'content': va = a.content.toLowerCase(); vb = b.content.toLowerCase(); break;
            case 'priority': va = a.priority; vb = b.priority; return sortAsc ? vb - va : va - vb;
            case 'due': va = a.due ? a.due.date : 'z'; vb = b.due ? b.due.date : 'z'; break;
            case 'assignee': va = getAssigneeName(a).toLowerCase(); vb = getAssigneeName(b).toLowerCase(); break;
            default: va = ''; vb = '';
        }
        if (va < vb) return sortAsc ? -1 : 1;
        if (va > vb) return sortAsc ? 1 : -1;
        return 0;
    });
}

// ── Rendering ──
const PRIORITY_LABELS = { 4: 'P1', 3: 'P2', 2: 'P3', 1: 'P4' };

function getSectionId(task) {
    return task.sectionId || task.section_id || null;
}

function getSectionName(task) {
    const sid = getSectionId(task);
    return sid ? (sections[sid] || '') : '';
}

function getAssigneeName(task) {
    const uid = task.responsibleUid || task.assigneeId || task.assignee_id;
    if (!uid) return '';
    return collaborators[uid] || uid;
}

function renderTable() {
    const tbody = document.getElementById('task-body');
    const noTasks = document.getElementById('no-tasks');
    const taskCount = document.getElementById('task-count');
    const sectionControls = document.getElementById('section-controls');

    if (filteredTasks.length === 0) {
        tbody.innerHTML = '';
        noTasks.classList.remove('hidden');
        taskCount.textContent = '';
        sectionControls.classList.add('hidden');
        return;
    }

    noTasks.classList.add('hidden');

    // Group by section
    const groups = [];
    const groupMap = new Map();
    filteredTasks.forEach(t => {
        const sid = getSectionId(t) || '__none__';
        if (!groupMap.has(sid)) {
            const g = { id: sid, name: sid === '__none__' ? '(Ohne Abschnitt)' : (sections[sid] || 'Unbekannt'), tasks: [] };
            groups.push(g);
            groupMap.set(sid, g);
        }
        groupMap.get(sid).tasks.push(t);
    });

    const hasSections = groups.length > 1 || groups[0]?.id !== '__none__';
    sectionControls.classList.toggle('hidden', !hasSections);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let html = '';
    groups.forEach(group => {
        const isCollapsed = collapsedSections.has(group.id);
        if (hasSections) {
            html += `<tr class="section-header ${isCollapsed ? 'collapsed' : ''}" onclick="toggleSection('${group.id}')">
                <td colspan="7">
                    <span class="section-toggle">&#9660;</span>
                    ${escapeHtml(group.name)}
                    <span class="section-count">(${group.tasks.length})</span>
                </td>
            </tr>`;
        }
        if (!isCollapsed) {
            group.tasks.forEach(t => {
                html += renderTaskRow(t, today);
            });
        }
    });

    tbody.innerHTML = html;
    taskCount.textContent = `${filteredTasks.length} Aufgabe${filteredTasks.length !== 1 ? 'n' : ''} angezeigt`;
}

function renderTaskRow(t, today) {
    const checked = selectedIds.has(t.id) ? 'checked' : '';
    const selectedClass = selectedIds.has(t.id) ? 'selected' : '';
    const depth = t._depth || 0;
    const indent = depth > 0 ? `padding-left: ${depth * 24 + 12}px` : '';
    const hierarchyPrefix = depth > 0 ? '<span class="subtask-indicator">&#x2514; </span>' : '';

    const desc = t.description
        ? `<span class="task-description">${escapeHtml(t.description.substring(0, 80))}${t.description.length > 80 ? '...' : ''}</span>`
        : '';

    const priorityBadge = `<span class="priority-badge priority-${t.priority}">${PRIORITY_LABELS[t.priority] || 'P4'}</span>`;

    let dueHtml = '—';
    if (t.due) {
        const dueDate = new Date(t.due.date);
        const isOverdue = dueDate < today;
        const cls = isOverdue ? 'due-date overdue' : 'due-date';
        dueHtml = `<span class="${cls}">${formatDate(t.due.date)}${isOverdue ? ' !' : ''}</span>`;
    }

    const labels = (t.labels || []).map(l => `<span class="label-tag">${escapeHtml(l)}</span>`).join('');
    const assignee = getAssigneeName(t);

    const isCompleted = t._status === 'completed' || t.is_completed || t.checked;
    const statusChecked = isCompleted ? 'checked' : '';
    const statusCheckbox = `<input type="checkbox" class="status-cb" ${statusChecked} onchange="toggleTaskStatus('${t.id}', this)" title="${isCompleted ? 'Als unerledigt markieren' : 'Als erledigt markieren'}">`;

    return `<tr class="${selectedClass}" data-id="${t.id}">
        <td class="col-check"><input type="checkbox" ${checked} onchange="toggleSelect('${t.id}')"></td>
        <td style="${indent}"><div class="task-content">${hierarchyPrefix}<span>${escapeHtml(t.content)}</span>${desc}</div></td>
        <td class="col-status">${statusCheckbox}</td>
        <td>${priorityBadge}</td>
        <td>${dueHtml}</td>
        <td>${assignee ? escapeHtml(assignee) : '—'}</td>
        <td>${labels || '—'}</td>
    </tr>`;
}

// ── Inline Status Toggle ──
async function toggleTaskStatus(taskId, checkbox) {
    checkbox.disabled = true;
    const projectId = document.getElementById('project-select').value;
    const wasCompleted = !checkbox.checked; // inverted because change already happened

    try {
        if (checkbox.checked) {
            await api('POST', `/tasks/${taskId}/close`);
            showToast('Aufgabe als erledigt markiert.', 'success');
        } else {
            await api('POST', `/tasks/${taskId}/reopen`);
            showToast('Aufgabe als unerledigt markiert.', 'success');
        }
        invalidateCache(projectId);
        await loadTasks(true);
    } catch (e) {
        checkbox.checked = wasCompleted;
        checkbox.disabled = false;
        showToast('Fehler: ' + e.message, 'error');
    }
}

// ── Section Collapse ──
function toggleSection(sectionId) {
    if (collapsedSections.has(sectionId)) {
        collapsedSections.delete(sectionId);
    } else {
        collapsedSections.add(sectionId);
    }
    renderTable();
}

function expandAllSections() {
    collapsedSections.clear();
    renderTable();
}

function collapseAllSections() {
    // Collect all section IDs from current render
    const groups = new Set();
    filteredTasks.forEach(t => {
        groups.add(getSectionId(t) || '__none__');
    });
    groups.forEach(id => collapsedSections.add(id));
    renderTable();
}

// ── Selection ──
function toggleSelect(id) {
    if (selectedIds.has(id)) selectedIds.delete(id);
    else selectedIds.add(id);
    updateSelectionCount();
    const row = document.querySelector(`tr[data-id="${id}"]`);
    if (row) row.classList.toggle('selected', selectedIds.has(id));
    document.getElementById('select-all').checked =
        filteredTasks.length > 0 && selectedIds.size === filteredTasks.length;
}

function toggleSelectAll() {
    const checked = document.getElementById('select-all').checked;
    selectedIds.clear();
    if (checked) filteredTasks.forEach(t => selectedIds.add(t.id));
    updateSelectionCount();
    renderTable();
}

function updateSelectionCount() {
    document.getElementById('selection-count').textContent = `${selectedIds.size} ausgewählt`;
}

// ── Bulk Actions ──
function setActionButtonsDisabled(disabled) {
    document.querySelectorAll('.action-buttons button').forEach(b => b.disabled = disabled);
}

async function reopenSelected() {
    if (selectedIds.size === 0) { showToast('Bitte Aufgaben auswählen.', 'error'); return; }
    const projectId = document.getElementById('project-select').value;
    const ids = [...selectedIds];
    setActionButtonsDisabled(true);

    const { completed, failed } = await parallelLimit(
        ids.map(id => () => api('POST', `/tasks/${id}/reopen`)), 5,
        (done, total) => showProgress(done, total, 'Als unerledigt markieren')
    );

    hideProgress();
    setActionButtonsDisabled(false);
    showToast(failed > 0
        ? `${completed} zurückgesetzt, ${failed} fehlgeschlagen.`
        : `${completed} Aufgabe${completed !== 1 ? 'n' : ''} als unerledigt markiert.`,
        failed > 0 ? 'error' : 'success');

    selectedIds.clear();
    invalidateCache(projectId);
    await loadTasks(true);
}

async function completeSelected() {
    if (selectedIds.size === 0) { showToast('Bitte Aufgaben auswählen.', 'error'); return; }
    const projectId = document.getElementById('project-select').value;
    const ids = [...selectedIds];
    setActionButtonsDisabled(true);

    const { completed, failed } = await parallelLimit(
        ids.map(id => () => api('POST', `/tasks/${id}/close`)), 5,
        (done, total) => showProgress(done, total, 'Als erledigt markieren')
    );

    hideProgress();
    setActionButtonsDisabled(false);
    showToast(failed > 0
        ? `${completed} erledigt, ${failed} fehlgeschlagen.`
        : `${completed} Aufgabe${completed !== 1 ? 'n' : ''} als erledigt markiert.`,
        failed > 0 ? 'error' : 'success');

    selectedIds.clear();
    invalidateCache(projectId);
    await loadTasks(true);
}

// ── Helpers ──
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function formatDate(dateStr) {
    const d = new Date(dateStr);
    return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function showToast(msg, type = '') {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.className = 'toast';
    if (type) toast.classList.add(`toast-${type}`);
    toast.classList.remove('hidden');
    clearTimeout(toast._timeout);
    toast._timeout = setTimeout(() => toast.classList.add('hidden'), 3500);
}

// ── Init ──
document.getElementById('token-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') connect();
});

(function () {
    const cached = localStorage.getItem('todoist_token');
    if (cached) {
        document.getElementById('token-input').value = cached;
        connect();
    }
})();
