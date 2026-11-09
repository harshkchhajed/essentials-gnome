/*
 * Display Layout: remembers monitor arrangements and puts them back.
 *
 * GNOME's own monitors.xml keys layouts by connector name, and on this laptop
 * the same screen shows up as eDP-1, eDP-1-1 or DP-4 (and HDMI-0 / HDMI-1-0)
 * depending on which GPU drives it, so saved layouts often stop matching.
 * Here a layout is keyed by the set of monitors' vendor + product + serial,
 * and restored automatically whenever monitors change.
 *
 * Quick modes for a laptop with external screens:
 *  - External Only: laptop screen off, externals on.
 *  - Join Displays: everything on, arranged as last joined (remembered here,
 *    else taken from GNOME's monitors.xml history, else laptop on the left).
 * The chosen mode becomes the saved layout, so auto-restore keeps it.
 *
 * Stored in ~/.config/display-layouts.json:
 *   layouts[key]  - the layout to restore for that set of monitors
 *   joined[key]   - the last arrangement with every monitor on
 *   builtins      - ids of laptop panels (for when they show up as DP-x)
 */
const { GLib, Gio, Meta } = imports.gi;
const Main = imports.ui.main;
const PopupMenu = imports.ui.popupMenu;
const Util = imports.misc.util;

const STORE = GLib.build_filenamev([GLib.get_user_config_dir(), 'display-layouts.json']);
const GNOME_XML = GLib.build_filenamev([GLib.get_user_config_dir(), 'monitors.xml']);
const SETTLE_MS = 1500;   // monitors often change several times while plugging in
const RETRY_GUARD_S = 15; // don't fight Mutter if a restore doesn't stick
// Auto-restore only right after the set of monitors changes (plug, unplug,
// login). Later changes with the same monitors are the user's own (Settings,
// lid) and are left alone.
const RESTORE_WINDOW_S = 10;

let store, submenu, joinItem, externalItem, restoreItem, forgetItem, autoItem;
let changedId, settleId, menuOpenId, lastAuto, lastKey, keyChangedAt;

/* ---------- storage ---------- */

function load() {
    let saved = {};
    try {
        const [, bytes] = GLib.file_get_contents(STORE);
        saved = JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) {}
    return Object.assign({ auto: true, layouts: {}, joined: {}, builtins: [] }, saved);
}

function persist() {
    GLib.file_set_contents_full(STORE, JSON.stringify(store, null, 2), GLib.FileSetContentsFlags.CONSISTENT, 0o600);
}

/* ---------- Mutter D-Bus ---------- */

function call(method, params, type) {
    return new Promise((resolve, reject) => {
        Gio.DBus.session.call('org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig',
            'org.gnome.Mutter.DisplayConfig', method, params, type ? new GLib.VariantType(type) : null,
            Gio.DBusCallFlags.NONE, -1, null, (conn, res) => {
                try {
                    resolve(conn.call_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

const idOf = (vendor, product, serial) => `${vendor} ${product} ${serial}`;

async function currentState() {
    const [serial, monitors, logical] = (await call('GetCurrentState', null,
        '(ua((ssss)a(siiddada{sv})a{sv})a(iiduba(ssss)a{sv})a{sv})')).recursiveUnpack();
    let mons = monitors.map(([spec, modes, props]) => ({
        connector: spec[0],
        id: idOf(spec[1], spec[2], spec[3]),
        modes,
        current: modes.find(m => m[6]['is-current']),
        preferred: modes.find(m => m[6]['is-preferred']) ?? modes[0],
        builtin: !!props['is-builtin'],
    }));
    // Remember laptop panels, so they are still recognised when they show up
    // as a plain DP-x connector.
    for (const m of mons) {
        if (m.builtin && !store.builtins.includes(m.id)) {
            store.builtins.push(m.id);
            persist();
        }
        m.builtin ||= store.builtins.includes(m.id) || /^(eDP|LVDS|DSI)/.test(m.connector);
    }
    // Identical models often share an EDID serial: number duplicates in
    // connector order so each one keeps its own place.
    mons.sort((a, b) => a.connector.localeCompare(b.connector));
    const seen = {};
    for (const m of mons) {
        seen[m.id] = (seen[m.id] ?? 0) + 1;
        if (mons.filter(o => o.id === m.id).length > 1)
            m.uid = `${m.id} #${seen[m.id]}`;
    }
    mons = mons.map(m => ({ ...m, id: m.uid ?? m.id }));
    const key = mons.map(m => m.id).sort().join(' + ');
    return { serial, mons, logical, key };
}

function snapshot(state) {
    // One entry per active monitor in the current arrangement.
    const out = [];
    for (const [x, y, scale, transform, primary, specs] of state.logical) {
        for (const spec of specs) {
            const mon = state.mons.find(m => m.connector === spec[0]);
            if (!mon?.current)
                continue;
            const [, w, h, rate] = mon.current;
            out.push({ id: mon.id, x, y, scale, transform, primary, w, h, rate });
        }
    }
    return out;
}

function matches(state, saved) {
    const now = snapshot(state);
    return saved.length === now.length && saved.every(s => {
        const n = now.find(m => m.id === s.id);
        return n && n.x === s.x && n.y === s.y && n.primary === s.primary &&
            n.w === s.w && n.h === s.h && n.scale === s.scale && n.transform === s.transform &&
            Math.abs(n.rate - s.rate) < 0.5;
    });
}

async function apply(state, layout) {
    const logical = [];
    for (const s of layout) {
        const mon = state.mons.find(m => m.id === s.id);
        if (!mon)
            return false;
        // Same resolution, refresh rate as close as possible to the saved one.
        const mode = mon.modes.filter(m => m[1] === s.w && m[2] === s.h)
            .sort((a, b) => Math.abs(a[3] - s.rate) - Math.abs(b[3] - s.rate))[0] ??
            mon.current ?? mon.preferred;
        logical.push([s.x, s.y, s.scale, s.transform, s.primary, [[mon.connector, mode[0], {}]]]);
    }
    // Method 1 = temporary: applied without the "Keep changes?" prompt.
    await call('ApplyMonitorsConfig', new GLib.Variant('(uua(iiduba(ssa{sv}))a{sv})',
        [state.serial, 1, logical, {}]), null);
    return true;
}

/* ---------- join / external only ---------- */

const isFull = (state, layout) => layout?.length === state.mons.length;
const isExternalOnly = state => {
    const active = snapshot(state).map(s => s.id);
    return state.mons.some(m => m.builtin) && active.length > 0 &&
        state.mons.every(m => m.builtin !== active.includes(m.id));
};

function entryFor(state, mon, x, y, primary) {
    // Keeps the monitor's current scale and rotation when it is on.
    const [, w, h, rate] = mon.current ?? mon.preferred;
    const lm = state.logical.find(l => l[5].some(spec => spec[0] === mon.connector));
    return { id: mon.id, x, y, scale: lm?.[2] ?? 1, transform: lm?.[3] ?? 0, primary, w, h, rate };
}

function sizeOf(s) {
    // Size on the desktop: rotated 90°/270° (transforms 1, 3, 5, 7) swaps w/h.
    const turned = s.transform % 2 === 1;
    return [(turned ? s.h : s.w) / s.scale, (turned ? s.w : s.h) / s.scale];
}

function pack(layout) {
    // Move to the origin and close horizontal gaps (e.g. the hole left by
    // the laptop between two externals); stacked monitors keep their offset.
    const out = layout.map(s => ({ ...s })).sort((a, b) => a.x - b.x);
    const minY = Math.min(...out.map(s => s.y));
    let cursor = 0, prev = null;
    for (const s of out) {
        const origX = s.x;
        const overlapsPrev = prev && origX < prev.origX + sizeOf(prev)[0];
        s.x = overlapsPrev ? prev.x + (origX - prev.origX) : cursor;
        s.y -= minY;
        cursor = Math.max(cursor, s.x + sizeOf(s)[0]);
        prev = { ...s, origX };
    }
    return out.map(s => ({ ...s, x: Math.round(s.x), y: Math.round(s.y) }));
}

function fromGnomeHistory(state) {
    // The last arrangement in GNOME's monitors.xml with exactly these
    // monitors, matched by identity instead of connector name.
    let xml;
    try {
        xml = new TextDecoder().decode(GLib.file_get_contents(GNOME_XML)[1]);
    } catch (e) {
        return null;
    }
    const tag = (s, t) => s.match(new RegExp(`<${t}>([^<]*)</${t}>`))?.[1];
    const rotations = { normal: 0, left: 1, 'upside_down': 2, right: 3 };
    let found = null;
    for (const [conf] of xml.matchAll(/<configuration>[\s\S]*?<\/configuration>/g)) {
        if (conf.includes('<disabled>'))
            continue;
        const layout = [...conf.matchAll(/<logicalmonitor>[\s\S]*?<\/logicalmonitor>/g)].map(([lm]) => ({
            id: idOf(tag(lm, 'vendor'), tag(lm, 'product'), tag(lm, 'serial')),
            x: Number(tag(lm, 'x')),
            y: Number(tag(lm, 'y')),
            scale: Number(tag(lm, 'scale') ?? 1),
            transform: rotations[tag(lm, 'rotation') ?? 'normal'] ?? 0,
            primary: tag(lm, 'primary') === 'yes',
            w: Number(tag(lm, 'width')),
            h: Number(tag(lm, 'height')),
            rate: Number(tag(lm, 'rate')),
        }));
        const ids = layout.map(l => l.id).sort().join(' + ');
        if (ids === state.key)
            found = layout;
    }
    return found;
}

function defaultJoin(state) {
    // Laptop on the left, externals to its right, first external primary.
    const laptop = state.mons.filter(m => m.builtin);
    const externals = state.mons.filter(m => !m.builtin);
    let x = 0;
    return [...laptop, ...externals].map(m => {
        const e = entryFor(state, m, x, 0, m === externals[0]);
        x += sizeOf(e)[0];
        return e;
    });
}

function joinLayout(state) {
    const saved = store.layouts[state.key];
    return store.joined[state.key] ?? (isFull(state, saved) ? saved : null) ??
        fromGnomeHistory(state) ?? defaultJoin(state);
}

function rememberJoin(state) {
    const now = snapshot(state);
    if (isFull(state, now))
        store.joined[state.key] = now;
}

async function externalOnly() {
    const state = await currentState();
    const externals = state.mons.filter(m => !m.builtin);
    if (!externals.length || externals.length === state.mons.length) {
        Main.notify('Display Layout', 'Connect an external monitor first.');
        return;
    }
    rememberJoin(state);   // so Join puts things back exactly like this
    // Keep the externals' arrangement among themselves. All positions come
    // from one layout (current if every external is on, else the join
    // layout), so they share one coordinate frame.
    const now = snapshot(state);
    const source = externals.every(m => now.some(s => s.id === m.id)) ? now : joinLayout(state);
    const layout = pack(externals.map(m => source.find(s => s.id === m.id) ??
        entryFor(state, m, 0, 0, false)));
    if (!layout.some(s => s.primary))
        layout[0].primary = true;
    store.layouts[state.key] = layout;
    persist();
    await apply(state, layout);
}

async function join() {
    const state = await currentState();
    const layout = joinLayout(state);
    store.layouts[state.key] = layout;
    store.joined[state.key] = layout;
    persist();
    if (!matches(state, layout))
        await apply(state, layout);
}

/* ---------- save / restore / forget ---------- */

async function restore(manual) {
    const state = await currentState();
    const saved = store.layouts[state.key];
    if (!saved) {
        if (manual)
            Main.notify('Display Layout', 'No saved layout for these monitors yet.');
        return;
    }
    if (matches(state, saved)) {
        if (manual)
            Main.notify('Display Layout', 'Already in the saved layout.');
        return;
    }
    if (!manual) {
        // If Mutter keeps undoing it, stop after one try per monitor set.
        const now = GLib.get_monotonic_time() / 1e6;
        if (lastAuto?.key === state.key && now - lastAuto.time < RETRY_GUARD_S)
            return;
        lastAuto = { key: state.key, time: now };
    }
    await apply(state, saved);
}

async function save() {
    const state = await currentState();
    store.layouts[state.key] = snapshot(state);
    rememberJoin(state);
    persist();
    const n = state.mons.length;
    Main.notify('Display Layout saved',
        `It will be restored whenever ${n === 1 ? 'this screen is' : `these ${n} screens are`} connected.`);
}

async function forget() {
    const state = await currentState();
    delete store.layouts[state.key];
    delete store.joined[state.key];
    persist();
    Main.notify('Display Layout', 'Saved layout for these screens deleted. Nothing will be restored ' +
        'automatically until you save again.');
}

function report(e) {
    logError(e, 'essentials display-layout');
    Main.notify('Display Layout', `Couldn't change the layout: ${e.message}`);
}

/* ---------- menu ---------- */

async function refreshMenu() {
    if (!submenu)
        return;
    try {
        const state = await currentState();
        const saved = !!store.layouts[state.key];
        const canSwitch = state.mons.some(m => m.builtin) && state.mons.some(m => !m.builtin);
        const extOnly = isExternalOnly(state);
        joinItem.visible = externalItem.visible = canSwitch;
        joinItem.setOrnament(canSwitch && !extOnly ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
        externalItem.setOrnament(extOnly ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
        restoreItem.setSensitive(saved);
        forgetItem.setSensitive(saved);
        submenu.label.text = saved ? 'Display Layout' : 'Display Layout (not saved)';
    } catch (e) {
        logError(e, 'essentials display-layout');
    }
}

function onMonitorsChanged() {
    if (settleId)
        GLib.source_remove(settleId);
    settleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_MS, () => {
        settleId = 0;
        refreshMenu();
        autoRestore().catch(e => logError(e, 'essentials display-layout'));
        return GLib.SOURCE_REMOVE;
    });
}

async function autoRestore() {
    const state = await currentState();
    if (!store)
        return;   // disabled meanwhile
    const now = GLib.get_monotonic_time() / 1e6;
    if (state.key !== lastKey) {
        lastKey = state.key;
        keyChangedAt = now;
    }
    if (store.auto && now - keyChangedAt < RESTORE_WINDOW_S)
        await restore(false);
}

function buildMenu() {
    submenu = new PopupMenu.PopupSubMenuMenuItem('Display Layout', true);
    submenu.icon.icon_name = 'video-display-symbolic';
    const m = submenu.menu;

    joinItem = m.addAction('Join Displays', () => join().catch(report));
    externalItem = m.addAction('External Only (laptop screen off)', () => externalOnly().catch(report));
    m.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    restoreItem = m.addAction('Restore Saved Layout', () => restore(true).catch(report));
    m.addAction('Save Current Layout', () => save().catch(report));
    forgetItem = m.addAction('Forget Saved Layout', () => forget().catch(report));
    autoItem = new PopupMenu.PopupSwitchMenuItem('Restore Automatically', store.auto);
    autoItem.connect('toggled', (item, state) => {
        store.auto = state;
        persist();
    });
    m.addMenuItem(autoItem);
    m.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    m.addAction('Display Settings', () => Util.spawn(['gnome-control-center', 'display']));

    const agg = Main.panel.statusArea.aggregateMenu;
    const items = agg.menu._getMenuItems();
    const at = agg._system ? items.indexOf(agg._system.menu) : -1;
    agg.menu.addMenuItem(submenu, at >= 0 ? at : undefined);
    menuOpenId = agg.menu.connect('open-state-changed', (menu, open) => {
        if (open)
            refreshMenu();
    });
}

/* ---------- lifecycle ---------- */


function enable(_settings) {
    store = load();
    lastAuto = lastKey = null;
    keyChangedAt = 0;
    buildMenu();
    changedId = Meta.MonitorManager.get().connect('monitors-changed', onMonitorsChanged);
    onMonitorsChanged();   // also covers login and shell restarts
}

function disable() {
    if (settleId)
        GLib.source_remove(settleId);
    Meta.MonitorManager.get().disconnect(changedId);
    Main.panel.statusArea.aggregateMenu.menu.disconnect(menuOpenId);
    submenu.destroy();
    settleId = changedId = menuOpenId = 0;
    submenu = joinItem = externalItem = restoreItem = forgetItem = autoItem = store = null;
}
