/*
 * Clipboard history, like Windows' Win+V.
 *  - Every text or image copied during this login session is kept (newest
 *    first, up to MAX_ITEMS). Images live in $XDG_RUNTIME_DIR, which is
 *    cleared at logout; nothing unpinned is written to disk.
 *  - Super+V or the top-bar icon opens the list. Choosing an item puts it
 *    back on the clipboard and (optionally) pastes it into the window you
 *    were in. Pinned text items are kept across restarts.
 *  - Copies flagged by password managers (x-kde-passwordManagerHint), or
 *    made while a password manager window is focused, are skipped. Pins are
 *    saved readable only by you (0600).
 */
const { GLib, Gio, St, Clutter, Meta, Shell, GdkPixbuf, Pango } = imports.gi;
const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const Me = imports.misc.extensionUtils.getCurrentExtension();
const { Tooltip } = Me.imports.features.tooltip;
const { ScrollableSection } = Me.imports.features.scrollMenu;

const MAX_ITEMS = 30;
const MAX_TEXT = 100000;
const THUMB_H = 64;
const CB = St.ClipboardType.CLIPBOARD;
const SECRET_APPS = /keepass|bitwarden|1password|enpass|lastpass|seahorse|protonpass|secrets/i;
const LABEL_CHARS = 300;   // what a menu row needs; full text stays in history
const PLAIN = /^(text\/plain|UTF8_STRING$|STRING$|TEXT$)/;
const PINS = GLib.build_filenamev([GLib.get_user_config_dir(), 'clipboard-history-pins.json']);

let button, settings, selectionId, pasteId, imgDir, list, footer;
let tooltip;            // hover labels for the pin/remove buttons
let started = false;   // history outlives disable(): GNOME disables extensions while the screen is locked
let history = [];   // [{kind: 'text', text} | {kind: 'image', path, hash, w, h}] + {time, pinned}

/* ---------- storage ---------- */

function savePins() {
    const texts = history.filter(e => e.pinned && e.kind === 'text').map(e => e.text);
    GLib.file_set_contents_full(PINS, JSON.stringify(texts), GLib.FileSetContentsFlags.CONSISTENT, 0o600);
}

function loadPins() {
    try {
        const [, bytes] = GLib.file_get_contents(PINS);
        return JSON.parse(new TextDecoder().decode(bytes))
            .map(text => ({ kind: 'text', text, time: 0, pinned: true }));
    } catch (e) {
        return [];
    }
}

function same(a, b) {
    return a.kind === b.kind && (a.kind === 'text' ? a.text === b.text : a.hash === b.hash);
}

function remember(entry) {
    const old = history.find(e => same(e, entry));
    entry.pinned = old?.pinned ?? false;
    history = [entry, ...history.filter(e => e !== old)];
    let unpinned = 0;
    history = history.filter(e => e.pinned || ++unpinned <= MAX_ITEMS || dropImage(e));
}

function dropImage(e) {
    // Used inside filter(): deletes the image file, returns false.
    if (e.kind === 'image' && !history.some(o => o !== e && o.path === e.path))
        GLib.unlink(e.path);
    return false;
}

/* ---------- watching the clipboard ---------- */

function onOwnerChanged(selection, type, source) {
    if (type !== Meta.SelectionType.SELECTION_CLIPBOARD || !source)
        return;
    const clip = St.Clipboard.get_default();
    const types = clip.get_mimetypes(CB);
    const app = global.display.focus_window?.get_wm_class() ?? '';
    if (types.includes('x-kde-passwordManagerHint') || SECRET_APPS.test(app))
        return;
    if (types.some(t => PLAIN.test(t))) {
        clip.get_text(CB, (c, text) => {
            if (text && text.trim())
                remember({ kind: 'text', text: text.slice(0, MAX_TEXT), lines: text.split('\n').length, time: now() });
        });
    } else if (types.includes('image/png')) {
        clip.get_content(CB, 'image/png', (c, bytes) => {
            if (bytes && bytes.get_size())
                rememberImage(bytes);
        });
    }
}

function rememberImage(bytes) {
    const hash = GLib.compute_checksum_for_bytes(GLib.ChecksumType.MD5, bytes);
    const path = GLib.build_filenamev([imgDir, `${hash}.png`]);
    if (!GLib.file_test(path, GLib.FileTest.EXISTS))
        GLib.file_set_contents(path, bytes.toArray());
    const [, w, h] = GdkPixbuf.Pixbuf.get_file_info(path);
    remember({ kind: 'image', path, hash, w, h, time: now() });
}

const now = () => GLib.get_real_time() / 1e6;

/* ---------- choosing an item ---------- */

function choose(entry) {
    const clip = St.Clipboard.get_default();
    if (entry.kind === 'text') {
        clip.set_text(CB, entry.text);
        clip.set_text(St.ClipboardType.PRIMARY, entry.text);
    } else {
        const [, bytes] = GLib.file_get_contents(entry.path);
        clip.set_content(CB, 'image/png', new GLib.Bytes(bytes));
    }
    if (settings.get_boolean('paste-on-select'))
        pasteSoon(entry.kind === 'text');
}

function pasteSoon(text) {
    // Once the menu has closed and focus is back on the window, press
    // Shift+Insert for text (pastes in terminals too) or Ctrl+V for images.
    if (pasteId)
        GLib.source_remove(pasteId);
    pasteId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
        pasteId = 0;
        const kb = Clutter.get_default_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        const keys = text ? [Clutter.KEY_Shift_L, Clutter.KEY_Insert] : [Clutter.KEY_Control_L, Clutter.KEY_v];
        const t = GLib.get_monotonic_time();
        keys.forEach(k => kb.notify_keyval(t, k, Clutter.KeyState.PRESSED));
        keys.reverse().forEach(k => kb.notify_keyval(t, k, Clutter.KeyState.RELEASED));
        return GLib.SOURCE_REMOVE;
    });
}

/* ---------- menu ---------- */

function ago(seconds) {
    if (seconds < 60)
        return 'now';
    if (seconds < 3600)
        return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400)
        return `${Math.floor(seconds / 3600)}h`;
    return `${Math.floor(seconds / 86400)}d`;
}

function rebuildLater() {
    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        if (button?.menu.isOpen)
            rebuildMenu();
        return GLib.SOURCE_REMOVE;
    });
}

function actionButton(iconName, tip, callback) {
    const b = new St.Button({
        child: new St.Icon({ icon_name: iconName, icon_size: 14 }),
        style_class: 'button',
        style: 'padding: 2px 5px; margin-left: 2px; min-height: 0; border-radius: 6px;',
        accessible_name: tip,
    });
    tooltip.attach(b, tip);
    b.connect('clicked', () => {
        callback();
        rebuildLater();   // keep the menu open with the updated list
    });
    return b;
}


function addEntry(menu, entry) {
    const item = new PopupMenu.PopupBaseMenuItem();
    if (entry.kind === 'text') {
        const lines = entry.lines ?? entry.text.split('\n').length;
        const label = new St.Label({
            text: entry.text.slice(0, LABEL_CHARS).replace(/\s+/g, ' ').trim(),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'max-width: 22em;',
        });
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        item.add_child(label);
        if (lines > 1)
            item.add_child(new St.Label({
                text: `${lines} lines`, y_align: Clutter.ActorAlign.CENTER,
                style: 'color: #999; font-size: 85%; padding-left: 8px;',
            }));
    } else {
        const scale = Math.min(THUMB_H / entry.h, 240 / entry.w, 1);
        item.add_child(new St.Widget({
            width: Math.round(entry.w * scale),
            height: Math.round(entry.h * scale),
            style: `background-image: url("${entry.path}"); background-size: contain;` +
                'background-repeat: no-repeat; border-radius: 4px;',
        }));
        item.add_child(new St.Label({
            text: `Image ${entry.w}×${entry.h}`,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'color: #bbb; padding-left: 10px;',
        }));
    }

    // Age, swapped for pin/delete buttons on hover (same cell, so no jumping).
    const when = new St.Label({
        text: entry.pinned ? '📌' : ago(now() - entry.time),
        x_align: Clutter.ActorAlign.END,
        y_align: Clutter.ActorAlign.CENTER,
        style: 'color: #999;',
    });
    const actions = new St.BoxLayout({ x_align: Clutter.ActorAlign.END, opacity: 0 });
    if (entry.kind === 'text') {
        actions.add_child(actionButton('view-pin-symbolic', entry.pinned ? 'Unpin' : 'Pin', () => {
            entry.pinned = !entry.pinned;
            savePins();
        }));
    }
    actions.add_child(actionButton('edit-delete-symbolic', 'Remove', () => {
        history = history.filter(e => e !== entry || dropImage(e));
        if (entry.pinned)
            savePins();
    }));
    const cell = new St.Widget({ layout_manager: new Clutter.BinLayout(), style: 'padding-left: 12px;' });
    cell.add_child(when);
    cell.add_child(actions);
    item.add_child(cell);
    const sync = () => {
        const on = item.hover || item.active;
        actions.opacity = on ? 255 : 0;
        when.opacity = on ? 0 : 255;
        for (const b of actions.get_children())
            b.reactive = on;
    };
    item.connect('notify::hover', sync);
    item.connect('notify::active', sync);
    sync();

    item.connect('activate', () => choose(entry));
    menu.addMenuItem(item);
}

function rebuildMenu() {
    // Rows go in the scrolling list; the footer (switch, clear) stays put.
    const s = list.section;
    s.removeAll();
    const pinned = history.filter(e => e.pinned);
    const recent = history.filter(e => !e.pinned);
    if (pinned.length) {
        s.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Pinned'));
        pinned.forEach(e => addEntry(s, e));
    }
    s.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Clipboard'));
    if (recent.length)
        recent.forEach(e => addEntry(s, e));
    else
        s.addMenuItem(new PopupMenu.PopupMenuItem('Copy something and it shows up here', { reactive: false }));
    footer.paste.setToggleState(settings.get_boolean('paste-on-select'));
    footer.clear.setSensitive(recent.length > 0);
}

function buildFooter(menu) {
    const section = new PopupMenu.PopupMenuSection();
    section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    const paste = new PopupMenu.PopupSwitchMenuItem('Paste after choosing', settings.get_boolean('paste-on-select'));
    paste.connect('toggled', (i, state) => settings.set_boolean('paste-on-select', state));
    section.addMenuItem(paste);
    const clear = new PopupMenu.PopupMenuItem('Clear history');
    clear.connect('activate', () => {
        history = history.filter(e => e.pinned || dropImage(e));
    });
    section.addMenuItem(clear);
    menu.addMenuItem(section);
    return { section, paste, clear };
}

/* ---------- lifecycle ---------- */


function enable(extSettings) {
    settings = extSettings;
    imgDir = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'clipboard-history']);
    if (!started) {
        // A shell restart forgets the session history, so start the image dir clean.
        started = true;
        GLib.mkdir_with_parents(imgDir, 0o700);
        const dir = Gio.File.new_for_path(imgDir);
        const en = dir.enumerate_children('standard::name', 0, null);
        let info;
        while ((info = en.next_file(null)))
            dir.get_child(info.get_name()).delete(null);
        history = loadPins();
    }

    button = new PanelMenu.Button(0.0, 'Clipboard History', false);
    button.add_child(new St.Icon({ icon_name: 'edit-paste-symbolic', style_class: 'system-status-icon' }));
    button.menu.connect('open-state-changed', (m, open) => {
        if (open)
            rebuildMenu();
        else
            tooltip?.hide();
    });
    tooltip = new Tooltip();
    list = new ScrollableSection(button.menu);
    footer = buildFooter(button.menu);   // also keeps the menu non-empty, so open() works
    rebuildMenu();
    Main.panel.addToStatusArea('clipboard-history', button);

    selectionId = global.display.get_selection().connect('owner-changed', onOwnerChanged);
    Main.wm.addKeybinding('clipboard-shortcut', settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
        Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP, () => {
            button.menu.toggle();
            if (button.menu.isOpen)   // keyboard-first: focus the first item
                button.menu.actor.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
        });
}

function disable() {
    Main.wm.removeKeybinding('clipboard-shortcut');
    global.display.get_selection().disconnect(selectionId);
    if (pasteId)
        GLib.source_remove(pasteId);
    tooltip.destroy();
    list.destroy();
    button.destroy();
    button = settings = tooltip = list = footer = null;
    selectionId = pasteId = 0;
}
