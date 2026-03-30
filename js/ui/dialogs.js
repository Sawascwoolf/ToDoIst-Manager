// ── Due Date Dialog ──
function closeDueDialog() { document.getElementById('due-dialog').classList.add('hidden'); }

async function saveDueDate(dateVal) {
    const id = S.ctxTaskId || document.getElementById('due-dialog')._taskId;
    closeDueDialog();
    if (!id) return;
    const task = S.allTasks.find(t => t.id === id);
    const oldDue = task && task.due ? task.due.date : null;
    try {
        const body = dateVal ? { due_date: dateVal } : { due_string: 'no date' };
        await api('POST', `/tasks/${id}`, body);
        if (task) task.due = dateVal ? { date: dateVal } : null;
        invalidateCache(S.currentProjectId);
        showToast(dateVal ? `Fällig: ${fmtDate(dateVal)}` : 'Fälligkeitsdatum entfernt.', 'success', async () => {
            const undoBody = oldDue ? { due_date: oldDue } : { due_string: 'no date' };
            await api('POST', `/tasks/${id}`, undoBody);
            if (task) task.due = oldDue ? { date: oldDue } : null;
            invalidateCache(S.currentProjectId);
            applyFilters();
        });
        applyFilters();
    } catch (e) { showToast('Fehler: ' + e.message, 'error'); }
}
