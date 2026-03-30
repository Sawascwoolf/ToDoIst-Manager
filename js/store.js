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
};

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
