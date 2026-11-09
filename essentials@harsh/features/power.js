/*
 * Power monitor.
 *  - Top bar: battery charge/discharge watts, CPU package watts, GPU watts,
 *    network speeds.
 *  - Click: details panel (temperatures, fans, top CPU/GPU apps, memory,
 *    network, CPU power limit); it closes when the pointer leaves it.
 *  - GNOME's own battery submenu gets battery state, health, cycles and a
 *    "Limit charge to 80%" switch (Lenovo Conservation Mode).
 *
 * Nothing slow runs on the shell's main thread: battery and hwmon files are
 * read with load_contents_async (a battery read can take ~70 ms in ACPI,
 * an NVMe temperature ~10 ms), and nvidia-smi runs as a subprocess with a
 * timeout and at most one run in flight.
 */
const { GLib, Gio, St, Clutter, Pango } = imports.gi;
const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;

const BAT_UEVENT = '/sys/class/power_supply/BAT0/uevent';
const ADAPTER = '/sys/class/power_supply/ADP0/online';
const RAPL = '/sys/class/powercap/intel-rapl:0/';
const GPU_PM = '/sys/bus/pci/devices/0000:01:00.0/power/runtime_status';
const CONSERVATION = '/sys/bus/platform/drivers/ideapad_acpi/VPC2004:00/conservation_mode';
const TOP_N = 5;
const SMI_TIMEOUT_S = 5;
// For these, show the script being run instead of the interpreter.
const INTERPRETERS = /^(python[0-9.]*|node|java|bash|sh|ruby|perl|ros2)$/;

let button, bar, timer, detailTimer, closeTimer;   // bar: {bat, cpu, gpu, net, down, up}
let batt = null;      // battery lines + charge-limit switch in GNOME's battery submenu
let generation = 0;   // bumped on disable(); async results from older runs are dropped
let battery = null;   // parsed BAT0/uevent
let lastEnergy = null, lastTime = 0, cpuW = null;
let gpu = null;       // {watts, temp, util, mem, asleep} or null when unknown
let gpuApps = [];     // [[name, %], ...]
let smiBusy = {};     // one nvidia-smi run per kind at a time
let hasSmi = false;
let lastProc = null, lastTotal = 0;
let nameCache = new Map();
let rows = {};
let hwmon = null;     // [{path, kind, label}] found once per enable
let lastNet = null;   // {ifc, rx, tx, time}
let net = null;       // {ifc, down, up} in bytes/s
// When the top bar is short of room, this widget gives way (network speeds
// first, then the GPU reading) so GNOME never has to shorten other
// indicators, above all the battery percentage, to "…".
let squeeze = 0, fitId = 0, rightBoxId = 0, batteryLabel = null;

/* ---------- reading ---------- */

function readSys(path) {
    // Only for files that answer instantly (procfs, RAPL, net counters).
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? new TextDecoder().decode(bytes).trim() : '';
    } catch (e) {
        return '';
    }
}

function readAsync(path) {
    // Runs in a GIO worker thread, so slow sysfs reads don't stall the shell.
    return new Promise(resolve => {
        Gio.File.new_for_path(path).load_contents_async(null, (f, res) => {
            try {
                resolve(new TextDecoder().decode(f.load_contents_finish(res)[1]).trim());
            } catch (e) {
                resolve('');
            }
        });
    });
}

function live(gen) {
    return gen === generation && button !== null;
}

function run(kind, argv, callback) {
    // nvidia-smi can hang (GPU falling off the bus, driver reload): skip while
    // a run is in flight and kill runs that take too long.
    if (smiBusy[kind])
        return;
    const gen = generation;
    let proc;
    try {
        proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
    } catch (e) {
        return;
    }
    smiBusy[kind] = true;
    const killId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, SMI_TIMEOUT_S, () => {
        proc.force_exit();
        return GLib.SOURCE_REMOVE;
    });
    proc.communicate_utf8_async(null, null, (p, res) => {
        GLib.source_remove(killId);
        smiBusy[kind] = false;
        let out = '';
        try {
            out = p.communicate_utf8_finish(res)[1] ?? '';
        } catch (e) {}
        if (live(gen))
            callback(p.get_successful() ? out : '');
    });
}

/* ---------- top-bar values ---------- */

function gpuAsleep() {
    return readSys(GPU_PM) === 'suspended';
}

function updateGpu() {
    if (!hasSmi) {
        gpu = null;
        return;
    }
    // Don't wake a sleeping dGPU just to ask about it.
    if (gpuAsleep()) {
        gpu = { watts: 0, temp: null, util: 0, mem: 0, asleep: true };
        return;
    }
    run('gpu', ['nvidia-smi',
        '--query-gpu=power.draw.instant,temperature.gpu,utilization.gpu,memory.used',
        '--format=csv,noheader,nounits'], out => {
        const f = out.split(',').map(s => parseFloat(s));
        gpu = f.length === 4 && !isNaN(f[0])
            ? { watts: Math.round(f[0]), temp: f[1], util: f[2], mem: f[3], asleep: false }
            : null;
    });
}

function updateCpu() {
    const e = parseInt(readSys(RAPL + 'energy_uj'));
    const t = GLib.get_monotonic_time();
    if (isNaN(e)) {
        cpuW = null;
        return;
    }
    if (lastEnergy !== null && e >= lastEnergy)
        cpuW = Math.round((e - lastEnergy) / (t - lastTime));
    lastEnergy = e;
    lastTime = t;
}

async function updateBatteryData() {
    // One async read of uevent gives every battery value at once.
    const gen = generation;
    const text = await readAsync(BAT_UEVENT);
    if (!live(gen) || !text)
        return;
    const v = {};
    for (const line of text.split('\n')) {
        const [k, val] = line.split('=');
        v[k.replace('POWER_SUPPLY_', '')] = val;
    }
    const num = k => parseInt(v[k]);
    battery = {
        status: v.STATUS,
        capacity: num('CAPACITY'),
        now: num('ENERGY_NOW'),
        full: num('ENERGY_FULL'),
        design: num('ENERGY_FULL_DESIGN'),
        power: num('POWER_NOW') || 0,
        cycles: num('CYCLE_COUNT'),
    };
    bar.bat.text = batteryText();
    if (batt?.sub.isOpen)
        showBattery();
}

function batteryText() {
    const w = Math.round(battery.power / 1e6);
    if (battery.status === 'Charging')
        return `⚡+${w}W`;
    if (battery.status === 'Discharging')
        return `🔋−${w}W`;
    return '🔌';   // plugged in, battery neither charging nor discharging
}

function update() {
    updateCpu();
    updateGpu();
    updateNet();
    updateBatteryData();
    // Only show what is active: GPU disappears while it sleeps (or without
    // nvidia-smi), network while offline. Details live in the panel.
    bar.cpu.text = `CPU ${cpuW ?? '?'}W`;
    bar.gpu.text = `GPU ${gpu?.watts ?? '?'}W`;
    bar.gpu.visible = hasSmi && !gpu?.asleep && squeeze < 2;
    bar.net.visible = net !== null && squeeze < 1;
    if (net) {
        const dim = t => `<span foreground="#aaaaaa">${t}</span>`;
        bar.down.clutter_text.set_markup(`${dim('↓')}${fmtShort(net.down)}`);
        bar.up.clutter_text.set_markup(`${dim('↑')}${fmtShort(net.up)}`);
    }
    return GLib.SOURCE_CONTINUE;
}

/* ---------- fitting in the top bar ---------- */

function sideRoom() {
    // Width the panel gives each side box (panel.js vfunc_allocate).
    const panelW = Main.panel.width;
    const [, centerW] = Main.panel._centerBox.get_preferred_width(-1);
    return (panelW - centerW) / 2;
}

function fit() {
    // Hide parts of this widget while the right box would overflow; bring
    // them back once there is clearly room again (hysteresis avoids flicker).
    fitId = 0;
    if (!bar)
        return GLib.SOURCE_REMOVE;
    const room = sideRoom();
    const [, need] = Main.panel._rightBox.get_preferred_width(-1);
    if (need > room && squeeze < 2) {
        squeeze++;
        update();
        scheduleFit();   // check again after this step
    } else if (squeeze > 0) {
        // What the next part to come back would add.
        const part = squeeze === 2 ? bar.gpu : bar.net;
        part.show();
        const [, extra] = part.get_preferred_width(-1);
        part.hide();
        if (need + extra + 40 < room) {
            squeeze--;
            update();
        }
    }
    return GLib.SOURCE_REMOVE;
}

function scheduleFit() {
    if (!fitId)
        fitId = GLib.idle_add(GLib.PRIORITY_LOW, fit);
}

function protectBatteryLabel() {
    // GNOME's own battery percentage must never turn into "…".
    batteryLabel = Main.panel.statusArea.aggregateMenu?._power?._percentageLabel ?? null;
    if (batteryLabel)
        batteryLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
}

/* ---------- details panel ---------- */

function findHwmon() {
    // Which hwmon files to read; names and labels are cheap, values are not.
    const out = [];
    for (let i = 0; i < 16; i++) {
        const h = `/sys/class/hwmon/hwmon${i}/`;
        const name = readSys(h + 'name');
        if (name === 'coretemp') {
            for (let j = 1; j < 80; j++) {
                if (GLib.file_test(`${h}temp${j}_input`, GLib.FileTest.EXISTS)) {
                    const pkg = readSys(`${h}temp${j}_label`).startsWith('Package');
                    out.push({ path: `${h}temp${j}_input`, kind: pkg ? 'cpuPkg' : 'core' });
                }
            }
        } else if (name === 'nvme') {
            out.push({ path: h + 'temp1_input', kind: 'nvme' });
        } else if (name.startsWith('iwlwifi')) {
            out.push({ path: h + 'temp1_input', kind: 'wifi' });
        }
    }
    return out;
}

async function hwmonTemps() {
    // {cpuPkg, cpuMax, nvme: [..], wifi}
    hwmon ??= findHwmon();
    const values = await Promise.all(hwmon.map(h => readAsync(h.path)));
    const out = { cpuPkg: null, cpuMax: null, nvme: [], wifi: null };
    hwmon.forEach((h, i) => {
        const v = parseInt(values[i]) / 1000;
        if (isNaN(v))
            return;
        if (h.kind === 'core')
            out.cpuMax = Math.max(out.cpuMax ?? 0, v);
        else if (h.kind === 'nvme')
            out.nvme.push(v);
        else
            out[h.kind] = v;
    });
    return out;
}

function procName(pid) {
    if (nameCache.has(pid))
        return nameCache.get(pid);
    const args = readSys(`/proc/${pid}/cmdline`).split('\0').filter(a => a);
    let name = readSys(`/proc/${pid}/comm`);
    if (args.length) {
        const exe = GLib.path_get_basename(args[0]);
        if (INTERPRETERS.test(exe)) {
            const script = args.slice(1).find(a => !a.startsWith('-'));
            if (script)
                name = GLib.path_get_basename(script);
        }
    }
    nameCache.set(pid, name);
    return name;
}

function topCpu() {
    // Per-app CPU since the last call, grouped by name, top-style: 100% = one
    // full core. Reading /proc is fast (~7 ms for ~600 processes) and only
    // happens while the panel is open.
    const fields = readSys('/proc/stat').split('\n')[0].split(/\s+/).slice(1, 9);
    const total = fields.reduce((a, b) => a + parseInt(b), 0);
    const now = new Map();
    let dir;
    try {
        dir = Gio.File.new_for_path('/proc').enumerate_children('standard::name', 0, null);
    } catch (e) {
        return [];
    }
    let info;
    while ((info = dir.next_file(null))) {
        const pid = info.get_name();
        if (!/^\d+$/.test(pid))
            continue;
        const stat = readSys(`/proc/${pid}/stat`);
        const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        const ticks = parseInt(rest[11]) + parseInt(rest[12]);   // utime + stime
        if (!isNaN(ticks))
            now.set(pid, ticks);
    }
    dir.close(null);

    const result = [];
    if (lastProc && total > lastTotal) {
        const byName = new Map();
        for (const [pid, ticks] of now) {
            const d = ticks - (lastProc.get(pid) ?? ticks);
            if (d > 0) {
                const n = procName(pid) || '?';
                byName.set(n, (byName.get(n) ?? 0) + d);
            }
        }
        const scale = 100 * GLib.get_num_processors() / (total - lastTotal);
        for (const [n, d] of byName)
            result.push([n, d * scale]);
        result.sort((a, b) => b[1] - a[1]);
    }
    for (const pid of nameCache.keys()) {
        if (!now.has(pid))
            nameCache.delete(pid);
    }
    lastProc = now;
    lastTotal = total;
    return result.slice(0, TOP_N);
}

function updateGpuApps() {
    if (!hasSmi || gpuAsleep()) {
        gpuApps = [];
        showGpu();
        return;
    }
    run('apps', ['nvidia-smi', 'pmon', '-c', '1', '-s', 'u'], out => {
        const apps = new Map();
        for (const line of out.split('\n')) {
            if (line.startsWith('#') || !line.trim())
                continue;
            const c = line.trim().split(/\s+/);
            const pid = c[1];
            const sm = parseFloat(c[3]);
            if (!/^\d+$/.test(pid))
                continue;
            const n = procName(pid) || c[c.length - 1];
            apps.set(n, (apps.get(n) ?? 0) + (isNaN(sm) ? 0 : sm));
        }
        gpuApps = [...apps].sort((a, b) => b[1] - a[1]).slice(0, TOP_N);
        showGpu();
    });
}

function showGpu() {
    if (!rows.gpu)
        return;
    if (!hasSmi) {
        rows.gpuHead.text = 'GPU  no NVIDIA driver tools';
        rows.gpu.text = '  –';
        return;
    }
    rows.gpuHead.text = gpu?.asleep ? 'GPU  asleep'
        : `GPU  ${gpu?.util ?? '?'}% · ${gpu ? (gpu.mem / 1024).toFixed(1) : '?'} GB VRAM`;
    rows.gpu.text = gpu?.asleep ? '  –' : list(gpuApps, '%');
}

function fmtT(v) {
    return v === null || v === undefined ? '–' : `${Math.round(v)}°`;
}

function list(entries, unit) {
    entries = entries.filter(([, v]) => v >= 0.5);
    if (!entries.length)
        return '  –';
    return entries.map(([n, v]) => {
        const name = n.length > 22 ? `${n.slice(0, 21)}…` : n;
        return `  ${name.padEnd(22)} ${v.toFixed(0).padStart(4)}${unit}`;
    }).join('\n');
}

function defaultIface() {
    // Interface of the default IPv4 route.
    for (const l of readSys('/proc/net/route').split('\n').slice(1)) {
        const c = l.split('\t');
        if (c[1] === '00000000')
            return c[0];
    }
    return null;
}

function fmtRate(bytesPerSec) {
    const kb = bytesPerSec / 1024;
    return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB/s` : `${Math.round(kb)} KB/s`;
}

function fmtShort(bytesPerSec) {
    // Compact form for the top bar: "20K", "1.2M", "12M".
    const kb = bytesPerSec / 1024;
    if (kb < 1000)
        return `${Math.round(kb)}K`;
    if (kb < 10 * 1024)
        return `${(kb / 1024).toFixed(1)}M`;
    return `${Math.round(kb / 1024)}M`;
}

function updateNet() {
    // Download/upload rate on the default-route interface since the last call.
    const ifc = defaultIface();
    if (!ifc) {
        net = null;
        lastNet = null;
        return;
    }
    const rx = parseInt(readSys(`/sys/class/net/${ifc}/statistics/rx_bytes`));
    const tx = parseInt(readSys(`/sys/class/net/${ifc}/statistics/tx_bytes`));
    const t = GLib.get_monotonic_time();
    if (lastNet && lastNet.ifc === ifc && t > lastNet.time) {
        const dt = (t - lastNet.time) / 1e6;
        net = { ifc, down: (rx - lastNet.rx) / dt, up: (tx - lastNet.tx) / dt };
    }
    lastNet = { ifc, rx, tx, time: t };
}

function netText() {
    if (!net)
        return 'Net  offline';
    // Wi-Fi signal from /proc/net/wireless, e.g. "wlp0s20f3: 0000   47.  -63.  ..."
    const w = readSys('/proc/net/wireless').split('\n')
        .find(l => l.trim().startsWith(`${net.ifc}:`));
    const sig = w ? ` · ${parseInt(w.trim().split(/\s+/)[3])} dBm` : '';
    return `Net  ↓ ${fmtRate(net.down)}  ↑ ${fmtRate(net.up)}  (${net.ifc}${sig})`;
}

function fansText() {
    const f = readSys('/run/legion-fans').split(' ').map(n => parseInt(n));
    if (f.length < 2 || isNaN(f[0]))
        return 'Fans  –';
    return `Fans  ${f[0]} / ${f[1]} RPM`;
}

function updateDetails() {
    const gen = generation;
    hwmonTemps().then(t => {
        if (!live(gen) || !rows.temps)
            return;
        const gpuT = gpu?.asleep ? 'asleep' : fmtT(gpu?.temp);
        rows.temps.text =
            `CPU ${fmtT(t.cpuPkg)} (core max ${fmtT(t.cpuMax)})   GPU ${gpuT}\n` +
            `SSD ${t.nvme.map(fmtT).join(' / ') || '–'}   Wi-Fi ${fmtT(t.wifi)}`;
    });
    rows.fans.text = fansText();

    const mhz = readSys('/proc/cpuinfo').split('\n')
        .filter(l => l.startsWith('cpu MHz')).map(l => parseFloat(l.split(':')[1]));
    const avgMhz = mhz.length ? mhz.reduce((a, b) => a + b, 0) / mhz.length : 0;
    const pl1 = Math.round(parseInt(readSys(`${RAPL}constraint_0_power_limit_uw`)) / 1e6);
    const source = readSys(ADAPTER) === '1' ? (pl1 < 100 ? ' (weak charger)' : '') : ' (battery)';
    rows.cpuHead.text = `CPU  ${(avgMhz / 1000).toFixed(1)} GHz avg` +
        (isNaN(pl1) ? '' : ` · limit ${pl1} W${source}`);
    rows.cpu.text = list(topCpu(), '%');

    updateGpuApps();
    showGpu();

    const mem = {};
    for (const l of readSys('/proc/meminfo').split('\n')) {
        const [k, v] = l.split(':');
        mem[k] = parseInt(v) / 1048576;   // kB -> GB
    }
    const used = mem.MemTotal - mem.MemAvailable;
    const swap = mem.SwapTotal - mem.SwapFree;
    rows.mem.text = `RAM ${used.toFixed(1)}/${mem.MemTotal.toFixed(0)} GB` +
        `   Swap ${swap.toFixed(1)} GB` +
        `   Load ${readSys('/proc/loadavg').split(' ')[0]}`;

    rows.net.text = netText();
    return GLib.SOURCE_CONTINUE;
}

/* ---------- battery submenu ---------- */

function hm(hours) {
    const m = Math.round(hours * 60);
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

function showBattery() {
    // Like the Mac battery menu: state + time estimate, then health/cycles.
    if (!batt || !battery)
        return;
    const { capacity, now, full, design, power, cycles } = battery;
    const limited = readSys(CONSERVATION) === '1';
    const watts = (power / 1e6).toFixed(0);
    let state;
    switch (battery.status) {
    case 'Discharging':
        state = power > 0 ? `on battery −${watts} W · ${hm(now / power)} left` : 'on battery';
        break;
    case 'Charging': {
        const target = full * (limited ? 0.8 : 1);   // Conservation Mode stops near 80%
        state = power > 0 && target > now
            ? `charging +${watts} W · ${limited ? '80%' : 'full'} in ${hm((target - now) / power)}`
            : 'charging';
        break;
    }
    case 'Full':
        state = 'fully charged';
        break;
    default:
        state = limited ? 'plugged in · holding charge' : 'plugged in · not charging';
    }
    batt.state.text = `${capacity}% · ${state}`;
    batt.health.text = design > 0
        ? `Health ${(100 * full / design).toFixed(0)}%` + (cycles > 0 ? ` · ${cycles} cycles` : '')
        : '';
    batt.capacity.text = design > 0
        ? `Holds ${(full / 1e6).toFixed(1)} of ${(design / 1e6).toFixed(0)} Wh when new`
        : '';
    batt.limit.setToggleState(limited);
}

function batteryLine() {
    const item = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
    const label = new St.Label({ style: 'font-size: 90%;' });
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    label.clutter_text.line_wrap = true;
    item.add_child(label);
    batt.section.addMenuItem(item);
    return label;
}

function addBatterySection() {
    // Into GNOME's own battery entry in the system menu (the one showing
    // "Not Charging" / "2:10 Remaining"), above "Power Settings".
    const sub = Main.panel.statusArea.aggregateMenu._power._item.menu;
    batt = { section: new PopupMenu.PopupMenuSection(), sub };
    batt.state = batteryLine();
    batt.health = batteryLine();
    batt.capacity = batteryLine();
    batt.limit = new PopupMenu.PopupSwitchMenuItem('Limit charge to 80%', false);
    batt.limit.visible = GLib.file_test(CONSERVATION, GLib.FileTest.EXISTS);
    batt.limit.connect('toggled', (item, on) => setChargeLimit(on));
    batt.section.addMenuItem(batt.limit);
    batt.section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    sub.addMenuItem(batt.section, 0);
    // The bar's 3 s update refreshes the data; this just repaints on open.
    batt.openId = sub.connect('open-state-changed', (m, open) => {
        if (open)
            showBattery();
    });
}

function removeBatterySection() {
    if (!batt)
        return;
    batt.sub.disconnect(batt.openId);
    batt.section.destroy();
    batt = null;
}

function setChargeLimit(on) {
    // conservation_mode is made writable for the sudo group by the
    // usbc-power-cap service. sysfs needs a plain write (no temp file).
    const gen = generation;
    try {
        const proc = Gio.Subprocess.new(['sh', '-c', 'printf %s "$1" > "$2"', 'sh', on ? '1' : '0', CONSERVATION],
            Gio.SubprocessFlags.STDERR_SILENCE);
        proc.wait_check_async(null, (p, res) => {
            try {
                p.wait_check_finish(res);
            } catch (e) {
                Main.notify('Charge limit', 'Not allowed to change it. Reinstall the power service ' +
                    '(usbc-fix/install.sh) to enable this switch.');
            }
            if (live(gen))
                showBattery();
        });
    } catch (e) {
        logError(e, 'essentials power');
    }
}

/* ---------- panel ---------- */

function addRow(menu, key, mono) {
    const item = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
    rows[key] = new St.Label({ text: '…' });
    if (mono)
        rows[key].style = 'font-family: monospace; font-size: 90%;';
    item.add_child(rows[key]);
    menu.addMenuItem(item);
}

function buildMenu(menu) {
    menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Temperatures'));
    addRow(menu, 'temps', false);
    addRow(menu, 'fans', false);
    menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    addRow(menu, 'cpuHead', false);
    addRow(menu, 'cpu', true);
    addRow(menu, 'gpuHead', false);
    addRow(menu, 'gpu', true);
    menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    addRow(menu, 'mem', false);
    addRow(menu, 'net', false);
}

function pointerInside() {
    const [x, y] = global.get_pointer();
    const actor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
    return actor && (button.contains(actor) || button.menu.actor.contains(actor));
}

function scheduleClose() {
    // Close shortly after the pointer leaves both the button and the panel.
    if (closeTimer)
        GLib.source_remove(closeTimer);
    closeTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
        closeTimer = null;
        if (button?.menu.isOpen && !pointerInside())
            button.menu.close();
        return GLib.SOURCE_REMOVE;
    });
}

function onOpenChanged(menu, open) {
    if (detailTimer) {
        GLib.source_remove(detailTimer);
        detailTimer = null;
    }
    if (open) {
        lastProc = null;
        updateDetails();
        detailTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, updateDetails);
    }
}

function barLabel(style = '') {
    // Tabular digits so widths don't jitter; never truncate to "…".
    const l = new St.Label({
        text: '',
        y_align: Clutter.ActorAlign.CENTER,
        style: `font-feature-settings: "tnum"; ${style}`,
    });
    l.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return l;
}

function rateSlot() {
    // Fixed-width slot (in em, so it scales with the font) with the rate
    // right-aligned inside: "↓2K" and "↓1.2M" occupy the same space.
    const l = barLabel();
    l.x_align = Clutter.ActorAlign.END;
    l.x_expand = true;
    const slot = new St.Bin({ style: 'min-width: 3.1em;', child: l });
    return [slot, l];
}

function buildBar() {
    // Spacing is in em, so the widget scales with the font (text-scaling
    // factor, monitor DPI) instead of fixed characters.
    const box = new St.BoxLayout({ style: 'spacing: 0.55em;' });
    const [downSlot, down] = rateSlot();
    const [upSlot, up] = rateSlot();
    bar = {
        bat: barLabel(),
        cpu: barLabel(),
        gpu: barLabel(),
        net: new St.BoxLayout({ style: 'spacing: 0.15em;' }),
        down,
        up,
    };
    bar.net.add_child(downSlot);
    bar.net.add_child(upSlot);
    for (const w of [bar.bat, bar.cpu, bar.gpu, bar.net])
        box.add_child(w);
    bar.bat.text = '…';
    return box;
}

/* ---------- lifecycle ---------- */

function enable(_settings) {
    hasSmi = GLib.find_program_in_path('nvidia-smi') !== null && GLib.file_test(GPU_PM, GLib.FileTest.EXISTS);
    smiBusy = {};
    button = new PanelMenu.Button(0.0, 'Power Monitor', false);
    button.add_child(buildBar());
    buildMenu(button.menu);
    button.menu.connect('open-state-changed', onOpenChanged);
    button.connect('leave-event', scheduleClose);
    button.menu.actor.connect('leave-event', scheduleClose);
    Main.panel.addToStatusArea('essentials-power', button, 0, 'right');
    addBatterySection();
    protectBatteryLabel();
    squeeze = 0;
    update();
    timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
        update();
        scheduleFit();   // other indicators may have appeared or grown
        return GLib.SOURCE_CONTINUE;
    });
    rightBoxId = Main.panel._rightBox.connect('notify::allocation', scheduleFit);
    scheduleFit();
}

function disable() {
    generation++;
    if (rightBoxId)
        Main.panel._rightBox.disconnect(rightBoxId);
    if (fitId)
        GLib.source_remove(fitId);
    rightBoxId = fitId = 0;
    if (batteryLabel)
        batteryLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    batteryLabel = null;
    for (const id of [timer, detailTimer, closeTimer]) {
        if (id)
            GLib.source_remove(id);
    }
    timer = detailTimer = closeTimer = null;
    removeBatterySection();
    button?.destroy();
    button = bar = null;
    rows = {};
    hwmon = null;
    nameCache = new Map();
    battery = lastEnergy = cpuW = gpu = lastProc = lastNet = net = null;
    gpuApps = [];
}
