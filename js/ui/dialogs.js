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

// ── Task Picker (reusable search-in-list for parent selection) ──
function populateTaskPicker(prefix, excludeId) {
    const list = document.getElementById(prefix + '-list');
    const search = document.getElementById(prefix + '-search');
    if (!list) return;
    list._allItems = S.allTasks
        .filter(t => t._status !== 'completed' && t.id !== excludeId)
        .map(t => ({ id: t.id, content: t.content, depth: t._depth || 0 }));
    if (search) search.value = '';
    renderTaskPickerList(prefix, '');
}

function filterTaskPicker(prefix) {
    const search = document.getElementById(prefix + '-search');
    renderTaskPickerList(prefix, (search ? search.value : '').toLowerCase());
}

function renderTaskPickerList(prefix, query) {
    const list = document.getElementById(prefix + '-list');
    if (!list || !list._allItems) return;
    const items = list._allItems.filter(t => !query || t.content.toLowerCase().includes(query));
    list.innerHTML = '';
    items.slice(0, 30).forEach(t => {
        const div = document.createElement('div');
        div.className = 'task-picker-item';
        const indent = t.depth > 0 ? '  '.repeat(t.depth) + '└ ' : '';
        div.textContent = indent + t.content.substring(0, 60);
        div.onclick = () => selectTaskPickerItem(prefix, t.id, t.content);
        list.appendChild(div);
    });
    if (items.length > 30) {
        const more = document.createElement('div');
        more.className = 'task-picker-item';
        more.textContent = `... ${items.length - 30} weitere`;
        more.style.color = 'var(--text-muted)';
        list.appendChild(more);
    }
}

function selectTaskPickerItem(prefix, id, content) {
    const hidden = document.getElementById(prefix.replace('-list', '').replace('-search', ''));
    if (prefix === 'new-task-parent') {
        const parentInput = document.getElementById('new-task-parent');
        const parentText = document.getElementById('new-task-parent-text');
        const clearBtn = document.getElementById('new-task-parent-clear');
        if (parentInput) parentInput.value = id;
        if (parentText) parentText.textContent = content;
        if (clearBtn) clearBtn.classList.remove('hidden');
    }
    // For move dialog
    if (prefix === 'move-task') {
        confirmMoveTask(id);
    }
}

// ── Label Picker ──
function populateLabelPicker(containerId, selectedLabels) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const allLabels = new Set();
    S.allTasks.forEach(t => (t.labels || []).forEach(l => allLabels.add(l)));
    container.innerHTML = '';
    [...allLabels].sort().forEach(l => {
        const chip = document.createElement('span');
        chip.className = 'label-chip' + (selectedLabels.includes(l) ? ' active' : '');
        chip.textContent = l;
        chip.onclick = () => chip.classList.toggle('active');
        container.appendChild(chip);
    });
}

function getSelectedLabels(containerId) {
    return [...document.querySelectorAll(`#${containerId} .label-chip.active`)].map(c => c.textContent);
}

function clearParentPicker() {
    const input = document.getElementById('new-task-parent');
    const text = document.getElementById('new-task-parent-text');
    const clearBtn = document.getElementById('new-task-parent-clear');
    if (input) input.value = '';
    if (text) text.textContent = '(Keine – oberste Ebene)';
    if (clearBtn) clearBtn.classList.add('hidden');
}

// ── Create Task Dialog ──
function openCreateTaskDialog(parentId) {
    document.getElementById('new-task-content').value = '';
    document.getElementById('new-task-priority').value = '1';

    // Populate assignee chips
    const assigneeCont = document.getElementById('new-task-assignee');
    if (assigneeCont) {
        assigneeCont.innerHTML = '';
        Object.entries(S.collaborators).forEach(([uid, name]) => {
            const chip = document.createElement('span');
            chip.className = 'assignee-chip';
            chip.dataset.uid = uid;
            chip.textContent = getInitials(name);
            chip.title = name;
            chip.onclick = () => {
                const wasActive = chip.classList.contains('active');
                assigneeCont.querySelectorAll('.assignee-chip').forEach(c => c.classList.remove('active'));
                if (!wasActive) chip.classList.add('active');
            };
            assigneeCont.appendChild(chip);
        });
    }

    // Populate labels
    populateLabelPicker('new-task-labels', []);

    // Populate parent picker
    populateTaskPicker('new-task-parent');
    const parentInput = document.getElementById('new-task-parent');
    const parentText = document.getElementById('new-task-parent-text');
    const clearBtn = document.getElementById('new-task-parent-clear');
    if (parentId && parentInput) {
        parentInput.value = parentId;
        const pt = S.allTasks.find(t => t.id === parentId);
        if (parentText) parentText.textContent = pt ? pt.content : parentId;
        if (clearBtn) clearBtn.classList.remove('hidden');
    } else {
        clearParentPicker();
    }

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
    const activeChip = document.querySelector('#new-task-assignee .assignee-chip.active');
    const assignee = activeChip ? activeChip.dataset.uid : null;
    const labels = getSelectedLabels('new-task-labels');

    closeCreateTaskDialog();

    try {
        const body = { content, project_id: S.currentProjectId, priority };
        if (parentId) body.parent_id = parentId;
        if (assignee) body.responsible_uid = assignee;
        if (labels.length) body.labels = labels;

        await api('POST', '/tasks', body);
        invalidateCache(S.currentProjectId);
        await loadTasks(true);
        showToast('Aufgabe erstellt.', 'success');
    } catch (e) {
        showToast('Fehler: ' + e.message, 'error');
    }
}

// ── Move Task Dialog ──
let moveTaskId = null;

function openMoveDialog(taskId) {
    moveTaskId = taskId;
    populateTaskPicker('move-task', taskId);
    document.getElementById('move-dialog').classList.remove('hidden');
    setTimeout(() => document.getElementById('move-task-search').focus(), 100);
}

function closeMoveDialog() {
    document.getElementById('move-dialog').classList.add('hidden');
    moveTaskId = null;
}

async function confirmMoveTask(newParentId) {
    const id = moveTaskId;
    closeMoveDialog();
    if (!id) return;
    try {
        await api('POST', `/tasks/${id}`, { parent_id: newParentId || null });
        const task = S.allTasks.find(t => t.id === id);
        if (task) { task.parent_id = newParentId; task.parentId = newParentId; }
        invalidateCache(S.currentProjectId);
        await loadTasks(true);
        const targetName = newParentId
            ? (S.allTasks.find(t => t.id === newParentId)?.content || 'Aufgabe')
            : 'Oberste Ebene';
        showToast(`Verschoben → ${targetName}`, 'success');
    } catch (e) {
        showToast('Fehler: ' + e.message, 'error');
    }
}
