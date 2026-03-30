// ── Toggle Buttons ──
function handleToggle(e) {
    const btn = e.currentTarget;
    const container = btn.parentElement;
    const isMulti = e.ctrlKey || e.metaKey;

    if (btn.dataset.value === '__select_all__') {
        const others = container.querySelectorAll('.toggle-btn:not([data-value="__select_all__"])');
        const allActive = [...others].every(b => b.classList.contains('active'));
        others.forEach(b => b.classList.toggle('active', !allActive));
        applyFilters();
        return;
    }

    if (isMulti) {
        btn.classList.toggle('active');
    } else {
        const siblings = container.querySelectorAll('.toggle-btn:not([data-value="__select_all__"])');
        const wasOnlyActive = btn.classList.contains('active') &&
            [...siblings].filter(b => b.classList.contains('active')).length === 1;
        if (wasOnlyActive) {
            siblings.forEach(b => b.classList.add('active'));
        } else {
            siblings.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        }
    }
    applyFilters();
}

// Mobile: long press = multi-select
let longPressTimer = null;
function handleTouchStart(e) {
    const btn = e.currentTarget;
    longPressTimer = setTimeout(() => {
        longPressTimer = null;
        btn.classList.toggle('active');
        applyFilters();
    }, 500);
}
function handleTouchEnd(e) {
    if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
        const btn = e.currentTarget;
        const container = btn.parentElement;
        if (btn.dataset.value === '__select_all__') { handleToggle(e); return; }
        const siblings = container.querySelectorAll('.toggle-btn:not([data-value="__select_all__"])');
        const wasOnlyActive = btn.classList.contains('active') &&
            [...siblings].filter(b => b.classList.contains('active')).length === 1;
        if (wasOnlyActive) { siblings.forEach(b => b.classList.add('active')); }
        else { siblings.forEach(b => b.classList.remove('active')); btn.classList.add('active'); }
        applyFilters();
        e.preventDefault();
    }
}

function bindToggleButtons() {
    document.querySelectorAll('.toggle-btn').forEach(btn => {
        btn.onclick = handleToggle;
        btn.addEventListener('touchstart', handleTouchStart, { passive: true });
        btn.addEventListener('touchend', handleTouchEnd);
    });
}

function getActiveValues(containerId) {
    return [...document.querySelectorAll(`#${containerId} .toggle-btn.active:not([data-value="__select_all__"])`)].map(b => b.dataset.value);
}

// ── Populate dynamic filters ──
function populateAssigneeToggles() {
    const c = document.getElementById('filter-assignee-toggles');
    const names = Object.entries(S.collaborators);
    const group = document.getElementById('assignee-toggle-group');
    if (!group || !c) return;
    if (names.length === 0) { group.style.display = 'none'; return; }
    group.style.display = '';
    c.innerHTML = '';

    const allBtn = mk('button', 'toggle-btn meta-btn', 'Alle');
    allBtn.dataset.value = '__select_all__';
    c.appendChild(allBtn);

    const noneBtn = mk('button', 'toggle-btn active', 'Ohne');
    noneBtn.dataset.value = '__none__';
    c.appendChild(noneBtn);

    names.forEach(([id, name]) => {
        const b = mk('button', 'toggle-btn active', name);
        b.dataset.value = id;
        c.appendChild(b);
    });
    bindToggleButtons();
}

function populateLabelFilter() {
    const labels = new Set();
    S.allTasks.forEach(t => (t.labels || []).forEach(l => labels.add(l)));
    const sel = document.getElementById('filter-label');
    const cur = sel.value;
    sel.innerHTML = '<option value="">Label: Alle</option>';
    [...labels].sort().forEach(l => { const o = document.createElement('option'); o.value = l; o.textContent = l; sel.appendChild(o); });
    sel.value = cur;
}

// ── Reset all filters ──
function resetAllFilters() {
    document.getElementById('filter-search').value = '';
    document.getElementById('filter-label').value = '';
    document.querySelectorAll('#filter-status-toggles .toggle-btn').forEach(b => b.classList.add('active'));
    document.querySelectorAll('#filter-priority-toggles .toggle-btn').forEach(b => b.classList.add('active'));
    document.querySelectorAll('#filter-assignee-toggles .toggle-btn:not([data-value="__select_all__"])').forEach(b => b.classList.add('active'));
    applyFilters();
}

// ── Filters ──
function applyFilters() {
    const search = document.getElementById('filter-search').value.toLowerCase();
    const label = document.getElementById('filter-label').value;
    const statuses = getActiveValues('filter-status-toggles');
    const priorities = getActiveValues('filter-priority-toggles');
    const assignees = getActiveValues('filter-assignee-toggles');

    const matchesSearch = (t) => !search || t.content.toLowerCase().includes(search) || (t.description || '').toLowerCase().includes(search);
    const matchesOtherFilters = (t) => {
        if (statuses.length > 0 && statuses.length < 2) {
            const s = (t._status === 'completed' || t.is_completed || t.checked) ? 'completed' : 'open';
            if (!statuses.includes(s)) return false;
        }
        if (priorities.length > 0 && priorities.length < 4) {
            if (!priorities.includes(String(t.priority))) return false;
        }
        if (label && !(t.labels || []).includes(label)) return false;
        if (assignees.length > 0) {
            const uid = t.responsible_uid || t.responsibleUid || t.assignee_id || t.assigneeId;
            if (!uid && !assignees.includes('__none__')) return false;
            if (uid && !assignees.includes(uid)) return false;
        }
        return true;
    };

    S.filteredTasks = S.allTasks.filter(t => matchesSearch(t) && matchesOtherFilters(t));

    // Collect search matches excluded by other filters
    S.searchExtraTasks = [];
    if (search) {
        const filteredIds = new Set(S.filteredTasks.map(t => t.id));
        S.searchExtraTasks = S.allTasks.filter(t => matchesSearch(t) && !matchesOtherFilters(t) && !filteredIds.has(t.id));
    }

    sortTasks();
    S.filteredTasks = buildHierarchy(S.filteredTasks);
    S.selectedIds.clear();
    document.getElementById('select-all').checked = false;
    updateSelectionUI();
    renderTable();
    updateStats();
}

// ── Sorting ──
function sortBy(field) {
    if (S.sortField === field) S.sortAsc = !S.sortAsc; else { S.sortField = field; S.sortAsc = true; }
    document.querySelectorAll('th.sortable').forEach(th => th.classList.remove('sort-asc', 'sort-desc'));
    const ths = document.querySelectorAll('th.sortable');
    const idx = ['content', 'priority', 'due', 'assignee'].indexOf(field);
    if (idx >= 0 && ths[idx]) ths[idx].classList.add(S.sortAsc ? 'sort-asc' : 'sort-desc');
    sortTasks(); S.filteredTasks = buildHierarchy(S.filteredTasks); renderTable();
}

function sortTasks() {
    S.filteredTasks.sort((a, b) => {
        let va, vb;
        switch (S.sortField) {
            case 'content': va = a.content.toLowerCase(); vb = b.content.toLowerCase(); break;
            case 'priority': va = a.priority; vb = b.priority; return S.sortAsc ? vb - va : va - vb;
            case 'due': va = a.due ? a.due.date : 'z'; vb = b.due ? b.due.date : 'z'; break;
            case 'assignee': va = getAssignee(a).toLowerCase(); vb = getAssignee(b).toLowerCase(); break;
            default: return 0;
        }
        return va < vb ? (S.sortAsc ? -1 : 1) : va > vb ? (S.sortAsc ? 1 : -1) : 0;
    });
}

// ── Grouping Toggle ──
function toggleGrouping() {
    S.groupBySection = !S.groupBySection;
    updateGroupToggleUI();
    renderTable();
}

// ── View Configs ──
let activeViewIdx = -1;

function renderViewSlots() {
    const container = document.getElementById('view-slots');
    if (!container) return;
    const configs = getViewConfigs();
    container.innerHTML = '';
    configs.forEach((cfg, i) => {
        const slot = document.createElement('button');
        slot.className = 'view-slot' + (i === activeViewIdx ? ' active-view' : '');
        slot.innerHTML = `${esc(cfg.name)}<span class="view-delete" onclick="event.stopPropagation();deleteView(${i})">&times;</span>`;
        slot.onclick = () => loadView(i);
        container.appendChild(slot);
    });
}

function saveCurrentView() {
    const configs = getViewConfigs();
    if (configs.length >= MAX_VIEWS) {
        showToast(`Maximal ${MAX_VIEWS} Ansichten.`, 'error');
        return;
    }
    document.getElementById('view-name-input').value = '';
    document.getElementById('view-name-dialog').classList.remove('hidden');
    setTimeout(() => document.getElementById('view-name-input').focus(), 100);
}

function closeViewNameDialog() {
    document.getElementById('view-name-dialog').classList.add('hidden');
}

function confirmSaveView() {
    const name = document.getElementById('view-name-input').value.trim();
    if (!name) { showToast('Bitte Name eingeben.', 'error'); return; }
    closeViewNameDialog();
    const configs = getViewConfigs();
    const cfg = captureCurrentView();
    cfg.name = name;
    configs.push(cfg);
    saveViewConfigs(configs);
    activeViewIdx = configs.length - 1;
    renderViewSlots();
    showToast(`Ansicht "${name}" gespeichert.`, 'success');
}

function loadView(idx) {
    const configs = getViewConfigs();
    if (!configs[idx]) return;
    activeViewIdx = idx;
    restoreView(configs[idx]);
    renderViewSlots();
}

function deleteView(idx) {
    const configs = getViewConfigs();
    const name = configs[idx]?.name || '';
    configs.splice(idx, 1);
    saveViewConfigs(configs);
    if (activeViewIdx === idx) activeViewIdx = -1;
    else if (activeViewIdx > idx) activeViewIdx--;
    renderViewSlots();
    showToast(`Ansicht "${name}" gelöscht.`, 'success');
}
