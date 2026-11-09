// Drags one file into any app (browser upload, chat, Files).
//
// GNOME Shell menus can't drag into other windows, so when a Recent Files
// row is dragged the extension closes the menu (which frees the pointer) and
// starts this helper with --continue: it takes over the drag that is still in
// progress, so letting go over an app drops the file there.
// If the mouse button was already released by the time it starts, or the
// drag is cancelled, it shows a small tile under the pointer instead, which
// can be dragged normally (Esc / × / 60 s close it). The extension positions
// the window (GTK4 can't position itself on X11).
// Usage: gjs drag-file.js [--continue] <file-uri>
imports.gi.versions.Gtk = '4.0';
const { Gtk, Gdk, GLib, Gio } = imports.gi;

GLib.set_prgname('recent-files-drag');   // WM_CLASS the extension looks for
Gtk.init();

const continuing = ARGV[0] === '--continue';
const uri = ARGV[continuing ? 1 : 0];
const file = Gio.File.new_for_uri(uri);
const info = file.query_info('standard::icon,standard::display-name', 0, null);
const bytes = s => new GLib.Bytes(new TextEncoder().encode(s));
const loop = new GLib.MainLoop(null, false);

function content() {
    // The same file in the three forms apps look for.
    return Gdk.ContentProvider.new_union([
        Gdk.ContentProvider.new_for_bytes('text/uri-list', bytes(`${uri}\r\n`)),
        Gdk.ContentProvider.new_for_bytes('x-special/gnome-copied-files', bytes(`copy\n${uri}`)),
        Gdk.ContentProvider.new_for_bytes('text/plain;charset=utf-8', bytes(file.get_path())),
    ]);
}

function iconPaintable() {
    return Gtk.IconTheme.get_for_display(Gdk.Display.get_default())
        .lookup_by_gicon(info.get_icon(), 48, 1, Gtk.TextDirection.NONE, 0);
}

/* ---------- the tile (fallback, and the drag's source window) ---------- */

const win = new Gtk.Window({ decorated: false, resizable: false, title: 'Drag file' });
const box = new Gtk.Box({
    orientation: Gtk.Orientation.HORIZONTAL, spacing: 10,
    margin_top: 10, margin_bottom: 10, margin_start: 12, margin_end: 8,
});
const icon = new Gtk.Image({ gicon: info.get_icon(), pixel_size: 48 });
const text = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER });
const name = new Gtk.Label({ label: info.get_display_name(), xalign: 0, max_width_chars: 28, ellipsize: 2 });
name.add_css_class('heading');
const hint = new Gtk.Label({ label: 'Drag into any app · Esc to close', xalign: 0 });
hint.add_css_class('dim-label');
text.append(name);
text.append(hint);
const close = Gtk.Button.new_from_icon_name('window-close-symbolic');
close.add_css_class('flat');
close.valign = Gtk.Align.START;
close.connect('clicked', () => loop.quit());
box.append(icon);
box.append(text);
box.append(close);
win.set_child(box);

const source = new Gtk.DragSource({ actions: Gdk.DragAction.COPY });
source.connect('prepare', () => content());
source.connect('drag-begin', () => source.set_icon(iconPaintable(), 24, 24));
source.connect('drag-end', (src, d) => {
    if (d.get_selected_action() !== 0)   // quit only when something accepted the drop
        loop.quit();
});
box.add_controller(source);

const keys = new Gtk.EventControllerKey();
keys.connect('key-pressed', (c, keyval) => {
    if (keyval === Gdk.KEY_Escape)
        loop.quit();
    return false;
});
win.add_controller(keys);
win.connect('close-request', () => {
    loop.quit();
    return false;
});

/* ---------- continuing a drag that started in the menu ---------- */

function continueDrag() {
    const surface = win.get_native().get_surface();
    const pointer = Gdk.Display.get_default().get_default_seat().get_pointer();
    const [, , , mask] = surface.get_device_position(pointer);
    if (!(mask & Gdk.ModifierType.BUTTON1_MASK))
        return false;   // already let go: just show the tile
    const drag = Gdk.Drag.begin(surface, pointer, content(), Gdk.DragAction.COPY, 0, 0);
    if (!drag)
        return false;
    Gtk.DragIcon.get_for_drag(drag).set_child(new Gtk.Image({ paintable: iconPaintable(), pixel_size: 48 }));
    win.set_opacity(0);   // the window only hosts the drag; it reappears if cancelled
    drag.connect('dnd-finished', () => loop.quit());
    drag.connect('cancel', () => win.set_opacity(1));
    return true;
}

if (continuing) {
    win.set_opacity(0);   // invisible until we know whether the tile is needed
    win.connect('map', () => {
        // Let the extension move the window under the pointer first.
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
            if (!continueDrag())
                win.set_opacity(1);
            return GLib.SOURCE_REMOVE;
        });
    });
}

GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => loop.quit());
win.present();
loop.run();
