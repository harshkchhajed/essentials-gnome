/*
 * Quick-look card shown beside the Recent Files menu.
 *  - Images, PDFs, videos, Office docs: a 512 px thumbnail made by peek.js
 *    in a separate process (which also adds duration, pages, image size).
 *  - Archives: the top-level entries, also from peek.js.
 *  - Text/code/CSV/Markdown: the first lines, read asynchronously (<= 64 KB).
 *  - Anything else: a large type icon.
 * Under the content: name, details line (size · modified), a button for the
 * default app and icon buttons for up to two other apps. Clicks on the card
 * are routed by recentFiles.js (the open menu holds the pointer grab) using
 * appAt().
 *
 * Nothing here blocks the shell: file work is async and cancelled when the
 * file changes, and peek.js runs in its own process group so cancelling also
 * stops whatever it started (ffmpeg, LibreOffice...). The card always fits
 * in the monitor's work area.
 */
const { GLib, Gio, GdkPixbuf, St, Clutter, Cogl, Pango } = imports.gi;
const Main = imports.ui.main;

const CARD_W = 480;          // logical px
const MAX_IMG_H = 520;
const TEXT_BYTES = 65536;
const TEXT_LINES = 30;
const APPS_ON_CARD = 3;
const CHROME_H = 200;        // title + details + app buttons + padding, roughly
// Text-ish types that don't inherit from text/plain.
const TEXTY = /json|xml|yaml|toml|x-shellscript|javascript|x-python|csv|markdown|x-log|sql/;

function isText(type) {
    return Gio.content_type_is_a(type, 'text/plain') || TEXTY.test(type);
}

function details(info) {
    const size = GLib.format_size(info.get_size());
    const dt = GLib.DateTime.new_from_unix_local(info.get_attribute_uint64('time::modified'));
    return `${size} · ${dt.format('%b %-d, %H:%M')}`;
}

var appsFor = function (type) {
    // Default app first, then other recommended ones, then the rest.
    const def = Gio.AppInfo.get_default_for_type(type, false);
    const apps = def ? [def] : [];
    for (const app of [...Gio.AppInfo.get_recommended_for_type(type), ...Gio.AppInfo.get_all_for_type(type)]) {
        if (app.should_show() && !apps.some(a => a.equal(app)))
            apps.push(app);
    }
    return { apps, def };
};

var Preview = class {
    constructor(extDir) {
        this._peekHelper = GLib.build_filenamev([extDir, 'helpers', 'peek.js']);
        this._file = null;
        this._anchor = null;
        this._cancellable = null;
        this._scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;

        this.actor = new St.BoxLayout({
            vertical: true,
            reactive: true,
            visible: false,
            style: 'padding: 12px; spacing: 8px; border-radius: 12px;' +
                'background-color: rgba(36,36,36,0.97); border: 1px solid rgba(255,255,255,0.12);' +
                'box-shadow: 0 6px 24px rgba(0,0,0,0.5);',
        });
        this.actor.set_width(this._px(CARD_W));
        this._content = new St.Bin({ x_align: Clutter.ActorAlign.CENTER, clip_to_allocation: true });
        this._title = new St.Label({ style: 'font-weight: bold;' });
        this._title.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
        this._meta = new St.Label({ style: 'color: #999; font-size: 90%;' });
        this._apps = new St.BoxLayout({ style: 'spacing: 6px; padding-top: 2px;' });
        for (const a of [this._content, this._title, this._meta, this._apps])
            this.actor.add_child(a);

        Main.layoutManager.uiGroup.add_child(this.actor);
    }

    get file() {
        return this._file;
    }

    contains(actor) {
        return this.actor.contains(actor);
    }

    appAt(actor) {
        // The app of the card button under `actor`, or null for the rest of the card.
        for (let a = actor; a && a !== this.actor; a = a.get_parent()) {
            if (a._app)
                return a._app;
        }
        return null;
    }

    show(file, anchor) {
        // anchor: the menu row; the card goes beside its menu.
        this._cancel();
        this._file = file;
        this._anchor = anchor;
        const cancellable = this._cancellable = new Gio.Cancellable();
        file.query_info_async('standard::content-type,standard::icon,standard::size,time::modified',
            0, GLib.PRIORITY_DEFAULT, cancellable, (f, res) => {
                let info;
                try {
                    info = f.query_info_finish(res);
                } catch (e) {
                    if (!cancellable.is_cancelled())
                        this.hide();
                    return;
                }
                const type = info.get_content_type();
                this._title.text = file.get_basename();
                this._meta.text = details(info);
                this._setIcon(info.get_icon());   // placeholder until content loads
                this._fillApps(type);
                if (isText(type))
                    this._loadText(file, cancellable);
                else
                    this._loadPeek(file, cancellable);
                this.actor.show();
                Main.layoutManager.uiGroup.set_child_above_sibling(this.actor, null);
                this._place();
            });
    }

    hide() {
        this._cancel();
        this._file = null;
        this.actor.hide();
    }

    destroy() {
        this._cancel();
        this.actor.destroy();
    }

    _px(logical) {
        return Math.round(logical * this._scale);
    }

    _cancel() {
        this._cancellable?.cancel();
        this._cancellable = null;
    }

    _workArea() {
        const mon = Main.layoutManager.findIndexForActor(this._anchor);
        return Main.layoutManager.getWorkAreaForMonitor(mon >= 0 ? mon : Main.layoutManager.primaryIndex);
    }

    _maxContentH() {
        // Content gets what the work area leaves after the card's other parts.
        return Math.max(this._px(120), this._workArea().height - this._px(CHROME_H));
    }

    _place() {
        // Beside the menu, top aligned with the row, kept inside the work area.
        if (!this._anchor?.get_stage())
            return;
        const menuActor = this._anchor.get_parent();
        const [mx] = menuActor.get_transformed_position();
        const [mw] = menuActor.get_transformed_size();
        const [, ry] = this._anchor.get_transformed_position();
        const wa = this._workArea();
        const cardW = this._px(CARD_W);
        const [, natH] = this.actor.get_preferred_height(cardW);
        let x = mx + mw + 8;
        if (x + cardW > wa.x + wa.width)
            x = mx - cardW - 8;
        const y = Math.max(wa.y + 8, Math.min(ry - 12, wa.y + wa.height - natH - 8));
        this.actor.set_position(Math.round(x), Math.round(y));
    }

    _fillApps(type) {
        this._apps.destroy_all_children();
        const { apps } = appsFor(type);
        apps.slice(0, APPS_ON_CARD).forEach((app, i) => {
            const box = new St.BoxLayout({ style: 'spacing: 6px;' });
            box.add_child(new St.Icon({
                gicon: app.get_icon() ?? Gio.ThemedIcon.new('application-x-executable-symbolic'),
                icon_size: 16,
            }));
            if (i === 0) {   // the default app gets a name; others are recognisable icons
                const name = new St.Label({
                    text: `Open in ${app.get_display_name()}`,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                box.add_child(name);
            }
            const btn = new St.Button({
                child: box,
                style: 'padding: 5px 10px; border-radius: 8px; font-size: 90%;' +
                    `background-color: rgba(255,255,255,${i === 0 ? 0.16 : 0.08});`,
            });
            btn._app = app;
            this._apps.add_child(btn);
        });
        this._apps.visible = apps.length > 0;
    }

    _setIcon(gicon) {
        this._content.child = new St.Icon({ gicon, icon_size: 128, style: 'padding: 24px;' });
    }

    _loadPeek(file, cancellable) {
        // setsid gives peek.js its own process group (setsid execs in place,
        // so the pid is the group id); cancelling kills the whole group.
        let proc;
        try {
            proc = Gio.Subprocess.new(['setsid', 'gjs', this._peekHelper, file.get_uri()],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            return;
        }
        cancellable.connect(() => {
            const pid = proc.get_identifier();
            if (pid) {
                try {
                    Gio.Subprocess.new(['kill', '-KILL', '--', `-${pid}`], Gio.SubprocessFlags.STDERR_SILENCE);
                } catch (e) {
                    proc.force_exit();
                }
            }
        });
        proc.communicate_utf8_async(null, cancellable, (p, res) => {
            let peek;
            try {
                peek = JSON.parse(p.communicate_utf8_finish(res)[1]);
            } catch (e) {
                return;   // cancelled or no output
            }
            if (cancellable.is_cancelled())
                return;
            if (peek.info.length)
                this._meta.text += ` · ${peek.info.join(' · ')}`;
            if (peek.thumb)
                this._loadImage(peek.thumb, cancellable);
            else if (peek.list.length)
                this._showText(peek.list.join('\n') + (peek.more ? '\n…' : ''), '');
            this._place();
        });
    }

    _loadImage(path, cancellable) {
        // Decode off the main thread into an St.ImageContent (CSS background
        // images would stay in the shell's texture cache for the session).
        const file = Gio.File.new_for_path(path);
        file.read_async(GLib.PRIORITY_DEFAULT, cancellable, (f, res) => {
            let stream;
            try {
                stream = f.read_finish(res);
            } catch (e) {
                return;
            }
            const maxW = this._px(CARD_W - 24);
            const maxH = Math.min(this._px(MAX_IMG_H), this._maxContentH());
            GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(stream, maxW, maxH, true, cancellable, (s, r) => {
                let pb;
                try {
                    pb = GdkPixbuf.Pixbuf.new_from_stream_finish(r);
                } catch (e) {
                    return;
                } finally {
                    stream.close_async(GLib.PRIORITY_DEFAULT, null, null);
                }
                if (cancellable.is_cancelled())
                    return;
                const content = St.ImageContent.new_with_preferred_size(pb.width, pb.height);
                content.set_data(pb.get_pixels(),
                    pb.has_alpha ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
                    pb.width, pb.height, pb.rowstride);
                this._content.child = new St.Widget({
                    width: pb.width, height: pb.height, content,
                    style: 'border-radius: 6px;',
                });
                this._place();
            });
        });
    }

    _showText(text, extraStyle) {
        const label = new St.Label({
            text,
            style: 'font-size: 85%; padding: 8px;' +
                `background-color: rgba(0,0,0,0.35); border-radius: 6px; ${extraStyle}`,
            x_expand: true,
            clip_to_allocation: true,
        });
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        const w = this._px(CARD_W - 24);
        label.set_width(w);
        const [, natH] = label.get_preferred_height(w);
        label.set_height(Math.min(natH, this._maxContentH()));   // long text is clipped, buttons stay visible
        this._content.child = label;
    }

    _loadText(file, cancellable) {
        file.read_async(GLib.PRIORITY_DEFAULT, cancellable, (f, res) => {
            let stream;
            try {
                stream = f.read_finish(res);
            } catch (e) {
                return;
            }
            stream.read_bytes_async(TEXT_BYTES, GLib.PRIORITY_DEFAULT, cancellable, (s, r) => {
                let bytes;
                try {
                    bytes = s.read_bytes_finish(r);
                } catch (e) {
                    return;
                } finally {
                    s.close_async(GLib.PRIORITY_DEFAULT, null, null);
                }
                if (cancellable.is_cancelled())
                    return;
                const lines = new TextDecoder('utf-8', { fatal: false })
                    .decode(bytes.toArray()).split('\n');
                let text = lines.slice(0, TEXT_LINES).map(l => l.replace(/\t/g, '    ')).join('\n');
                if (lines.length > TEXT_LINES)
                    text += '\n…';
                this._showText(text, 'font-family: monospace;');
                this._place();
            });
        });
    }
};
