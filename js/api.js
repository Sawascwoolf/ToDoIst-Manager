// ── REST API Layer (for endpoints not covered by Sync API) ──
const API_BASE = 'https://api.todoist.com/api/v1';

async function api(method, path, body) {
    const h = { 'Authorization': `Bearer ${S.token}` };
    if (body) h['Content-Type'] = 'application/json';
    const opts = { method, headers: h };
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch(`${API_BASE}${path}`, opts);
    if (r.status === 429) {
        const retryAfter = parseInt(r.headers.get('Retry-After') || '5');
        await new Promise(res => setTimeout(res, retryAfter * 1000));
        return api(method, path, body);
    }
    if (!r.ok) throw new Error(`API ${r.status}: ${await r.text()}`);
    return r.status === 204 ? null : r.json();
}

// Completed tasks: Sync API doesn't return them, so we use REST
async function fetchAllCompleted(projectId) {
    let all = [], offset = 0;
    do {
        const d = await api('GET', `/tasks/completed?project_id=${projectId}&limit=200&offset=${offset}`);
        if (!d) break;
        const items = d.items || d.results || [];
        all = all.concat(items);
        if (items.length < 200) break;
        offset += items.length;
    } while (true);

    const tasks = all.map(i => ({
        id: i.taskId || i.task_id || i.id, content: i.content, description: '',
        priority: i.priority || 1, labels: i.labels || [], due: i.due || null,
        section_id: i.sectionId || i.section_id || null,
        parent_id: null, responsible_uid: i.responsible_uid || null, _status: 'completed',
    }));

    // Fetch individual tasks to recover parent_id (completed API doesn't provide it)
    await parallelLimit(
        tasks.map(t => async () => {
            try {
                const full = await api('GET', `/tasks/${t.id}`);
                if (full) {
                    t.parent_id = full.parent_id || null;
                    if (full.responsible_uid) t.responsible_uid = full.responsible_uid;
                    if (full.labels && full.labels.length) t.labels = full.labels;
                    if (full.priority) t.priority = full.priority;
                }
            } catch { /* deleted task, skip */ }
        }),
        10
    );

    return tasks;
}

async function parallelLimit(tasks, limit, onProgress) {
    let ok = 0, fail = 0, idx = 0;
    async function run() {
        while (idx < tasks.length) {
            const i = idx++;
            try { await tasks[i](); ok++; } catch { fail++; }
            if (onProgress) await onProgress(ok + fail, tasks.length);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, run));
    return { completed: ok, failed: fail };
}
