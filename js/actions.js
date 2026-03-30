// ── Context Actions ──
async function ctxAction(action, value) {
    const id = S.ctxTaskId;
    hideCtxMenu();
    if (!id) return;
    const task = S.allTasks.find(t => t.id === id);
    try {
        if (action === 'complete') {
            await syncCommand('item_complete', { id });
            updateTaskStatusLocally(id, 'completed');
            showToast('Erledigt.', 'success', async () => {
                await syncCommand('item_uncomplete', { id });
                updateTaskStatusLocally(id, 'open');
                applyFilters();
            });
        } else if (action === 'reopen') {
            await syncCommand('item_uncomplete', { id });
            updateTaskStatusLocally(id, 'open');
            showToast('Wieder geöffnet.', 'success', async () => {
                await syncCommand('item_complete', { id });
                updateTaskStatusLocally(id, 'completed');
                applyFilters();
            });
        } else if (action === 'priority') {
            const oldPrio = task ? task.priority : null;
            await syncCommand('item_update', { id, priority: value });
            if (task) task.priority = value;
            invalidateCache(S.currentProjectId);
            showToast(`Priorität → ${PRIO[value]}`, 'success', oldPrio != null ? async () => {
                await syncCommand('item_update', { id, priority: oldPrio });
                if (task) task.priority = oldPrio;
                invalidateCache(S.currentProjectId);
                applyFilters();
            } : null);
        } else if (action === 'assignee') {
            const oldUid = task ? (task.responsible_uid || null) : null;
            await syncCommand('item_update', { id, responsible_uid: value || null });
            if (task) task.responsible_uid = value;
            invalidateCache(S.currentProjectId);
            const name = value ? (S.collaborators[value] || value) : 'Niemand';
            showToast(`Verantwortlich: ${name}`, 'success', async () => {
                await syncCommand('item_update', { id, responsible_uid: oldUid });
                if (task) task.responsible_uid = oldUid;
                invalidateCache(S.currentProjectId);
                applyFilters();
            });
        } else if (action === 'removeLabel') {
            if (!task) return;
            const oldLabels = [...(task.labels || [])];
            const newLabels = oldLabels.filter(l => l !== value);
            await syncCommand('item_update', { id, labels: newLabels });
            task.labels = newLabels;
            invalidateCache(S.currentProjectId);
            showToast(`Label "${value}" entfernt.`, 'success', async () => {
                await syncCommand('item_update', { id, labels: oldLabels });
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
            await syncCommand('item_update', { id, labels: newLabels });
            task.labels = newLabels;
            invalidateCache(S.currentProjectId);
            showToast(`Label "${value}" hinzugefügt.`, 'success', async () => {
                await syncCommand('item_update', { id, labels: oldLabels });
                task.labels = oldLabels;
                invalidateCache(S.currentProjectId);
                applyFilters();
            });
        } else if (action === 'addSubtask') {
            openCreateTaskDialog(id);
            return;
        } else if (action === 'move') {
            openMoveDialog(id);
            return;
        } else if (action === 'confirmDelete') {
            if (!task) return;
            showConfirmDialog('Aufgabe löschen', `"${task.content}" wirklich löschen?`, 'Löschen', async () => {
                try {
                    await syncCommand('item_delete', { id });
                    S.allTasks = S.allTasks.filter(t => t.id !== id);
                    invalidateCache(S.currentProjectId);
                    showToast('Aufgabe gelöscht.', 'success');
                    applyFilters();
                } catch (e) { showToast('Fehler: ' + e.message, 'error'); }
            });
            return;
        } else if (action === 'duplicate') {
            if (!task) return;
            const args = { content: task.content, project_id: S.currentProjectId, priority: task.priority };
            if (task.labels && task.labels.length) args.labels = task.labels;
            if (task.parent_id) args.parent_id = task.parent_id;
            if (task.section_id) args.section_id = task.section_id;
            const cmd = { type: 'item_add', uuid: generateUUID(), temp_id: generateUUID(), args };
            await syncWrite([cmd]);
            invalidateCache(S.currentProjectId);
            await loadTasks(true);
            showToast('Aufgabe dupliziert.', 'success');
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
            await syncCommand('item_complete', { id: taskId });
            updateTaskStatusLocally(taskId, 'completed');
            showToast('Erledigt.', 'success', async () => {
                await syncCommand('item_uncomplete', { id: taskId });
                updateTaskStatusLocally(taskId, 'open');
                applyFilters();
            });
        } else {
            await syncCommand('item_uncomplete', { id: taskId });
            updateTaskStatusLocally(taskId, 'open');
            showToast('Wieder geöffnet.', 'success', async () => {
                await syncCommand('item_complete', { id: taskId });
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

// ── Bulk Actions (batched via Sync API) ──
async function reopenSelected() {
    if (!S.selectedIds.size) return;
    const ids = [...S.selectedIds];
    const cmds = ids.map(id => ({ type: 'item_uncomplete', uuid: generateUUID(), args: { id } }));
    const { ok, failed } = await syncBatchCommands(cmds);
    ids.forEach(id => updateTaskStatusLocally(id, 'open'));
    const msg = failed ? `${ok} ok, ${failed} Fehler.` : `${ok} als unerledigt markiert.`;
    showToast(msg, failed ? 'error' : 'success', !failed ? async () => {
        const undoCmds = ids.map(id => ({ type: 'item_complete', uuid: generateUUID(), args: { id } }));
        await syncBatchCommands(undoCmds);
        ids.forEach(id => updateTaskStatusLocally(id, 'completed'));
        applyFilters();
    } : null);
    S.selectedIds.clear();
    applyFilters();
}

async function completeSelected() {
    if (!S.selectedIds.size) return;
    const ids = [...S.selectedIds];
    const cmds = ids.map(id => ({ type: 'item_complete', uuid: generateUUID(), args: { id } }));
    const { ok, failed } = await syncBatchCommands(cmds);
    ids.forEach(id => updateTaskStatusLocally(id, 'completed'));
    const msg = failed ? `${ok} ok, ${failed} Fehler.` : `${ok} als erledigt markiert.`;
    showToast(msg, failed ? 'error' : 'success', !failed ? async () => {
        const undoCmds = ids.map(id => ({ type: 'item_uncomplete', uuid: generateUUID(), args: { id } }));
        await syncBatchCommands(undoCmds);
        ids.forEach(id => updateTaskStatusLocally(id, 'open'));
        applyFilters();
    } : null);
    S.selectedIds.clear();
    applyFilters();
}

// ── Bulk: Priority (1 batched call) ──
async function bulkSetPriority(prio) {
    hideListMenu();
    if (!S.selectedIds.size) return;
    const ids = [...S.selectedIds];
    const oldPrios = {};
    ids.forEach(id => { const t = S.allTasks.find(x => x.id === id); if (t) oldPrios[id] = t.priority; });
    const cmds = ids.map(id => ({ type: 'item_update', uuid: generateUUID(), args: { id, priority: prio } }));
    const { ok, failed } = await syncBatchCommands(cmds);
    ids.forEach(id => { const t = S.allTasks.find(x => x.id === id); if (t) t.priority = prio; });
    invalidateCache(S.currentProjectId);
    showToast(`${ok} → ${PRIO[prio]}`, failed ? 'error' : 'success', !failed ? async () => {
        const undoCmds = ids.map(id => ({ type: 'item_update', uuid: generateUUID(), args: { id, priority: oldPrios[id] || 1 } }));
        await syncBatchCommands(undoCmds);
        ids.forEach(id => { const t = S.allTasks.find(x => x.id === id); if (t) t.priority = oldPrios[id] || 1; });
        invalidateCache(S.currentProjectId);
        applyFilters();
    } : null);
    S.selectedIds.clear();
    applyFilters();
}

// ── Bulk: Assignee (1 batched call) ──
async function bulkSetAssignee(uid) {
    hideListMenu();
    if (!S.selectedIds.size) return;
    const ids = [...S.selectedIds];
    const cmds = ids.map(id => ({ type: 'item_update', uuid: generateUUID(), args: { id, responsible_uid: uid || null } }));
    const { ok, failed } = await syncBatchCommands(cmds);
    ids.forEach(id => {
        const t = S.allTasks.find(x => x.id === id);
        if (t) t.responsible_uid = uid;
    });
    invalidateCache(S.currentProjectId);
    const name = uid ? (S.collaborators[uid] || uid) : 'Niemand';
    showToast(`${ok} → ${name}`, failed ? 'error' : 'success');
    S.selectedIds.clear();
    applyFilters();
}

// ── Bulk: Add Label (1 batched call) ──
async function bulkAddLabel(label) {
    hideListMenu();
    if (!label || !label.trim() || !S.selectedIds.size) return;
    label = label.trim();
    const ids = [...S.selectedIds];
    const cmds = ids.map(id => {
        const t = S.allTasks.find(x => x.id === id);
        const newLabels = [...new Set([...(t ? t.labels || [] : []), label])];
        return { type: 'item_update', uuid: generateUUID(), args: { id, labels: newLabels } };
    });
    const { ok, failed } = await syncBatchCommands(cmds);
    ids.forEach(id => {
        const t = S.allTasks.find(x => x.id === id);
        if (t) t.labels = [...new Set([...(t.labels || []), label])];
    });
    invalidateCache(S.currentProjectId);
    showToast(`${ok} → Label "${label}"`, failed ? 'error' : 'success');
    S.selectedIds.clear();
    applyFilters();
}
