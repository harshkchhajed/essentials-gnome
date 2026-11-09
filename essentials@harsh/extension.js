/*
 * Essentials: one extension, several independent features. Each feature
 * lives in features/<name>.js with enable(settings) / disable(), and is
 * switched on or off live from Settings (feature-* keys). A feature that
 * fails to start is reported and skipped; the others keep working.
 *
 *   power          top-bar watts + details panel, battery lines and charge
 *                  limit in GNOME's battery menu
 *   recentFiles    downloads / screenshots / recent files menu, quick look
 *   clipboard      Super+V clipboard history
 *   displayLayout  saved monitor layouts, External Only / Join
 */
const Main = imports.ui.main;
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const FEATURES = [
    { key: 'feature-power', module: 'power', name: 'Power monitor' },
    { key: 'feature-recent-files', module: 'recentFiles', name: 'Recent files' },
    { key: 'feature-clipboard', module: 'clipboard', name: 'Clipboard history' },
    { key: 'feature-display-layout', module: 'displayLayout', name: 'Display layout' },
];

let settings, changedIds = [];
const running = new Set();

function start(f) {
    try {
        Me.imports.features[f.module].enable(settings);
        running.add(f);
    } catch (e) {
        logError(e, `essentials: ${f.module}`);
        stop(f, true);   // undo whatever it managed to set up
        Main.notify('Essentials', `${f.name} couldn't start: ${e.message}`);
    }
}

function stop(f, force = false) {
    if (!running.has(f) && !force)
        return;
    running.delete(f);
    try {
        Me.imports.features[f.module].disable();
    } catch (e) {
        if (!force)
            logError(e, `essentials: ${f.module}`);
    }
}

function sync() {
    for (const f of FEATURES) {
        const want = settings.get_boolean(f.key);
        if (want && !running.has(f))
            start(f);
        else if (!want && running.has(f))
            stop(f);
    }
}

function init() {}

function enable() {
    settings = ExtensionUtils.getSettings();
    changedIds = FEATURES.map(f => settings.connect(`changed::${f.key}`, sync));
    sync();
}

function disable() {
    changedIds.forEach(id => settings.disconnect(id));
    changedIds = [];
    [...FEATURES].reverse().forEach(f => stop(f));
    settings = null;
}
