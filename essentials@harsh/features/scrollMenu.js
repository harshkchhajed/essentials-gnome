/*
 * A menu section that scrolls. GNOME 42 top-level popup menus can't scroll,
 * so long lists (and 2x text scaling) push rows off the screen. The section
 * is added as a normal menu item (so activating a row still closes the
 * menu), then its actor is moved into a ScrollView capped to most of the
 * monitor's work area. Keyboard focus scrolls the focused row into view.
 */
const { St } = imports.gi;
const Main = imports.ui.main;
const PopupMenu = imports.ui.popupMenu;
const Util = imports.misc.util;

const MAX_SHARE = 0.7;   // of the work area height

var ScrollableSection = class {
    constructor(menu) {
        this._menu = menu;
        this.section = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(this.section);
        this.scroll = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            style_class: 'vfade',
        });
        const box = menu.box;
        const index = box.get_children().indexOf(this.section.actor);
        box.remove_child(this.section.actor);
        this.scroll.add_actor(this.section.actor);
        box.insert_child_at_index(this.scroll, index);

        this._openId = menu.connect('open-state-changed', (m, open) => this._onOpen(open));
        this._focusId = 0;
    }

    _onOpen(open) {
        if (this._focusId) {
            global.stage.disconnect(this._focusId);
            this._focusId = 0;
        }
        if (!open)
            return;
        const mon = Main.layoutManager.findIndexForActor(this._menu.sourceActor);
        const wa = Main.layoutManager.getWorkAreaForMonitor(mon >= 0 ? mon : Main.layoutManager.primaryIndex);
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this.scroll.style = `max-height: ${Math.round(wa.height * MAX_SHARE / scale)}px;`;
        this._focusId = global.stage.connect('notify::key-focus', () => {
            const focus = global.stage.key_focus;
            if (focus && this.section.actor.contains(focus))
                Util.ensureActorVisibleInScrollView(this.scroll, focus);
        });
    }

    destroy() {
        this._onOpen(false);
        this._menu.disconnect(this._openId);
        this.section.destroy();
        this.scroll.destroy();
    }
};
