// ── Shared State ──
const S = {
    token: '',
    allTasks: [],
    filteredTasks: [],
    sections: {},
    collaborators: {},
    selectedIds: new Set(),
    sortField: 'content',
    sortAsc: true,
    collapsedIds: new Set(),
    ctxTaskId: null,
    currentProjectId: null,
    undoFn: null,
    groupBySection: true,
    showHierarchy: true,
    searchExtraTasks: [],
};

// ── View Configs (5 slots, persisted in localStorage) ──
const VIEW_STORAGE_KEY = 'todoist_views';
const MAX_VIEWS = 5;

function getViewConfigs() {
    try { return JSON.parse(localStorage.getItem(VIEW_STORAGE_KEY)) || []; }
    catch { return []; }
}

function saveViewConfigs(configs) {
    localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify(configs.slice(0, MAX_VIEWS)));
}

function captureCurrentView() {
    return {
        search: document.getElementById('filter-search').value,
        label: document.getElementById('filter-label').value,
        statuses: getActiveValues('filter-status-toggles'),
        priorities: getActiveValues('filter-priority-toggles'),
        assignees: getActiveValues('filter-assignee-toggles'),
        sortField: S.sortField,
        sortAsc: S.sortAsc,
        groupBySection: S.groupBySection,
        showHierarchy: S.showHierarchy,
    };
}

function restoreView(cfg) {
    document.getElementById('filter-search').value = cfg.search || '';
    document.getElementById('filter-label').value = cfg.label || '';

    setToggles('filter-status-toggles', cfg.statuses);
    setToggles('filter-priority-toggles', cfg.priorities);
    setToggles('filter-assignee-toggles', cfg.assignees);

    S.sortField = cfg.sortField || 'content';
    S.sortAsc = cfg.sortAsc !== false;
    S.groupBySection = cfg.groupBySection !== false;
    S.showHierarchy = cfg.showHierarchy !== false;

    document.querySelectorAll('th.sortable').forEach(th => th.classList.remove('sort-asc', 'sort-desc'));
    const ths = document.querySelectorAll('th.sortable');
    const idx = ['content', 'priority', 'due', 'assignee'].indexOf(S.sortField);
    if (idx >= 0 && ths[idx]) ths[idx].classList.add(S.sortAsc ? 'sort-asc' : 'sort-desc');

    updateGroupToggleUI();
    updateHierarchyToggleUI();
    applyFilters();
}

function setToggles(containerId, values) {
    if (!values) return;
    const btns = document.querySelectorAll(`#${containerId} .toggle-btn:not([data-value="__select_all__"])`);
    btns.forEach(b => b.classList.toggle('active', values.includes(b.dataset.value)));
}

function updateGroupToggleUI() {
    const btn = document.getElementById('group-toggle');
    if (btn) btn.classList.toggle('active', S.groupBySection);
}

function updateHierarchyToggleUI() {
    const btn = document.getElementById('hierarchy-toggle');
    if (btn) btn.classList.toggle('active', S.showHierarchy);
}

// ── Cache ──
const taskCache = {};
const CACHE_TTL = 5 * 60 * 1000;

function getCached(pid) {
    const e = taskCache[pid];
    return e && Date.now() - e.ts < CACHE_TTL ? e : null;
}

function invalidateCache(pid) { delete taskCache[pid]; }

function deduplicateTasks(open, completed) {
    const seen = new Set();
    const result = [];
    [...open, ...completed].forEach(t => {
        if (!seen.has(t.id)) { seen.add(t.id); result.push(t); }
    });
    return result;
}

function updateTaskStatusLocally(taskId, newStatus) {
    const pid = S.currentProjectId;
    const cache = taskCache[pid];
    if (!cache) return;

    if (newStatus === 'completed') {
        const idx = cache.open.findIndex(t => t.id === taskId);
        if (idx >= 0) {
            const task = cache.open.splice(idx, 1)[0];
            task._status = 'completed';
            cache.completed.push(task);
        }
    } else {
        const idx = cache.completed.findIndex(t => t.id === taskId);
        if (idx >= 0) {
            const task = cache.completed.splice(idx, 1)[0];
            task._status = 'open';
            cache.open.push(task);
        }
    }

    const task = S.allTasks.find(t => t.id === taskId);
    if (task) task._status = newStatus;
}
