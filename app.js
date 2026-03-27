const API_BASE = 'https://api.todoist.com/api/v1';

let token = '';
let allTasks = [];
let filteredTasks = [];
let sections = {};
let collaborators = {}; // userId -> name
let selectedIds = new Set();
let sortField = 'content';
let sortAsc = true;

// ── Task Cache ──
// Cache per project: { projectId: { open: [...], completed: [...], sections: {...}, ts: Date } }
const taskCache = {};
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCached(projectId, statusFilter) {
    const entry = taskCache[projectId];
    if (!entry) return null;
    if (Date.now() - entry.ts > CACHE_TTL) return null;
    if (statusFilter === 'open' && entry.open) return entry;
    if (statusFilter === 'completed' && entry.completed) return entry;
    if (statusFilter === 'all' && entry.open && entry.completed) return entry;
    return null;
}

function invalidateCache(projectId) {
    delete taskCache[projectId];
}

// ── API Helpers ──

async function api(method, path, body = null) {
    const headers = {
        'Authorization': `Bearer ${token}`,
    };
    if (body) {
        headers['Content-Type'] = 'application/json';
    }
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

// Fetch all pages for paginated cursor-based endpoints
async function apiPaginated(path) {
    let allResults = [];
    let cursor = null;
    const separator = path.includes('?') ? '&' : '?';

    do {
        let url = cursor ? `${path}${separator}cursor=${cursor}` : path;
        // Request maximum page size if not already specified
        if (!url.includes('limit=')) {
            url += (url.includes('?') ? '&' : '?') + 'limit=200';
        }
        const data = await api('GET', url);

        if (Array.isArray(data)) {
            allResults = allResults.concat(data);
            break;
        }

        allResults = allResults.concat(data.results || []);
        cursor = data.nextCursor || null;
    } while (cursor);

    return allResults;
}

// Fetch all completed tasks with offset-based pagination
async function fetchAllCompletedTasks(projectId) {
    let allItems = [];
    let offset = 0;
    const pageSize = 200;

    do {
        const data = await api('GET', `/tasks/completed?projectId=${projectId}&limit=${pageSize}&offset=${offset}`);
        const items = data.items || data.results || [];
        allItems = allItems.concat(items);
        // If we got fewer than pageSize, we've reached the end
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
        _status: 'completed',
    }));
}

// Run promises in parallel with concurrency limit
async function parallelLimit(tasks, limit, onProgress) {
    let completed = 0;
    let failed = 0;
    const results = [];
    let index = 0;

    async function runNext() {
        while (index < tasks.length) {
            const i = index++;
            try {
                results[i] = await tasks[i]();
                completed++;
            } catch (e) {
                results[i] = e;
                failed++;
            }
            if (onProgress) await onProgress(completed + failed, tasks.length, completed, failed);
        }
    }

    const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => runNext());
    await Promise.all(workers);
    return { completed, failed };
}

// ── Progress Bar ──

async function showProgress(current, total, label) {
    let bar = document.getElementById('progress-bar');
    if (!bar) return;
    bar.classList.remove('hidden');
    const pct = Math.round((current / total) * 100);
    bar.querySelector('.progress-fill').style.width = pct + '%';
    bar.querySelector('.progress-text').textContent = `${label}: ${current} / ${total}`;
    // Yield to browser so it can repaint
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
}

function hideProgress() {
    const bar = document.getElementById('progress-bar');
    if (bar) bar.classList.add('hidden');
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
                errEl.textContent = `Authentifizierung fehlgeschlagen (HTTP ${res.status}). Der Token ist ungültig oder abgelaufen.`;
            } else if (res.status === 410) {
                errEl.textContent = `API-Endpunkt nicht mehr verfügbar (HTTP 410). Die API-Version wurde möglicherweise geändert.`;
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
            errEl.textContent = 'Netzwerkfehler: Keine Verbindung zu api.todoist.com möglich. Prüfe deine Internetverbindung oder ob ein Adblocker/Firewall die Anfrage blockiert.';
        } else {
            errEl.textContent = `Unerwarteter Fehler: ${e.message}`;
        }
        errEl.classList.remove('hidden');
        console.error('Todoist connect error:', e);
    }
}

// ── Load Tasks ──

async function loadTasks(forceRefresh = false) {
    const projectId = document.getElementById('project-select').value;
    if (!projectId) return;

    const filterSection = document.getElementById('filter-section');
    const taskSection = document.getElementById('task-section');
    const loading = document.getElementById('loading');
    const statusFilter = document.getElementById('filter-status').value;

    // Check cache first
    if (!forceRefresh) {
        const cached = getCached(projectId, statusFilter);
        if (cached) {
            sections = cached.sections;
            collaborators = cached.collaborators || {};
            let tasks = [];
            if (statusFilter === 'open') tasks = cached.open;
            else if (statusFilter === 'completed') tasks = cached.completed;
            else tasks = [...(cached.open || []), ...(cached.completed || [])];
            allTasks = tasks;
            filterSection.classList.remove('hidden');
            taskSection.classList.remove('hidden');
            populateLabelFilter(allTasks);
            applyFilters();
            showToast(`${allTasks.length} Aufgaben (aus Cache).`, 'success');
            return;
        }
    }

    filterSection.classList.remove('hidden');
    taskSection.classList.remove('hidden');
    loading.classList.remove('hidden');
    document.getElementById('task-body').innerHTML = '';
    document.getElementById('no-tasks').classList.add('hidden');

    try {
        // Always load both open + completed so we can cache everything
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
        collaborators = collabs;

        // Store in cache
        taskCache[projectId] = {
            open: openTasks,
            completed: completedTasks,
            sections: secs,
            collaborators: collabs,
            ts: Date.now(),
        };

        // Apply status filter from cached data
        if (statusFilter === 'open') allTasks = openTasks;
        else if (statusFilter === 'completed') allTasks = completedTasks;
        else allTasks = [...openTasks, ...completedTasks];

        populateLabelFilter(allTasks);
        applyFilters();
        showToast(`${openTasks.length} offene + ${completedTasks.length} erledigte Aufgaben geladen.`, 'success');
    } catch (e) {
        showToast('Fehler beim Laden: ' + e.message, 'error');
    } finally {
        loading.classList.add('hidden');
    }
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
    const children = tasks.filter(t => t._depth > 0);

    const childrenByParent = new Map();
    children.forEach(c => {
        const pid = c.parentId || c.parent_id;
        if (!childrenByParent.has(pid)) childrenByParent.set(pid, []);
        childrenByParent.get(pid).push(c);
    });

    const result = [];
    function addWithChildren(task) {
        result.push(task);
        const kids = childrenByParent.get(task.id) || [];
        kids.forEach(kid => addWithChildren(kid));
    }
    roots.forEach(r => addWithChildren(r));

    children.forEach(c => {
        if (!result.includes(c)) {
            c._depth = 0;
            result.push(c);
        }
    });

    return result;
}

// ── Filters ──

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

function applyFilters() {
    const search = document.getElementById('filter-search').value.toLowerCase();
    const priority = document.getElementById('filter-priority').value;
    const label = document.getElementById('filter-label').value;
    const due = document.getElementById('filter-due').value;
    const statusFilter = document.getElementById('filter-status').value;

    // Re-slice from cache if status changed
    const projectId = document.getElementById('project-select').value;
    const cached = projectId ? taskCache[projectId] : null;
    if (cached) {
        if (statusFilter === 'open') allTasks = cached.open || [];
        else if (statusFilter === 'completed') allTasks = cached.completed || [];
        else allTasks = [...(cached.open || []), ...(cached.completed || [])];
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const weekEnd = new Date(today);
    weekEnd.setDate(weekEnd.getDate() + 7);

    filteredTasks = allTasks.filter(t => {
        if (search && !t.content.toLowerCase().includes(search) &&
            !(t.description || '').toLowerCase().includes(search)) return false;

        if (priority && String(t.priority) !== priority) return false;

        if (label && !(t.labels || []).includes(label)) return false;

        if (due) {
            const dueDate = t.due ? new Date(t.due.date) : null;
            if (due === 'nodue' && dueDate) return false;
            if (due === 'overdue' && (!dueDate || dueDate >= today)) return false;
            if (due === 'today' && (!dueDate || dueDate.toDateString() !== today.toDateString())) return false;
            if (due === 'week' && (!dueDate || dueDate < today || dueDate > weekEnd)) return false;
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
    if (sortField === field) {
        sortAsc = !sortAsc;
    } else {
        sortField = field;
        sortAsc = true;
    }

    document.querySelectorAll('th.sortable').forEach(th => {
        th.classList.remove('sort-asc', 'sort-desc');
    });
    const sortableThs = document.querySelectorAll('th.sortable');
    const idx = ['content', 'priority', 'due', 'assignee', 'section'].indexOf(field);
    if (idx >= 0 && sortableThs[idx]) {
        sortableThs[idx].classList.add(sortAsc ? 'sort-asc' : 'sort-desc');
    }

    sortTasks();
    filteredTasks = buildHierarchy(filteredTasks);
    renderTable();
}

function sortTasks() {
    filteredTasks.sort((a, b) => {
        let va, vb;
        switch (sortField) {
            case 'content':
                va = a.content.toLowerCase();
                vb = b.content.toLowerCase();
                break;
            case 'priority':
                va = a.priority;
                vb = b.priority;
                return sortAsc ? vb - va : va - vb;
            case 'due':
                va = a.due ? a.due.date : 'z';
                vb = b.due ? b.due.date : 'z';
                break;
            case 'assignee':
                va = getAssigneeName(a).toLowerCase();
                vb = getAssigneeName(b).toLowerCase();
                break;
            case 'section':
                va = sections[a.sectionId] || sections[a.section_id] || '';
                vb = sections[b.sectionId] || sections[b.section_id] || '';
                break;
            default:
                va = '';
                vb = '';
        }
        if (va < vb) return sortAsc ? -1 : 1;
        if (va > vb) return sortAsc ? 1 : -1;
        return 0;
    });
}

// ── Rendering ──

const PRIORITY_LABELS = { 4: 'P1', 3: 'P2', 2: 'P3', 1: 'P4' };

function getSectionName(task) {
    return sections[task.sectionId] || sections[task.section_id] || '';
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

    if (filteredTasks.length === 0) {
        tbody.innerHTML = '';
        noTasks.classList.remove('hidden');
        taskCount.textContent = '';
        return;
    }

    noTasks.classList.add('hidden');

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    tbody.innerHTML = filteredTasks.map(t => {
        const checked = selectedIds.has(t.id) ? 'checked' : '';
        const selectedClass = selectedIds.has(t.id) ? 'selected' : '';
        const depth = t._depth || 0;
        const indent = depth > 0 ? `padding-left: ${depth * 24 + 12}px` : '';

        const desc = t.description
            ? `<span class="task-description">${escapeHtml(t.description.substring(0, 80))}${t.description.length > 80 ? '...' : ''}</span>`
            : '';

        const hierarchyPrefix = depth > 0 ? '<span class="subtask-indicator">&#x2514; </span>' : '';

        const priorityBadge = `<span class="priority-badge priority-${t.priority}">${PRIORITY_LABELS[t.priority] || 'P4'}</span>`;

        let dueHtml = '—';
        if (t.due) {
            const dueDate = new Date(t.due.date);
            const isOverdue = dueDate < today;
            const cls = isOverdue ? 'due-date overdue' : 'due-date';
            dueHtml = `<span class="${cls}">${formatDate(t.due.date)}${isOverdue ? ' !' : ''}</span>`;
        }

        const labels = (t.labels || []).map(l => `<span class="label-tag">${escapeHtml(l)}</span>`).join('');
        const sectionName = getSectionName(t);
        const assignee = getAssigneeName(t);

        const isCompleted = t._status === 'completed' || t.is_completed || t.checked;
        const statusBadge = isCompleted
            ? '<span class="status-badge status-completed">Erledigt</span>'
            : '<span class="status-badge status-open">Offen</span>';

        return `<tr class="${selectedClass}" data-id="${t.id}">
            <td class="col-check"><input type="checkbox" ${checked} onchange="toggleSelect('${t.id}')"></td>
            <td style="${indent}"><div class="task-content">${hierarchyPrefix}<span>${escapeHtml(t.content)}</span>${desc}</div></td>
            <td>${statusBadge}</td>
            <td>${priorityBadge}</td>
            <td>${dueHtml}</td>
            <td>${assignee ? escapeHtml(assignee) : '—'}</td>
            <td>${labels || '—'}</td>
            <td>${sectionName ? escapeHtml(sectionName) : '—'}</td>
        </tr>`;
    }).join('');

    taskCount.textContent = `${filteredTasks.length} Aufgabe${filteredTasks.length !== 1 ? 'n' : ''} angezeigt`;
}

// ── Selection ──

function toggleSelect(id) {
    if (selectedIds.has(id)) {
        selectedIds.delete(id);
    } else {
        selectedIds.add(id);
    }
    updateSelectionCount();
    const row = document.querySelector(`tr[data-id="${id}"]`);
    if (row) row.classList.toggle('selected', selectedIds.has(id));
    document.getElementById('select-all').checked =
        filteredTasks.length > 0 && selectedIds.size === filteredTasks.length;
}

function toggleSelectAll() {
    const checked = document.getElementById('select-all').checked;
    selectedIds.clear();
    if (checked) {
        filteredTasks.forEach(t => selectedIds.add(t.id));
    }
    updateSelectionCount();
    renderTable();
}

function updateSelectionCount() {
    document.getElementById('selection-count').textContent = `${selectedIds.size} ausgewählt`;
}

// ── Actions ──

function setActionButtonsDisabled(disabled) {
    document.querySelectorAll('.action-buttons button').forEach(b => b.disabled = disabled);
}

async function reopenSelected() {
    if (selectedIds.size === 0) {
        showToast('Bitte zuerst Aufgaben auswählen.', 'error');
        return;
    }

    const projectId = document.getElementById('project-select').value;
    const ids = [...selectedIds];
    setActionButtonsDisabled(true);

    const tasks = ids.map(id => () => api('POST', `/tasks/${id}/reopen`));

    const { completed, failed } = await parallelLimit(tasks, 5, (done, total, ok, err) => {
        showProgress(done, total, 'Als unerledigt markieren');
    });

    hideProgress();
    setActionButtonsDisabled(false);

    if (failed > 0) {
        showToast(`${completed} zurückgesetzt, ${failed} fehlgeschlagen.`, 'error');
    } else {
        showToast(`${completed} Aufgabe${completed !== 1 ? 'n' : ''} als unerledigt markiert.`, 'success');
    }

    selectedIds.clear();
    invalidateCache(projectId);
    await loadTasks(true);
}

async function completeSelected() {
    if (selectedIds.size === 0) {
        showToast('Bitte zuerst Aufgaben auswählen.', 'error');
        return;
    }

    const projectId = document.getElementById('project-select').value;
    const ids = [...selectedIds];
    setActionButtonsDisabled(true);

    const tasks = ids.map(id => () => api('POST', `/tasks/${id}/close`));

    const { completed, failed } = await parallelLimit(tasks, 5, (done, total, ok, err) => {
        showProgress(done, total, 'Als erledigt markieren');
    });

    hideProgress();
    setActionButtonsDisabled(false);

    if (failed > 0) {
        showToast(`${completed} erledigt, ${failed} fehlgeschlagen.`, 'error');
    } else {
        showToast(`${completed} Aufgabe${completed !== 1 ? 'n' : ''} als erledigt markiert.`, 'success');
    }

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

// Status filter: switch from cache without re-fetching
document.getElementById('filter-status').addEventListener('change', () => {
    const projectId = document.getElementById('project-select').value;
    if (!projectId) return;
    // If we have cache, just re-apply filters (no API call)
    const cached = taskCache[projectId];
    if (cached) {
        applyFilters();
    } else {
        loadTasks();
    }
});

// Allow connecting with Enter key
document.getElementById('token-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') connect();
});

// Auto-connect with cached token
(function () {
    const cached = localStorage.getItem('todoist_token');
    if (cached) {
        document.getElementById('token-input').value = cached;
        connect();
    }
})();
