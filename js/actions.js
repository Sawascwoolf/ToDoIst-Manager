// ── Context Actions ──
async function ctxAction(action, value) {
    const id = S.ctxTaskId;
    hideCtxMenu();
    if (!id) return;
    const task = S.allTasks.find(t => t.id === id);
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
            invalidateCache(S.currentProjectId);
            showToast(`Priorität → ${PRIO[value]}`, 'success', oldPrio != null ? async () => {
                await api('POST', `/tasks/${id}`, { priority: oldPrio });
                if (task) task.priority = oldPrio;
                invalidateCache(S.currentProjectId);
                applyFilters();
            } : null);
        } else if (action === 'assignee') {
            const oldUid = task ? (task.responsible_uid || task.responsibleUid || task.assignee_id || task.assigneeId || null) : null;
            const body = value ? { responsible_uid: value } : { responsible_uid: null };
            await api('POST', `/tasks/${id}`, body);
            if (task) { task.responsible_uid = value; task.responsibleUid = value; task.assignee_id = value; }
            invalidateCache(S.currentProjectId);
            const name = value ? (S.collaborators[value] || value) : 'Niemand';
            showToast(`Verantwortlich: ${name}`, 'success', async () => {
                await api('POST', `/tasks/${id}`, { responsible_uid: oldUid });
                if (task) { task.responsible_uid = oldUid; task.responsibleUid = oldUid; task.assignee_id = oldUid; }
                invalidateCache(S.currentProjectId);
                applyFilters();
            });
        } else if (action === 'removeLabel') {
            if (!task) return;
            const oldLabels = [...(task.labels || [])];
            const newLabels = oldLabels.filter(l => l !== value);
            await api('POST', `/tasks/${id}`, { labels: newLabels });
            task.labels = newLabels;
            invalidateCache(S.currentProjectId);
            showToast(`Label "${value}" entfernt.`, 'success', async () => {
                await api('POST', `/tasks/${id}`, { labels: oldLabels });
                task.labels = oldLabels;
                invalidateCache(S.currentProjectId);
                applyFilters();
            });
        } else if (action === 'addLabel') {
            if (!task || !value || !value.trim()) return;
            value = value.trim();
            const oldLabels = [...(task.labels || [])];
            if (oldLabels.includes(value)) { showToast(`Label "${value}" bereits vorhanden.`, 'error'); return; }
            const newLabels = [...oldLabels, value];
            await api('POST', `/tasks/${id}`, { labels: newLabels });
            task.labels = newLabels;
            invalidateCache(S.currentProjectId);
            showToast(`Label "${value}" hinzugefügt.`, 'success', async () => {
                await api('POST', `/tasks/${id}`, { labels: oldLabels });
                task.labels = oldLabels;
                invalidateCache(S.currentProjectId);
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
            const body = { content: task.content, project_id: S.currentProjectId, priority: task.priority };
            if (task.description) body.description = task.description;
            if (task.labels && task.labels.length) body.labels = task.labels;
            if (task.due) body.due_date = task.due.date;
            if (task.parent_id || task.parentId) body.parent_id = task.parent_id || task.parentId;
            if (task.section_id || task.sectionId) body.section_id = task.section_id || task.sectionId;
            await api('POST', '/tasks', body);
            invalidateCache(S.currentProjectId);
            await loadTasks(true);
            showToast('Aufgabe dupliziert.', 'success');
        } else if (action === 'delete') {
            await api('DELETE', `/tasks/${id}`);
            S.allTasks = S.allTasks.filter(t => t.id !== id);
            invalidateCache(S.currentProjectId);
            showToast('Aufgabe gelöscht.', 'success');
        } else if (action === 'openTodoist') {
            window.open(todoistUrl(id), '_blank');
            return;
        }
        applyFilters();
    } catch (e) { showToast('Fehler: ' + e.message, 'error'); }
}

// ── Inline status toggle ──
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
    S.selectedIds.has(id) ? S.selectedIds.delete(id) : S.selectedIds.add(id);
    updateSelectionUI();
    const row = document.querySelector(`tr[data-id="${id}"]`);
    if (row) row.classList.toggle('selected', S.selectedIds.has(id));
}

function toggleSelectAll() {
    const ch = document.getElementById('select-all').checked;
    S.selectedIds.clear();
    if (ch) S.filteredTasks.forEach(t => S.selectedIds.add(t.id));
    updateSelectionUI();
    renderTable();
}

function updateSelectionUI() {
    const n = S.selectedIds.size;
    document.getElementById('selection-count').textContent = n > 0 ? `${n} ausgewählt` : '';
    document.getElementById('select-all').checked = S.filteredTasks.length > 0 && n === S.filteredTasks.length;
}

// ── Bulk Actions ──
async function reopenSelected() {
    if (!S.selectedIds.size) return;
    const ids = [...S.selectedIds];
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
    S.selectedIds.clear();
    applyFilters();
}

async function completeSelected() {
    if (!S.selectedIds.size) return;
    const ids = [...S.selectedIds];
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
    S.selectedIds.clear();
    applyFilters();
}

// ── Bulk: Priority ──
async function bulkSetPriority(prio) {
    hideListMenu();
    if (!S.selectedIds.size) return;
    const ids = [...S.selectedIds];
    const oldPrios = {};
    ids.forEach(id => { const t = S.allTasks.find(x => x.id === id); if (t) oldPrios[id] = t.priority; });
    const { completed, failed } = await parallelLimit(
        ids.map(id => () => api('POST', `/tasks/${id}`, { priority: prio })), 5,
        (d, t) => showProgress(d, t, 'Priorität'));
    hideProgress();
    ids.forEach(id => { const t = S.allTasks.find(x => x.id === id); if (t) t.priority = prio; });
    invalidateCache(S.currentProjectId);
    showToast(`${completed} → ${PRIO[prio]}`, failed ? 'error' : 'success', !failed ? async () => {
        await parallelLimit(ids.map(id => () => api('POST', `/tasks/${id}`, { priority: oldPrios[id] || 1 })), 5);
        ids.forEach(id => { const t = S.allTasks.find(x => x.id === id); if (t) t.priority = oldPrios[id] || 1; });
        invalidateCache(S.currentProjectId);
        applyFilters();
    } : null);
    S.selectedIds.clear();
    applyFilters();
}

// ── Bulk: Assignee ──
async function bulkSetAssignee(uid) {
    hideListMenu();
    if (!S.selectedIds.size) return;
    const ids = [...S.selectedIds];
    const body = uid ? { responsible_uid: uid } : { responsible_uid: null };
    const { completed, failed } = await parallelLimit(
        ids.map(id => () => api('POST', `/tasks/${id}`, body)), 5,
        (d, t) => showProgress(d, t, 'Verantwortlich'));
    hideProgress();
    ids.forEach(id => {
        const t = S.allTasks.find(x => x.id === id);
        if (t) { t.responsible_uid = uid; t.responsibleUid = uid; t.assignee_id = uid; }
    });
    invalidateCache(S.currentProjectId);
    const name = uid ? (S.collaborators[uid] || uid) : 'Niemand';
    showToast(`${completed} → ${name}`, failed ? 'error' : 'success');
    S.selectedIds.clear();
    applyFilters();
}

// ── Bulk: Add Label ──
async function bulkAddLabel(label) {
    hideListMenu();
    if (!label || !label.trim() || !S.selectedIds.size) return;
    label = label.trim();
    const ids = [...S.selectedIds];
    const { completed, failed } = await parallelLimit(
        ids.map(id => () => {
            const t = S.allTasks.find(x => x.id === id);
            if (!t) return Promise.resolve();
            const newLabels = [...new Set([...(t.labels || []), label])];
            return api('POST', `/tasks/${id}`, { labels: newLabels }).then(() => { t.labels = newLabels; });
        }), 5,
        (d, t) => showProgress(d, t, 'Label'));
    hideProgress();
    invalidateCache(S.currentProjectId);
    showToast(`${completed} → Label "${label}"`, failed ? 'error' : 'success');
    S.selectedIds.clear();
    applyFilters();
}
