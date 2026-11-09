// Settings window: Extensions app → Essentials → Settings, or the "Settings"
// row in the Recent Files menu. Page 1 switches features on/off; the other
// pages hold each feature's options (greyed out while the feature is off).
const { Adw, Gio, Gtk } = imports.gi;
const ExtensionUtils = imports.misc.extensionUtils;

function init() {}

function row(title, subtitle, widget) {
    const r = new Adw.ActionRow({ title, subtitle: subtitle ?? '' });
    widget.valign = Gtk.Align.CENTER;
    r.add_suffix(widget);
    r.activatable_widget = widget;
    return r;
}

function switchRow(settings, key, title, subtitle) {
    const sw = new Gtk.Switch();
    settings.bind(key, sw, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row(title, subtitle, sw);
}

function spinRow(settings, key, title, subtitle, min, max, step) {
    const spin = Gtk.SpinButton.new_with_range(min, max, step);
    settings.bind(key, spin, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row(title, subtitle, spin);
}

function delayRow(settings) {
    // Stored in ms, shown in seconds.
    const spin = Gtk.SpinButton.new_with_range(0, 10, 0.5);
    spin.digits = 1;
    spin.value = settings.get_int('preview-delay') / 1000;
    spin.connect('value-changed', () => settings.set_int('preview-delay', Math.round(spin.value * 1000)));
    return row('Hover delay (seconds)',
        'How long to hover a row before the preview appears. 0 turns hover off (Space still works).', spin);
}

function shortcutRow(settings, key, title) {
    const label = new Gtk.Label({ label: settings.get_strv(key).join(', ') || 'None' });
    label.add_css_class('dim-label');
    return row(title, null, label);
}

function group(page, settings, title, featureKey) {
    const g = new Adw.PreferencesGroup({ title });
    if (featureKey)   // options only matter while the feature is on
        settings.bind(featureKey, g, 'sensitive', Gio.SettingsBindFlags.GET);
    page.add(g);
    return g;
}

function fillPreferencesWindow(window) {
    const settings = ExtensionUtils.getSettings();

    const features = new Adw.PreferencesPage({ title: 'Features', icon_name: 'view-grid-symbolic' });
    const f = group(features, settings, 'Turn features on or off');
    f.add(switchRow(settings, 'feature-power', 'Power monitor',
        'Watts, temperatures and network in the top bar; battery health and charge limit in the battery menu'));
    f.add(switchRow(settings, 'feature-recent-files', 'Recent files',
        'Latest downloads, screenshots and recently opened files, with quick look (Super+R)'));
    f.add(switchRow(settings, 'feature-clipboard', 'Clipboard history',
        'Everything copied this session, with pins (Super+V)'));
    f.add(switchRow(settings, 'feature-display-layout', 'Display layout',
        'Remember monitor arrangements; External Only and Join in the system menu'));
    window.add(features);

    const recent = new Adw.PreferencesPage({ title: 'Recent Files', icon_name: 'document-open-recent-symbolic' });
    const look = group(recent, settings, 'Quick look', 'feature-recent-files');
    look.add(delayRow(settings));
    const menu = group(recent, settings, 'Menu', 'feature-recent-files');
    menu.add(shortcutRow(settings, 'recent-files-shortcut', 'Shortcut'));
    menu.add(spinRow(settings, 'list-length', 'Files per section', 'Downloads and recently opened files', 3, 20, 1));
    menu.add(switchRow(settings, 'show-screenshots', 'Show Screenshots'));
    menu.add(switchRow(settings, 'show-recent', 'Show Recently opened'));
    const bar = group(recent, settings, 'Top bar', 'feature-recent-files');
    bar.add(spinRow(settings, 'fresh-minutes', 'Keep new files in the top bar (minutes)',
        'A new download or screenshot is shown for this long', 1, 120, 1));
    window.add(recent);

    const clip = new Adw.PreferencesPage({ title: 'Clipboard', icon_name: 'edit-paste-symbolic' });
    const c = group(clip, settings, 'Clipboard history', 'feature-clipboard');
    c.add(shortcutRow(settings, 'clipboard-shortcut', 'Shortcut'));
    c.add(switchRow(settings, 'paste-on-select', 'Paste after choosing',
        'Choosing an item also pastes it into the window you were in'));
    window.add(clip);

    window.default_width = 760;
    window.default_height = 900;
}
