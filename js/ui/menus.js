// ── Context Menu ──
function showCtxMenu(e, taskId) {
    e.stopPropagation();
    S.ctxTaskId = taskId;
    hideListMenu();
    const menu = document.getElementById('context-menu');
    if (!menu) return;

    // Populate assignee submenu
    const assigneeSub = document.getElementById('ctx-assignee-sub');
    if (assigneeSub) {
        assigneeSub.innerHTML = '<button onclick="ctxAction(\'assignee\',null)">Niemand</button>';
        Object.entries(S.collaborators).forEach(([uid, name]) => {
            assigneeSub.innerHTML += `<button onclick="ctxAction('assignee','${uid}')">${esc(name)}</button>`;
        });
    }

    // Populate labels submenu for this task
    const task = S.allTasks.find(t => t.id === taskId);
    const labelsWrap = document.getElementById('ctx-labels-wrap');
    const labelsSub = document.getElementById('ctx-labels-sub');
    if (labelsWrap && labelsSub && task && task.labels && task.labels.length > 0) {
        labelsWrap.style.display = '';
        labelsSub.innerHTML = '';
        task.labels.forEach(l => {
            labelsSub.innerHTML += `<button onclick="ctxAction('removeLabel','${esc(l)}')">${esc(l)} &times;</button>`;
        });
    } else if (labelsWrap) {
        labelsWrap.style.display = 'none';
    }

    // Populate add-label submenu (all project labels not yet on this task + free input)
    const addLabelWrap = document.getElementById('ctx-addlabel-wrap');
    const addLabelSub = document.getElementById('ctx-addlabel-sub');
    if (addLabelWrap && addLabelSub) {
        const allLabels = new Set();
        S.allTasks.forEach(t => (t.labels || []).forEach(l => allLabels.add(l)));
        const taskLabels = new Set(task && task.labels ? task.labels : []);
        const available = [...allLabels].filter(l => !taskLabels.has(l)).sort();
        addLabelWrap.style.display = '';
        addLabelSub.innerHTML = '';
        available.forEach(l => {
            addLabelSub.innerHTML += `<button onclick="ctxAction('addLabel','${esc(l)}')">${esc(l)}</button>`;
        });
        if (available.length > 0) addLabelSub.innerHTML += '<div class="ctx-separator"></div>';
        addLabelSub.innerHTML += `<div class="ctx-input-row"><input type="text" id="ctx-new-label" placeholder="Neues Label..." onkeydown="if(event.key==='Enter'){ctxAction('addLabel',this.value);event.stopPropagation()}"><button onclick="ctxAction('addLabel',document.getElementById('ctx-new-label').value)">+</button></div>`;
    }

    menu.classList.remove('hidden');
    const rect = e.currentTarget.getBoundingClientRect();
    const menuH = menu.offsetHeight || 380;
    const top = (rect.bottom + menuH > window.innerHeight) ? Math.max(4, rect.top - menuH) : rect.bottom + 4;
    const left = Math.min(rect.left, window.innerWidth - 220);
    menu.style.top = top + 'px';
    menu.style.left = left + 'px';

    // Flip submenus to open left if they'd overflow the right edge
    const openLeft = left + 220 + 140 > window.innerWidth;
    menu.querySelectorAll('.ctx-submenu').forEach(s => s.classList.toggle('open-left', openLeft));
}

function hideCtxMenu() { const m = document.getElementById('context-menu'); if (m) m.classList.add('hidden'); S.ctxTaskId = null; }

// ── List Menu ──
function showListMenu(e) {
    e.stopPropagation();
    hideCtxMenu();
    const menu = document.getElementById('list-menu');
    if (!menu) return;
    const hasSel = S.selectedIds.size > 0;

    // Show/hide bulk-only items
    menu.querySelectorAll('.bulk-only').forEach(el => el.style.display = hasSel ? '' : 'none');

    // Populate bulk assignee submenu
    const bulkAssigneeSub = document.getElementById('bulk-assignee-sub');
    if (bulkAssigneeSub && hasSel) {
        bulkAssigneeSub.innerHTML = '<button onclick="bulkSetAssignee(null)">Niemand</button>';
        Object.entries(S.collaborators).forEach(([uid, name]) => {
            bulkAssigneeSub.innerHTML += `<button onclick="bulkSetAssignee('${uid}')">${esc(name)}</button>`;
        });
    }

    // Populate bulk label submenu
    const bulkLabelSub = document.getElementById('bulk-label-sub');
    if (bulkLabelSub && hasSel) {
        const allLabels = new Set();
        S.allTasks.forEach(t => (t.labels || []).forEach(l => allLabels.add(l)));
        bulkLabelSub.innerHTML = '';
        [...allLabels].sort().forEach(l => {
            bulkLabelSub.innerHTML += `<button onclick="bulkAddLabel('${esc(l)}')">${esc(l)}</button>`;
        });
        bulkLabelSub.innerHTML += `<div class="ctx-separator"></div><div class="ctx-input-row"><input type="text" id="bulk-new-label" placeholder="Neues Label..." onkeydown="if(event.key==='Enter'){bulkAddLabel(this.value);event.stopPropagation()}"><button onclick="bulkAddLabel(document.getElementById('bulk-new-label').value)">+</button></div>`;
    }

    menu.classList.remove('hidden');
    const rect = e.currentTarget.getBoundingClientRect();
    const left = Math.min(rect.right - 200, window.innerWidth - 220);
    menu.style.top = rect.bottom + 4 + 'px';
    menu.style.left = left + 'px';

    // Flip submenus left if needed
    const openLeft = left + 200 + 140 > window.innerWidth;
    menu.querySelectorAll('.ctx-submenu').forEach(s => s.classList.toggle('open-left', openLeft));
}

function hideListMenu() { const m = document.getElementById('list-menu'); if (m) m.classList.add('hidden'); }

function listMenuAction(action) {
    hideListMenu();
    if (action === 'reopenSelected') reopenSelected();
    else if (action === 'completeSelected') completeSelected();
    else if (action === 'expandAll') expandAll();
    else if (action === 'collapseAll') collapseAll();
    else if (action === 'refresh') loadTasks(true);
}

document.addEventListener('click', e => {
    if (!e.target.closest('.context-menu') && !e.target.closest('.actions-btn') && !e.target.closest('.list-actions-btn')) {
        hideCtxMenu();
        hideListMenu();
    }
});
