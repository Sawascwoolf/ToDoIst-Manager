const API_BASE = 'https://api.todoist.com/rest/v2';
const SYNC_BASE = 'https://api.todoist.com/sync/v9';

let token = '';
let allTasks = [];
let filteredTasks = [];
let sections = {};
let selectedIds = new Set();
let sortField = 'content';
let sortAsc = true;

// ── API Helpers ──

async function api(method, path, body = null, base = API_BASE) {
    const headers = {
        'Authorization': `Bearer ${token}`,
    };
    if (body) {
        headers['Content-Type'] = 'application/json';
    }
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${base}${path}`, opts);
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`API ${res.status}: ${text}`);
    }
    if (res.status === 204) return null;
    return res.json();
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
            } else if (res.status === 0) {
                errEl.textContent = 'Netzwerkfehler: Die Anfrage wurde blockiert (CORS oder keine Internetverbindung).';
            } else {
                errEl.textContent = `API-Fehler HTTP ${res.status}: ${body.substring(0, 200)}`;
            }
            errEl.classList.remove('hidden');
            return;
        }

        const projects = await res.json();
        const select = document.getElementById('project-select');
        select.innerHTML = '<option value="">-- Projekt wählen --</option>';
        projects.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = p.name;
            select.appendChild(opt);
        });
        document.getElementById('project-section').classList.remove('hidden');
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
        const isCompleted = statusFilter === 'completed';

        let tasks;
        if (isCompleted) {
            tasks = await loadCompletedTasks(projectId);
        } else {
            tasks = await api('GET', `/tasks?project_id=${projectId}`);
        }

        // Load sections for this project
        const sectionList = await api('GET', `/sections?project_id=${projectId}`);
        sections = {};
        sectionList.forEach(s => { sections[s.id] = s.name; });

        allTasks = tasks;
        populateLabelFilter(tasks);
        applyFilters();
    } catch (e) {
        showToast('Fehler beim Laden: ' + e.message, 'error');
    } finally {
        loading.classList.add('hidden');
    }
}

async function loadCompletedTasks(projectId) {
    try {
        const res = await fetch(`${SYNC_BASE}/completed/get_all?project_id=${projectId}&limit=200`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`Sync API ${res.status}`);
        const data = await res.json();
        return (data.items || []).map(item => ({
            id: item.task_id,
            content: item.content,
            description: '',
            priority: 1,
            labels: [],
            due: null,
            section_id: item.section_id || null,
            is_completed: true,
        }));
    } catch (e) {
        showToast('Fehler beim Laden erledigter Aufgaben: ' + e.message, 'error');
        return [];
    }
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

    // Update header icons
    document.querySelectorAll('th.sortable').forEach(th => {
        th.classList.remove('sort-asc', 'sort-desc');
    });
    const headers = { content: 0, priority: 1, due: 2, section: 3 };
    const sortableThs = document.querySelectorAll('th.sortable');
    const idx = Object.keys(headers).indexOf(field);
    if (idx >= 0 && sortableThs[idx]) {
        sortableThs[idx].classList.add(sortAsc ? 'sort-asc' : 'sort-desc');
    }

    sortTasks();
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
                va = sections[a.section_id] || '';
                vb = sections[b.section_id] || '';
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
        const sectionName = sections[t.section_id] ? escapeHtml(sections[t.section_id]) : '—';

        return `<tr class="${selectedClass}" data-id="${t.id}">
            <td class="col-check"><input type="checkbox" ${checked} onchange="toggleSelect('${t.id}')"></td>
            <td><div class="task-content"><span>${escapeHtml(t.content)}</span>${desc}</div></td>
            <td>${priorityBadge}</td>
            <td>${dueHtml}</td>
            <td>${labels || '—'}</td>
            <td>${sectionName}</td>
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
    // Update row highlight
    const row = document.querySelector(`tr[data-id="${id}"]`);
    if (row) row.classList.toggle('selected', selectedIds.has(id));
    // Update select-all checkbox
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

async function reopenSelected() {
    if (selectedIds.size === 0) {
        showToast('Bitte zuerst Aufgaben auswählen.', 'error');
        return;
    }

    const count = selectedIds.size;
    const ids = [...selectedIds];

    showToast(`${count} Aufgabe${count !== 1 ? 'n' : ''} werden als unerledigt markiert...`);

    let success = 0;
    let failed = 0;

    for (const id of ids) {
        try {
            await api('POST', `/tasks/${id}/reopen`);
            success++;
        } catch (e) {
            failed++;
        }
    }

    if (failed > 0) {
        showToast(`${success} zurückgesetzt, ${failed} fehlgeschlagen.`, 'error');
    } else {
        showToast(`${success} Aufgabe${success !== 1 ? 'n' : ''} als unerledigt markiert.`, 'success');
    }

    selectedIds.clear();
    await loadTasks();
}

async function completeSelected() {
    if (selectedIds.size === 0) {
        showToast('Bitte zuerst Aufgaben auswählen.', 'error');
        return;
    }

    const count = selectedIds.size;
    const ids = [...selectedIds];

    showToast(`${count} Aufgabe${count !== 1 ? 'n' : ''} werden als erledigt markiert...`);

    let success = 0;
    let failed = 0;

    for (const id of ids) {
        try {
            await api('POST', `/tasks/${id}/close`);
            success++;
        } catch (e) {
            failed++;
        }
    }

    if (failed > 0) {
        showToast(`${success} erledigt, ${failed} fehlgeschlagen.`, 'error');
    } else {
        showToast(`${success} Aufgabe${success !== 1 ? 'n' : ''} als erledigt markiert.`, 'success');
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
