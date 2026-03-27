const API_BASE = 'https://api.todoist.com/api/v1';

let token = '';
let allTasks = [];
let filteredTasks = [];
let sections = {};
let selectedIds = new Set();
let sortField = 'content';
let sortAsc = true;

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

// Fetch all pages for paginated endpoints (returns flat array)
async function apiPaginated(path) {
    let allResults = [];
    let cursor = null;
    const separator = path.includes('?') ? '&' : '?';

    do {
        const url = cursor ? `${path}${separator}cursor=${cursor}` : path;
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
            if (onProgress) onProgress(completed + failed, tasks.length, completed, failed);
        }
    }

    const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => runNext());
    await Promise.all(workers);
    return { completed, failed };
}

// ── Progress Bar ──

function showProgress(current, total, label) {
    let bar = document.getElementById('progress-bar');
    if (!bar) return;
    bar.classList.remove('hidden');
    const pct = Math.round((current / total) * 100);
    bar.querySelector('.progress-fill').style.width = pct + '%';
    bar.querySelector('.progress-text').textContent = `${label}: ${current} / ${total}`;
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

async function loadTasks() {
    const projectId = document.getElementById('project-select').value;
    if (!projectId) return;

    const filterSection = document.getElementById('filter-section');
    const taskSection = document.getElementById('task-section');
    const loading = document.getElementById('loading');

    filterSection.classList.remove('hidden');
    taskSection.classList.remove('hidden');
    loading.classList.remove('hidden');
    document.getElementById('task-body').innerHTML = '';
    document.getElementById('no-tasks').classList.add('hidden');

    try {
        const statusFilter = document.getElementById('filter-status').value;

        // Load sections in parallel with tasks
        const sectionsPromise = apiPaginated(`/sections?project_id=${projectId}`);

        let openTasks = [];
        let completedTasks = [];

        if (statusFilter === 'completed') {
            completedTasks = await loadCompletedTasks(projectId);
        } else if (statusFilter === 'all') {
            [openTasks, completedTasks] = await Promise.all([
                apiPaginated(`/tasks?project_id=${projectId}`),
                loadCompletedTasks(projectId),
            ]);
        } else {
            openTasks = await apiPaginated(`/tasks?project_id=${projectId}`);
        }

        // Mark open tasks explicitly
        openTasks.forEach(t => { t._status = 'open'; });
        completedTasks.forEach(t => { t._status = 'completed'; });

        const sectionList = await sectionsPromise;
        sections = {};
        sectionList.forEach(s => { sections[s.id] = s.name; });

        allTasks = [...openTasks, ...completedTasks];
        populateLabelFilter(allTasks);
        applyFilters();
    } catch (e) {
        showToast('Fehler beim Laden: ' + e.message, 'error');
    } finally {
        loading.classList.add('hidden');
    }
}

async function loadCompletedTasks(projectId) {
    try {
        const data = await api('GET', `/tasks/completed?project_id=${projectId}&limit=200`);
        const items = data.items || data.results || [];
        return items.map(item => ({
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
    } catch (e) {
        showToast('Fehler beim Laden erledigter Aufgaben: ' + e.message, 'error');
        return [];
    }
}

// ── Hierarchy ──

function buildHierarchy(tasks) {
    const taskMap = new Map();
    tasks.forEach(t => taskMap.set(t.id, t));

    // Calculate depth for each task
    tasks.forEach(t => {
        let depth = 0;
        let current = t;
        const parentKey = current.parentId || current.parent_id;
        let pid = parentKey;
        while (pid && taskMap.has(pid)) {
            depth++;
            current = taskMap.get(pid);
            pid = current.parentId || current.parent_id;
        }
        t._depth = depth;
    });

    // Sort: parents first, then children in order, preserving existing sort
    const roots = tasks.filter(t => t._depth === 0);
    const children = tasks.filter(t => t._depth > 0);

    // Group children by parent
    const childrenByParent = new Map();
    children.forEach(c => {
        const pid = c.parentId || c.parent_id;
        if (!childrenByParent.has(pid)) childrenByParent.set(pid, []);
        childrenByParent.get(pid).push(c);
    });

    // Flatten tree in order
    const result = [];
    function addWithChildren(task) {
        result.push(task);
        const kids = childrenByParent.get(task.id) || [];
        kids.forEach(kid => addWithChildren(kid));
    }
    roots.forEach(r => addWithChildren(r));

    // Add orphaned children (parent not in current list)
    children.forEach(c => {
        if (!result.includes(c)) {
            c._depth = 0; // treat as root if parent not visible
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
    const idx = ['content', 'priority', 'due', 'section'].indexOf(field);
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

    const ids = [...selectedIds];
    const total = ids.length;
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
    await loadTasks();
}

async function completeSelected() {
    if (selectedIds.size === 0) {
        showToast('Bitte zuerst Aufgaben auswählen.', 'error');
        return;
    }

    const ids = [...selectedIds];
    const total = ids.length;
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
    await loadTasks();
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

// Re-load tasks when status filter changes
document.getElementById('filter-status').addEventListener('change', () => {
    const projectId = document.getElementById('project-select').value;
    if (projectId) loadTasks();
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
