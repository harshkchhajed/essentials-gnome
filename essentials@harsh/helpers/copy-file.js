// Puts a file on the clipboard the way file managers do, so pasting works in
// Files (x-special/gnome-copied-files), browsers/chat apps (text/uri-list)
// and text fields (plain path). Stays alive while it owns the clipboard and
// exits as soon as something else is copied.
// Usage: gjs copy-file.js <file-uri>
imports.gi.versions.Gtk = '4.0';
const { Gtk, Gdk, GLib, Gio } = imports.gi;

const uri = ARGV[0];
const path = Gio.File.new_for_uri(uri).get_path();
const bytes = s => new GLib.Bytes(new TextEncoder().encode(s));

Gtk.init();
const clipboard = Gdk.Display.get_default().get_clipboard();
clipboard.set_content(Gdk.ContentProvider.new_union([
    Gdk.ContentProvider.new_for_bytes('x-special/gnome-copied-files', bytes(`copy\n${uri}`)),
    Gdk.ContentProvider.new_for_bytes('text/uri-list', bytes(`${uri}\r\n`)),
    Gdk.ContentProvider.new_for_bytes('text/plain;charset=utf-8', bytes(path)),
]));

const loop = new GLib.MainLoop(null, false);
clipboard.connect('changed', () => {
    if (!clipboard.is_local())
        loop.quit();
});
// Give up ownership after an hour so it never lingers forever.
GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3600, () => loop.quit());
loop.run();
