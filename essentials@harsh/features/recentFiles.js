/*
 * Recent files: a top-bar button (left, after the app name).
 *  - After a download finishes, it shows the file name for a few minutes;
 *    one left click opens the file. After a screenshot, one click copies
 *    the image to the clipboard.
 *  - Right click, left click when nothing is fresh, or Super+R opens a menu
 *    with the latest downloads, screenshots and recently used files. Each row
 *    has actions on hover: open with, show in Files, copy file, copy path,
 *    move to trash. Dragging a row drags the file into any app: the menu
 *    closes (freeing the pointer) and helpers/drag-file.js takes over the
 *    drag in progress.
 *  - Hovering a row (preview-delay ms) shows a quick-look card beside the
 *    menu (Space shows it at once); clicking the card opens the file, or
 *    one of the app buttons on it opens it with that app.
 *
 * All file listing is asynchronous: the menu opens instantly from the last
 * known lists and refreshes in the background, so a slow disk or network
 * mount never freezes the desktop. The file sections scroll.
 */
const { GLib, Gio, St, Clutter, Shell, Meta } = imports.gi;
const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const { Preview, appsFor } = Me.imports.features.preview;
const { Tooltip } = Me.imports.features.tooltip;
const { ScrollableSection } = Me.imports.features.scrollMenu;

const SHOTS_N = 4;
const NAME_MAX = 32;
const RESCAN_MS = 700;   // debounce: browsers create, write and rename in quick succession
// Browsers write these while a download is still in progress.
const PARTIAL = /\.(crdownload|part|partial|download|tmp)$/i;
const RECENT_XBEL = GLib.build_filenamev([GLib.get_user_data_dir(), 'recently-used.xbel']);
const LIST_ATTRS = 'standard::name,standard::type,standard::is-hidden,standard::size,' +
    'standard::symbolic-icon,time::modified,time::changed';

let button, icon, label, settings, expireId, cancellable;
let files, footer;       // ScrollableSection with the file rows; fixed footer section
let watches = [];        // [{dir, kind, monitor, rescanId}]
let xbelMonitor, xbelId = 0;
let data = { dl: [], shots: [], recent: [] };   // entries: {file, time, icon}
let extDir, preview, hoverId, tooltip, dragState;
let openWithMode = false;
// Kept across disable/enable (the lock screen disables extensions), so a
// fresh download stays in the top bar and isn't announced twice.
let fresh = null;        // {file, kind, icon, time}
const seenNewest = new Map();   // dir path -> "path size" of the newest file already seen

/* ---------- helpers ---------- */

function shorten(name) {
    if (name.length <= NAME_MAX)
        return name;
    // Keep the extension visible: "very_long_na….pdf"
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 6 ? name.slice(dot) : '';
    return `${name.slice(0, NAME_MAX - ext.length - 1)}…${ext}`;
}

function ago(seconds) {
    if (seconds < 60)
        return 'now';
    if (seconds < 3600)
        return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400)
        return `${Math.floor(seconds / 3600)}h`;
    return `${Math.floor(seconds / 86400)}d`;
}

const now = () => GLib.get_real_time() / 1e6;
const FALLBACK_ICON = Gio.ThemedIcon.new('text-x-generic-symbolic');

function timeOf(info) {
    // ctime also changes on rename/move, so files moved in (or extracted, or
    // downloaded with wget -N) still count as new.
    return Math.max(info.get_attribute_uint64('time::modified'), info.get_attribute_uint64('time::changed'));
}

function launchContext() {
    return global.create_app_launch_context(0, -1);
}

function openFile(file) {
    try {
        Gio.AppInfo.launch_default_for_uri(file.get_uri(), launchContext());
    } catch (e) {
        Main.notify('Could not open file', e.message);
    }
}

function launchWith(app, file) {
    try {
        app.launch([file], launchContext());
    } catch (e) {
        Main.notify(`Could not open with ${app.get_display_name()}`, e.message);
    }
}

function asyncCall(fn) {
    // Wrap a Gio *_async/_finish pair into a promise.
    return new Promise((resolve, reject) => fn((obj, res, finish) => {
        try {
            resolve(finish(res));
        } catch (e) {
            reject(e);
        }
    }));
}

/* ---------- per-file actions ---------- */

function showInFiles(file) {
    // Opens the folder with the file selected.
    Gio.DBus.session.call('org.freedesktop.FileManager1', '/org/freedesktop/FileManager1',
        'org.freedesktop.FileManager1', 'ShowItems',
        new GLib.Variant('(ass)', [[file.get_uri()], '']),
        null, Gio.DBusCallFlags.NONE, -1, null, (c, res) => {
            try {
                c.call_finish(res);
            } catch (e) {
                openFile(file.get_parent());
            }
        });
}

function copyPath(file) {
    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, file.get_path());
    Main.notify('Path copied', file.get_path());
}

function copyFile(file) {
    // A helper process offers the file in all the formats apps expect.
    try {
        Gio.Subprocess.new(['gjs', GLib.build_filenamev([extDir, 'copy-file.js']), file.get_uri()],
            Gio.SubprocessFlags.NONE);
        Main.notify('File copied', `${file.get_basename()} — paste it in Files, a browser or chat`);
    } catch (e) {
        Main.notify('Could not copy file', e.message);
    }
}

function copyImage(file) {
    // Offered with its real type (PNG, JPEG, WebP...), read asynchronously.
    file.query_info_async('standard::content-type', 0, GLib.PRIORITY_DEFAULT, null, (f, res) => {
        let type;
        try {
            type = f.query_info_finish(res).get_content_type();
        } catch (e) {
            Main.notify('Could not copy screenshot', e.message);
            return;
        }
        f.load_contents_async(null, (f2, r) => {
            try {
                const [, bytes] = f2.load_contents_finish(r);
                St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD, type, new GLib.Bytes(bytes));
                Main.notify('Screenshot copied', file.get_basename());
            } catch (e) {
                Main.notify('Could not copy screenshot', e.message);
            }
        });
    });
}

function cancelDrag() {
    if (!dragState)
        return;
    if (dragState.createdId)
        global.display.disconnect(dragState.createdId);
    if (dragState.timeoutId)
        GLib.source_remove(dragState.timeoutId);
    dragState = null;
}

function dragFile(file, continuing) {
    // Start drag-file.js and put its window under the pointer, on top of
    // other windows. continuing: it picks up the drag still in progress
    // (falls back to a draggable tile if the button was already released).
    cancelDrag();
    const [px, py] = global.get_pointer();
    dragState = {};
    dragState.createdId = global.display.connect('window-created', (d, win) => {
        if (win.get_wm_class()?.toLowerCase() !== 'recent-files-drag')
            return;
        cancelDrag();
        const actor = win.get_compositor_private();
        const id = actor.connect('first-frame', () => {
            actor.disconnect(id);
            const r = win.get_frame_rect();
            win.move_frame(true, Math.round(px - r.width / 2), Math.round(py - r.height / 2));
            win.make_above();
            win.activate(global.get_current_time());
        });
    });
    dragState.timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 10, () => {
        dragState.timeoutId = 0;   // the helper never showed up
        cancelDrag();
        return GLib.SOURCE_REMOVE;
    });
    try {
        Gio.Subprocess.new(['gjs', GLib.build_filenamev([extDir, 'drag-file.js']),
            ...continuing ? ['--continue'] : [], file.get_uri()], Gio.SubprocessFlags.NONE);
    } catch (e) {
        cancelDrag();
        Main.notify('Could not start drag', e.message);
    }
}

function trashFile(file) {
    file.trash_async(GLib.PRIORITY_DEFAULT, null, (f, res) => {
        try {
            f.trash_finish(res);
            if (fresh?.file.equal(file))
                clearFresh();
        } catch (e) {
            Main.notify('Could not move to Trash', e.message);
        }
    });
}

/* ---------- data (all async) ---------- */

async function latestIn(dir, n) {
    // Newest completed, non-hidden regular files in dir: [{file, time, icon}]
    let en;
    try {
        en = await asyncCall(cb => dir.enumerate_children_async(LIST_ATTRS, 0, GLib.PRIORITY_DEFAULT,
            cancellable, (o, r) => cb(o, r, x => o.enumerate_children_finish(x))));
    } catch (e) {
        return [];   // missing folder, no access, cancelled
    }
    const infos = [];
    for (;;) {
        let batch;
        try {
            batch = await asyncCall(cb => en.next_files_async(100, GLib.PRIORITY_DEFAULT, cancellable,
                (o, r) => cb(o, r, x => o.next_files_finish(x))));
        } catch (e) {
            break;
        }
        if (!batch.length)
            break;
        infos.push(...batch);
    }
    en.close_async(GLib.PRIORITY_DEFAULT, null, null);
    const names = new Set(infos.map(i => i.get_name()));
    return infos
        .filter(i => {
            const name = i.get_name();
            // Firefox creates an empty file with the final name next to
            // "name.part" while downloading.
            return !i.get_is_hidden() && !PARTIAL.test(name) &&
                i.get_file_type() === Gio.FileType.REGULAR &&
                !names.has(`${name}.part`) && i.get_size() > 0;
        })
        .map(i => ({ file: dir.get_child(i.get_name()), time: timeOf(i), icon: i.get_symbolic_icon(), size: i.get_size() }))
        .sort((a, b) => b.time - a.time)
        .slice(0, n);
}

function xmlDecode(s) {
    return s.replace(/&(amp|apos|quot|lt|gt|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
        const named = { amp: '&', apos: "'", quot: '"', lt: '<', gt: '>' }[e.toLowerCase()];
        if (named)
            return named;
        return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1)));
    });
}

async function recentFiles(n, exclude) {
    // Recently used files from GTK's recently-used.xbel: [{file, time, icon}]
    let text;
    try {
        const [, bytes] = await asyncCall(cb => Gio.File.new_for_path(RECENT_XBEL).load_contents_async(cancellable,
            (o, r) => cb(o, r, x => o.load_contents_finish(x))));
        text = new TextDecoder().decode(bytes);
    } catch (e) {
        return [];
    }
    const items = new Map();   // uri -> time
    for (const [tag] of text.matchAll(/<bookmark\s[^>]*>/g)) {
        const attr = {};
        for (const [, k, v] of tag.matchAll(/([\w:-]+)="([^"]*)"/g))
            attr[k] = xmlDecode(v);
        if (!attr.href?.startsWith('file:'))
            continue;
        const t = Math.max(Date.parse(attr.modified) || 0, Date.parse(attr.visited) || 0) / 1000;
        items.set(attr.href, Math.max(t, items.get(attr.href) ?? 0));
    }
    const candidates = [...items].sort((a, b) => b[1] - a[1])
        .map(([uri, time]) => ({ file: Gio.File.new_for_uri(uri), time }))
        .filter(e => !exclude(e.file))
        .slice(0, n * 3);
    // Keep regular files that still exist (checked in parallel, off-thread).
    const checked = await Promise.all(candidates.map(e => asyncCall(cb =>
        e.file.query_info_async('standard::type,standard::symbolic-icon', 0, GLib.PRIORITY_DEFAULT, cancellable,
            (o, r) => cb(o, r, x => o.query_info_finish(x))))
        .then(info => info.get_file_type() === Gio.FileType.REGULAR ? { ...e, icon: info.get_symbolic_icon() } : null)
        .catch(() => null)));
    return checked.filter(e => e).slice(0, n);
}

async function refresh() {
    // Reload all lists; repaint the menu if it is open and nothing is in use.
    const [dlW, shotW] = watches;
    const n = settings.get_int('list-length');
    const [dl, shots] = await Promise.all([
        latestIn(dlW.dir, n),
        shotW && settings.get_boolean('show-screenshots') ? latestIn(shotW.dir, SHOTS_N) : [],
    ]);
    const listed = new Set([...dl, ...shots].map(e => e.file.get_path()));
    const recent = settings.get_boolean('show-recent')
        ? await recentFiles(n, f => listed.has(f.get_path()) || (shotW && f.has_parent(shotW.dir)))
        : [];
    if (!button || cancellable.is_cancelled())
        return;
    const key = d => [...d.dl, ...d.shots, ...d.recent].map(e => `${e.file.get_uri()} ${e.time}`).join('\n');
    const changed = key(data) !== key({ dl, shots, recent });
    data = { dl, shots, recent };
    if (changed && button.menu.isOpen && !openWithMode && !hoverId && !preview.file)
        rebuildMenu();
}

/* ---------- top-bar state ---------- */

function showFresh(entry, kind) {
    fresh = { ...entry, kind };
    icon.gicon = entry.icon ?? FALLBACK_ICON;
    label.text = shorten(entry.file.get_basename());
    label.show();
}

function clearFresh() {
    fresh = null;
    icon.icon_name = 'document-open-recent-symbolic';
    label.hide();
}

async function rescan(w) {
    const [newest] = await latestIn(w.dir, 1);
    if (!newest || !button)
        return;
    const key = `${newest.file.get_path()} ${newest.size}`;
    const dirKey = w.dir.get_path();
    if (seenNewest.has(dirKey) && seenNewest.get(dirKey) !== key &&
        now() - newest.time < settings.get_int('fresh-minutes') * 60)
        showFresh(newest, w.kind);
    seenNewest.set(dirKey, key);
}

function watch(dir, kind) {
    const w = { dir, kind, rescanId: 0, monitor: null };
    try {
        // A missing folder is fine: GLib polls until it appears.
        w.monitor = dir.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
        w.monitor.connect('changed', () => {
            if (w.rescanId)
                GLib.source_remove(w.rescanId);
            w.rescanId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RESCAN_MS, () => {
                w.rescanId = 0;
                rescan(w).then(refresh).catch(logError);
                return GLib.SOURCE_REMOVE;
            });
        });
    } catch (e) {}
    watches.push(w);
    rescan(w).catch(logError);   // first run only records what's already there
}

function expireFresh() {
    if (fresh && now() - fresh.time >= settings.get_int('fresh-minutes') * 60)
        clearFresh();
    else if (fresh)   // deleted or moved: drop it
        fresh.file.query_info_async('standard::type', 0, GLib.PRIORITY_DEFAULT, null, (f, res) => {
            try {
                f.query_info_finish(res);
            } catch (e) {
                if (fresh?.file.equal(f))
                    clearFresh();
            }
        });
    return GLib.SOURCE_CONTINUE;
}

function useFresh() {
    if (fresh.kind === 'screenshot')
        copyImage(fresh.file);
    else
        openFile(fresh.file);
    clearFresh();
}

function screenshotsDir() {
    // GNOME names the folder in the session language.
    const pictures = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES);
    if (!pictures)
        return null;
    const local = imports.gettext.dgettext('gnome-shell', 'Screenshots');
    const localized = GLib.build_filenamev([pictures, local]);
    return GLib.file_test(localized, GLib.FileTest.IS_DIR) ? localized : GLib.build_filenamev([pictures, 'Screenshots']);
}

/* ---------- menu ---------- */

function actionButton(iconName, tip, callback) {
    const b = new St.Button({
        child: new St.Icon({ icon_name: iconName, icon_size: 14 }),
        style_class: 'button',
        style: 'padding: 2px 5px; margin-left: 2px; min-height: 0; border-radius: 6px;',
        accessible_name: tip,
        can_focus: true,
    });
    tooltip.attach(b, tip);
    b.connect('clicked', () => {
        button.menu.close();
        callback();
    });
    return b;
}

function addFileItem(section, entry, kind) {
    const { file, time } = entry;
    const item = new PopupMenu.PopupBaseMenuItem();
    item.add_child(new St.Icon({ gicon: entry.icon ?? FALLBACK_ICON, style_class: 'popup-menu-icon' }));
    item.add_child(new St.Label({
        text: shorten(file.get_basename()),
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
    }));

    // Hover/keyboard focus swaps the age for the action buttons. Both sit in
    // one BinLayout cell, so the menu is always wide enough for the buttons.
    const when = new St.Label({
        text: ago(now() - time),
        x_align: Clutter.ActorAlign.END,
        y_align: Clutter.ActorAlign.CENTER,
        style: 'color: #999; padding-left: 12px;',
    });
    const actions = new St.BoxLayout({ x_align: Clutter.ActorAlign.END, opacity: 0 });
    if (kind === 'screenshot')
        actions.add_child(actionButton('edit-paste-symbolic', 'Copy image', () => copyImage(file)));
    actions.add_child(actionButton('view-more-horizontal-symbolic', 'Open with…',
        () => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            showOpenWith(file);
            return GLib.SOURCE_REMOVE;
        })));
    actions.add_child(actionButton('folder-open-symbolic', 'Show in Files', () => showInFiles(file)));
    actions.add_child(actionButton('edit-copy-symbolic', 'Copy file', () => copyFile(file)));
    actions.add_child(actionButton('insert-link-symbolic', 'Copy path', () => copyPath(file)));
    actions.add_child(actionButton('user-trash-symbolic', 'Move to Trash', () => trashFile(file)));
    const cell = new St.Widget({ layout_manager: new Clutter.BinLayout(), style: 'padding-left: 12px;' });
    cell.add_child(when);
    cell.add_child(actions);
    item.add_child(cell);
    const sync = () => {
        const on = item.hover || item.active;
        actions.opacity = on ? 255 : 0;
        when.opacity = on ? 0 : 255;
        for (const b of actions.get_children()) {   // invisible buttons must not be clickable
            b.reactive = on;
            b.can_focus = on;
        }
    };
    item.connect('notify::hover', sync);
    item.connect('notify::active', sync);
    sync();

    // Quick look: hover for preview-delay ms, or press Space on the row.
    item.connect('notify::hover', () => {
        cancelHover();
        if (!item.hover)
            return;   // leaving toward the card keeps it open
        if (preview.file && !preview.file.equal(file))
            preview.hide();   // moved to another row
        const delay = settings.get_int('preview-delay');
        if (!delay)
            return;   // hover preview turned off
        hoverId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            hoverId = 0;
            preview.show(file, item);
            return GLib.SOURCE_REMOVE;
        });
    });
    item.connect('key-press-event', (actor, event) => {
        if (event.get_key_symbol() !== Clutter.KEY_space)
            return Clutter.EVENT_PROPAGATE;
        cancelHover();
        if (preview.file?.equal(file))
            preview.hide();
        else
            preview.show(file, item);
        return Clutter.EVENT_STOP;   // Space would otherwise open the file
    });

    // Press and move past the drag threshold: hand the drag to drag-file.js.
    let pressAt = null;
    item.connect('button-press-event', (actor, event) => {
        if (event.get_button() === Clutter.BUTTON_PRIMARY)
            pressAt = event.get_coords();
        return Clutter.EVENT_PROPAGATE;
    });
    item.connect('button-release-event', () => {
        pressAt = null;
        return Clutter.EVENT_PROPAGATE;
    });
    item.connect('motion-event', (actor, event) => {
        if (!pressAt || !(event.get_state() & Clutter.ModifierType.BUTTON1_MASK))
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        const threshold = Clutter.Settings.get_default().dnd_drag_threshold;
        if (Math.hypot(x - pressAt[0], y - pressAt[1]) < threshold)
            return Clutter.EVENT_PROPAGATE;
        pressAt = null;
        cancelHover();
        button.menu.close();   // releases the pointer grab
        dragFile(file, true);
        return Clutter.EVENT_STOP;
    });

    item.connect('activate', () => {
        openFile(file);
        if (fresh?.file.equal(file))
            clearFresh();
    });
    section.addMenuItem(item);
}

function cancelHover() {
    if (hoverId) {
        GLib.source_remove(hoverId);
        hoverId = 0;
    }
}

function hookPreviewClicks() {
    // The open menu holds a Clutter grab, so clicks on the card arrive here as
    // captured events. GNOME's menu manager (connected earlier) closes the
    // menu on any outside click; the card hides one idle later, so it is
    // still visible to this check.
    button.menu.actor.connect('captured-event', (actor, event) => {
        if (event.type() !== Clutter.EventType.BUTTON_PRESS || event.get_button() !== Clutter.BUTTON_PRIMARY ||
            !preview.actor.visible)
            return Clutter.EVENT_PROPAGATE;
        const target = global.stage.get_event_actor(event);
        if (!preview.contains(target))
            return Clutter.EVENT_PROPAGATE;
        const file = preview.file;
        const app = preview.appAt(target);
        button.menu.close();
        if (app)
            launchWith(app, file);
        else
            openFile(file);
        return Clutter.EVENT_STOP;
    });
}

function addSection(section, title, entries, kind) {
    if (!entries.length)
        return;
    section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(title));
    entries.forEach(e => addFileItem(section, e, kind));
}

function rebuildMenu() {
    cancelHover();
    preview.hide();
    openWithMode = false;
    const s = files.section;
    s.removeAll();
    if (!data.dl.length && !data.shots.length && !data.recent.length)
        s.addMenuItem(new PopupMenu.PopupMenuItem('Nothing yet', { reactive: false }));
    addSection(s, 'Downloads', data.dl, 'download');
    addSection(s, 'Screenshots', data.shots, 'screenshot');
    addSection(s, 'Recently opened', data.recent, 'recent');
    footer.actor.show();
}

function showOpenWith(file) {
    // Swap the file list for the apps that can open this file.
    file.query_info_async('standard::content-type', 0, GLib.PRIORITY_DEFAULT, null, (f, res) => {
        let type = 'application/octet-stream';
        try {
            type = f.query_info_finish(res).get_content_type();
        } catch (e) {}
        if (!button)
            return;
        cancelHover();
        preview.hide();
        openWithMode = true;
        const s = files.section;
        s.removeAll();
        s.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(`Open ${shorten(file.get_basename())} with`));
        const { apps, def } = appsFor(type);
        for (const app of apps) {
            const name = app.get_display_name() + (def?.equal(app) ? '  (default)' : '');
            const item = new PopupMenu.PopupImageMenuItem(name, app.get_icon() ?? 'application-x-executable-symbolic');
            item.connect('activate', () => launchWith(app, file));
            s.addMenuItem(item);
        }
        if (!apps.length)
            s.addMenuItem(new PopupMenu.PopupMenuItem('No apps found', { reactive: false }));
        s.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const back = new PopupMenu.PopupImageMenuItem('Back', 'go-previous-symbolic');
        // Re-opening rebuilds the file list (open-state-changed).
        back.connect('activate', () => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            button?.menu.open();
            return GLib.SOURCE_REMOVE;
        }));
        s.addMenuItem(back);
        footer.actor.hide();
        button.menu.open();
    });
}

function buildFooter() {
    footer = new PopupMenu.PopupMenuSection();
    footer.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    footer.addAction('Open Downloads folder', () => openFile(watches[0].dir));
    footer.addAction('Settings', () => ExtensionUtils.openPrefs());
    button.menu.addMenuItem(footer);
}

/* ---------- lifecycle ---------- */

function enable(extSettings) {
    extDir = GLib.build_filenamev([Me.path, 'helpers']);
    settings = extSettings;
    cancellable = new Gio.Cancellable();
    data = { dl: [], shots: [], recent: [] };

    preview = new Preview(Me.path);
    tooltip = new Tooltip();
    button = new PanelMenu.Button(0.0, 'Recent Files', false);
    const box = new St.BoxLayout({ style: 'spacing: 6px;' });
    icon = new St.Icon({ style_class: 'system-status-icon' });
    label = new St.Label({ y_align: Clutter.ActorAlign.CENTER });
    box.add_child(icon);
    box.add_child(label);
    button.add_child(box);
    files = new ScrollableSection(button.menu);
    buildFooter();   // also keeps the menu non-empty, so open() works

    // Left click on a fresh item uses it directly; otherwise the menu opens.
    button.connect('event', (actor, event) => {
        if (event.type() === Clutter.EventType.BUTTON_PRESS &&
            event.get_button() === Clutter.BUTTON_PRIMARY && fresh) {
            useFresh();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    });
    button.menu.connect('open-state-changed', (m, open) => {
        if (open && !openWithMode) {
            rebuildMenu();   // instantly, from the last lists
            refresh().catch(logError);
        }
        if (!open) {
            cancelHover();
            tooltip?.hide();
            openWithMode = false;
            // Defer, so a click on the card (which closes the menu) still sees it.
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                if (!button?.menu.isOpen)
                    preview?.hide();
                return GLib.SOURCE_REMOVE;
            });
        }
    });

    if (fresh)
        showFresh(fresh, fresh.kind);
    else
        clearFresh();
    const downloads = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) ||
        GLib.build_filenamev([GLib.get_home_dir(), 'Downloads']);
    watch(Gio.File.new_for_path(downloads), 'download');
    const shots = screenshotsDir();
    if (shots)
        watch(Gio.File.new_for_path(shots), 'screenshot');
    try {
        xbelMonitor = Gio.File.new_for_path(RECENT_XBEL).monitor_file(Gio.FileMonitorFlags.NONE, null);
        xbelMonitor.connect('changed', () => {
            if (xbelId)
                GLib.source_remove(xbelId);
            xbelId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RESCAN_MS, () => {
                xbelId = 0;
                refresh().catch(logError);
                return GLib.SOURCE_REMOVE;
            });
        });
    } catch (e) {}
    expireId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, expireFresh);
    refresh().catch(logError);

    Main.wm.addKeybinding('recent-files-shortcut', settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
        Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => button.menu.toggle());

    // Left box, after the focused-app name.
    Main.panel.addToStatusArea('essentials-recent-files', button, Main.panel._leftBox.get_n_children(), 'left');
    hookPreviewClicks();
}

function disable() {
    cancellable.cancel();
    cancelHover();
    cancelDrag();
    tooltip?.destroy();
    preview?.destroy();
    Main.wm.removeKeybinding('recent-files-shortcut');
    for (const w of watches) {
        if (w.rescanId)
            GLib.source_remove(w.rescanId);
        w.monitor?.cancel();
    }
    watches = [];
    xbelMonitor?.cancel();
    for (const id of [xbelId, expireId]) {
        if (id)
            GLib.source_remove(id);
    }
    files?.destroy();
    button?.destroy();
    button = icon = label = settings = files = footer = tooltip = preview = xbelMonitor = cancellable = null;
    expireId = xbelId = 0;
    openWithMode = false;
}
