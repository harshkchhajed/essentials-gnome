/*
 * Small hover label for icon buttons inside menus (GNOME Shell has no
 * built-in tooltips). One Tooltip per feature; attach() it to each button.
 */
const { GLib, St } = imports.gi;
const Main = imports.ui.main;

const DELAY_MS = 350;

var Tooltip = class {
    constructor() {
        this._timeoutId = 0;
        this._label = new St.Label({
            visible: false,
            style: 'background-color: rgba(20,20,20,0.95); color: #eee; padding: 4px 8px;' +
                'border-radius: 6px; font-size: 85%; border: 1px solid rgba(255,255,255,0.12);',
        });
        Main.layoutManager.uiGroup.add_child(this._label);
    }

    attach(button, text) {
        button.track_hover = true;
        button.connect('notify::hover', () => (button.hover ? this._showSoon(button, text) : this.hide()));
        button.connect('clicked', () => this.hide());
        button.connect('destroy', () => this.hide());
    }

    hide() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        this._label?.hide();
    }

    destroy() {
        this.hide();
        this._label.destroy();
        this._label = null;
    }

    _showSoon(actor, text) {
        this.hide();
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DELAY_MS, () => {
            this._timeoutId = 0;
            if (actor.hover && actor.get_stage())
                this._place(actor, text);
            return GLib.SOURCE_REMOVE;
        });
    }

    _place(actor, text) {
        // Centred under the button; above it when there's no room below.
        const label = this._label;
        label.text = text;
        label.show();
        Main.layoutManager.uiGroup.set_child_above_sibling(label, null);
        const [x, y] = actor.get_transformed_position();
        const [w, h] = actor.get_transformed_size();
        const [, tw] = label.get_preferred_width(-1);
        const [, th] = label.get_preferred_height(-1);
        const mon = Main.layoutManager.findMonitorForActor(actor) ?? Main.layoutManager.primaryMonitor;
        const tx = Math.max(mon.x + 4, Math.min(x + w / 2 - tw / 2, mon.x + mon.width - tw - 4));
        const ty = y + h + 6 + th > mon.y + mon.height ? y - th - 6 : y + h + 6;
        label.set_position(Math.round(tx), Math.round(ty));
    }
};
