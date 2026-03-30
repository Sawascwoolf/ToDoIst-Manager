// ── Confirm Dialog ──
let confirmCallback = null;

function showConfirmDialog(title, message, okLabel, callback) {
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-message').textContent = message;
    document.getElementById('confirm-ok').textContent = okLabel;
    confirmCallback = callback;
    document.getElementById('confirm-dialog').classList.remove('hidden');
}

function closeConfirmDialog(result) {
    document.getElementById('confirm-dialog').classList.add('hidden');
    if (result && confirmCallback) confirmCallback();
    confirmCallback = null;
}

// ── Create Task Dialog ──
function openCreateTaskDialog() {
    document.getElementById('new-task-content').value = '';
    document.getElementById('new-task-priority').value = '1';

    // Populate parent select with current tasks (top-level only for simplicity)
    const parentSel = document.getElementById('new-task-parent');
    parentSel.innerHTML = '<option value="">(Keine – oberste Ebene)</option>';
    S.allTasks.filter(t => t._status !== 'completed').forEach(t => {
        const depth = t._depth || 0;
        const prefix = depth > 0 ? '  '.repeat(depth) + '└ ' : '';
        const o = document.createElement('option');
        o.value = t.id;
        o.textContent = prefix + t.content.substring(0, 50);
        parentSel.appendChild(o);
    });

    document.getElementById('create-task-dialog').classList.remove('hidden');
    setTimeout(() => document.getElementById('new-task-content').focus(), 100);
}

function closeCreateTaskDialog() {
    document.getElementById('create-task-dialog').classList.add('hidden');
}

async function confirmCreateTask() {
    const content = document.getElementById('new-task-content').value.trim();
    if (!content) { showToast('Bitte Aufgabenname eingeben.', 'error'); return; }

    const priority = parseInt(document.getElementById('new-task-priority').value) || 1;
    const parentId = document.getElementById('new-task-parent').value || null;

    closeCreateTaskDialog();

    try {
        const body = {
            content,
            project_id: S.currentProjectId,
            priority,
        };
        if (parentId) body.parent_id = parentId;

        await api('POST', '/tasks', body);
        invalidateCache(S.currentProjectId);
        await loadTasks(true);
        showToast('Aufgabe erstellt.', 'success');
    } catch (e) {
        showToast('Fehler: ' + e.message, 'error');
    }
}
