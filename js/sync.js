// ── Sync API Layer ──
// Uses Todoist Sync API v1 for efficient reads and batched writes.
// Stores sync_token for incremental updates (delta sync).

const SYNC_URL = 'https://api.todoist.com/api/v1/sync';

function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

// ── Full/Incremental Sync (read) ──
async function syncRead(resourceTypes, forceFullSync) {
    const token = forceFullSync ? '*' : (S.syncToken || '*');
    const params = new URLSearchParams();
    params.set('sync_token', token);
    params.set('resource_types', JSON.stringify(resourceTypes));

    const r = await fetch(SYNC_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${S.token}` },
        body: params,
    });

    if (r.status === 429) {
        const retryAfter = parseInt(r.headers.get('Retry-After') || '5');
        showToast(`Rate-Limit erreicht. Warte ${retryAfter}s...`, 'error');
        await new Promise(res => setTimeout(res, retryAfter * 1000));
        return syncRead(resourceTypes, forceFullSync);
    }

    if (!r.ok) throw new Error(`Sync API ${r.status}: ${await r.text()}`);
    const data = await r.json();
    S.syncToken = data.sync_token;
    return data;
}

// ── Batch Commands (write) ──
async function syncWrite(commands) {
    if (!commands.length) return {};
    // Add UUIDs to commands that don't have them
    commands.forEach(c => { if (!c.uuid) c.uuid = generateUUID(); });

    const params = new URLSearchParams();
    params.set('sync_token', S.syncToken || '*');
    params.set('resource_types', '["items"]');
    params.set('commands', JSON.stringify(commands));

    const r = await fetch(SYNC_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${S.token}` },
        body: params,
    });

    if (r.status === 429) {
        const retryAfter = parseInt(r.headers.get('Retry-After') || '5');
        showToast(`Rate-Limit erreicht. Warte ${retryAfter}s...`, 'error');
        await new Promise(res => setTimeout(res, retryAfter * 1000));
        return syncWrite(commands);
    }

    if (!r.ok) throw new Error(`Sync API ${r.status}: ${await r.text()}`);
    const data = await r.json();
    S.syncToken = data.sync_token;

    // Check for command errors
    const errors = [];
    if (data.sync_status) {
        Object.entries(data.sync_status).forEach(([uuid, status]) => {
            if (status !== 'ok') errors.push({ uuid, status });
        });
    }

    return { data, errors };
}

// ── Convenience: single command ──
async function syncCommand(type, args) {
    const cmd = { type, uuid: generateUUID(), args };
    const { errors } = await syncWrite([cmd]);
    if (errors && errors.length) throw new Error(JSON.stringify(errors[0].status));
    return true;
}

// ── Convenience: batch multiple same-type commands ──
async function syncBatchCommands(commands) {
    // Split into chunks of 100 (API limit)
    const results = { ok: 0, failed: 0 };
    for (let i = 0; i < commands.length; i += 100) {
        const chunk = commands.slice(i, i + 100);
        const { errors } = await syncWrite(chunk);
        results.ok += chunk.length - (errors ? errors.length : 0);
        results.failed += errors ? errors.length : 0;
    }
    return results;
}
