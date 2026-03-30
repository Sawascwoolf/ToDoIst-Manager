// ── Helpers ──
const PRIO = { 4: 'P1', 3: 'P2', 2: 'P3', 1: 'P4' };

function getSid(t) { return t.sectionId || t.section_id || null; }

function getAssignee(t) {
    const u = t.responsible_uid || t.responsibleUid || t.assignee_id || t.assigneeId;
    return u ? (S.collaborators[u] || u) : '';
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function fmtDate(s) {
    return new Date(s).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function todoistUrl(taskId) { return `https://todoist.com/app/task/${taskId}`; }

function getInitials(name) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return name.substring(0, 2).toUpperCase();
}

function mk(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text) el.textContent = text;
    return el;
}

// ── Hierarchy ──
function buildHierarchy(tasks) {
    const map = new Map(); tasks.forEach(t => map.set(t.id, t));
    tasks.forEach(t => {
        let depth = 0, cur = t, pid = cur.parentId || cur.parent_id;
        while (pid && map.has(pid)) { depth++; cur = map.get(pid); pid = cur.parentId || cur.parent_id; }
        t._depth = depth;
    });
    const byParent = new Map();
    tasks.filter(t => t._depth > 0).forEach(c => {
        const pid = c.parentId || c.parent_id;
        if (!byParent.has(pid)) byParent.set(pid, []);
        byParent.get(pid).push(c);
    });
    const result = [];
    function add(t) { result.push(t); t._hasChildren = byParent.has(t.id); (byParent.get(t.id) || []).forEach(add); }
    tasks.filter(t => t._depth === 0).forEach(add);
    tasks.forEach(t => { if (!result.includes(t)) { t._depth = 0; result.push(t); } });
    return result;
}

function isHiddenByCollapse(task, checkSections) {
    const map = new Map(); S.filteredTasks.forEach(t => map.set(t.id, t));
    let pid = task.parentId || task.parent_id;
    while (pid) {
        if (S.collapsedIds.has(pid)) return true;
        const parent = map.get(pid);
        if (!parent) break;
        pid = parent.parentId || parent.parent_id;
    }
    if (checkSections) {
        const sid = task.sectionId || task.section_id || '__none__';
        return S.collapsedIds.has('sec_' + sid);
    }
    return false;
}

// ── Stats ──
function updateStats() {
    const total = S.allTasks.length;
    const openCount = S.allTasks.filter(t => t._status !== 'completed' && !t.is_completed && !t.checked).length;
    const completedCount = total - openCount;
    const visible = S.filteredTasks.length;
    const txt = `${visible} von ${total} | ${openCount} offen, ${completedCount} erledigt`;
    document.getElementById('stats-top').textContent = txt;
    document.getElementById('stats-bottom').textContent = txt;
}

// ── Rendering ──
function renderTable() {
    const tbody = document.getElementById('task-body');
    const noTasks = document.getElementById('no-tasks');

    const allEmpty = S.filteredTasks.length === 0 && (!S.searchExtraTasks || S.searchExtraTasks.length === 0);
    if (allEmpty) { tbody.innerHTML = ''; noTasks.classList.remove('hidden'); return; }
    noTasks.classList.add('hidden');

    const groups = []; const gmap = new Map();
    S.filteredTasks.forEach(t => {
        const sid = getSid(t) || '__none__';
        if (!gmap.has(sid)) { const g = { id: sid, name: sid === '__none__' ? '(Ohne Abschnitt)' : (S.sections[sid] || '?'), tasks: [] }; groups.push(g); gmap.set(sid, g); }
        gmap.get(sid).tasks.push(t);
    });

    const hasSections = S.groupBySection && (groups.length > 1 || groups[0]?.id !== '__none__');

    const today = new Date(); today.setHours(0, 0, 0, 0);
    let html = '';

    groups.forEach(g => {
        const secKey = 'sec_' + g.id;
        const secCollapsed = hasSections && S.collapsedIds.has(secKey);
        if (hasSections) {
            html += `<tr class="section-row ${secCollapsed ? 'collapsed' : ''}" onclick="toggleCollapse('${secKey}')">
                <td colspan="8"><span class="section-toggle">&#9660;</span> ${esc(g.name)} <span class="section-count">(${g.tasks.length})</span></td></tr>`;
        }
        if (!secCollapsed) {
            g.tasks.forEach(t => {
                if (isHiddenByCollapse(t, hasSections)) return;
                html += taskRow(t, today);
            });
        }
    });

    // Search-extra results (match search but excluded by other filters)
    if (S.searchExtraTasks && S.searchExtraTasks.length > 0) {
        html += `<tr class="section-row search-extra-row">
            <td colspan="8"><span class="search-extra-label">Weitere Suchtreffer (durch Filter ausgeblendet)</span> <span class="section-count">(${S.searchExtraTasks.length})</span></td></tr>`;
        S.searchExtraTasks.forEach(t => { html += taskRow(t, today, true); });
    }

    tbody.innerHTML = html;
}

function taskRow(t, today, dimmed) {
    const sel = S.selectedIds.has(t.id);
    const depth = t._depth || 0;
    const pad = depth > 0 ? `padding-left:${depth * 20 + 10}px` : '';
    const prefix = depth > 0 ? '<span class="subtask-indicator">&#x2514; </span>' : '';

    let collapseBtn = '';
    if (t._hasChildren) {
        const isColl = S.collapsedIds.has(t.id);
        collapseBtn = `<span class="collapse-toggle ${isColl ? 'collapsed' : ''}" onclick="event.stopPropagation();toggleCollapse('${t.id}')">&#9660;</span>`;
    }

    const desc = t.description ? `<span class="task-description">${esc(t.description.substring(0, 80))}${t.description.length > 80 ? '...' : ''}</span>` : '';
    const isComp = t._status === 'completed' || t.is_completed || t.checked;
    const statusCb = `<input type="checkbox" class="status-cb" ${isComp ? 'checked' : ''} onchange="toggleTaskStatus('${t.id}',this)" title="${isComp ? 'Unerledigt' : 'Erledigt'}">`;

    let dueHtml = '';
    if (t.due) {
        const d = new Date(t.due.date), ov = d < today;
        dueHtml = `<span class="due-date${ov ? ' overdue' : ''}">${fmtDate(t.due.date)}${ov ? ' !' : ''}</span>`;
    }

    const labels = (t.labels || []).map(l => `<span class="label-tag">${esc(l)}</span>`).join('');
    const assignee = getAssignee(t);
    const assigneeHtml = assignee ? `<span class="assignee-avatar" title="${esc(assignee)}">${getInitials(assignee)}</span>` : '—';
    const taskLink = `<a href="${todoistUrl(t.id)}" target="_blank" rel="noopener" class="task-link" title="In Todoist öffnen">${esc(t.content)}</a>`;
    const rowClass = (sel ? 'selected' : '') + (dimmed ? ' dimmed' : '');

    return `<tr class="${rowClass}" data-id="${t.id}">
        <td class="col-check"><input type="checkbox" ${sel ? 'checked' : ''} onchange="toggleSelect('${t.id}')"></td>
        <td style="${pad}"><div class="task-content">${collapseBtn}${prefix}<span>${taskLink}</span>${desc}</div></td>
        <td class="col-status">${statusCb}</td>
        <td><span class="priority-badge priority-${t.priority}">${PRIO[t.priority] || 'P4'}</span></td>
        <td>${dueHtml || '—'}</td>
        <td>${assigneeHtml}</td>
        <td>${labels || '—'}</td>
        <td class="col-actions"><button class="actions-btn" onclick="showCtxMenu(event,'${t.id}')">&#8943;</button></td>
    </tr>`;
}

// ── Collapse ──
function toggleCollapse(id) { S.collapsedIds.has(id) ? S.collapsedIds.delete(id) : S.collapsedIds.add(id); renderTable(); }
function expandAll() { S.collapsedIds.clear(); renderTable(); }
function collapseAll() {
    S.filteredTasks.forEach(t => { if (t._hasChildren) S.collapsedIds.add(t.id); });
    const groups = new Set(); S.filteredTasks.forEach(t => groups.add('sec_' + (getSid(t) || '__none__')));
    groups.forEach(id => S.collapsedIds.add(id));
    renderTable();
}
