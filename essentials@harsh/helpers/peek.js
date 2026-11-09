// Gathers everything the quick-look card needs about one file and prints it
// as JSON: { thumb, info: [..], list: [..], more }.
//   thumb - path of a 512 px thumbnail (cached in ~/.cache/thumbnails, shared
//           with Files). Falls back to ffmpeg for videos and LibreOffice for
//           Office documents when GNOME has no thumbnailer for them.
//   info  - extra details: image size, media duration/resolution, PDF pages,
//           archive item count and size.
//   list  - top-level entries of an archive.
// Runs as a separate process (killed when the preview moves on) so slow work
// never blocks GNOME Shell.
// Usage: gjs peek.js <file-uri>
imports.gi.versions.GnomeDesktop = '3.0';
const { GnomeDesktop, Gio, GLib, GdkPixbuf } = imports.gi;

const LIST_ROWS = 18;
const TAR_MAX_LINES = 5000;
const OFFICE = /opendocument|officedocument|msword|ms-excel|ms-powerpoint|application\/rtf/;
const TAR = /x-(compressed-|bzip-compressed-|xz-compressed-|zstd-compressed-)?tar/;

const uri = ARGV[0];
const file = Gio.File.new_for_uri(uri);
const path = file.get_path();
const finfo = file.query_info('standard::content-type,time::modified', 0, null);
const type = finfo.get_content_type();
const mtime = finfo.get_attribute_uint64('time::modified');
const cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'essentials']);
const out = { thumb: null, info: [], list: [], more: false };

// Every tool gets a time limit; the extension also kills this whole process
// group when the preview moves on.
const LIMIT = ['timeout', '-k', '2', '15'];
// ffmpeg/ffprobe: local files only (no HLS/concat references to the network).
const FF_SAFE = ['-protocol_whitelist', 'file,pipe'];

function run(argv) {
    // Returns stdout, or '' on any failure.
    try {
        const proc = Gio.Subprocess.new(argv,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        const [, stdout] = proc.communicate_utf8(null, null);
        return proc.get_successful() ? stdout : '';
    } catch (e) {
        return '';
    }
}

function runLines(argv, max) {
    // Streams stdout line by line and stops after `max` lines. Names that
    // aren't valid UTF-8 (old archives) are decoded leniently.
    const lines = [];
    let proc;
    try {
        proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        const stream = new Gio.DataInputStream({ base_stream: proc.get_stdout_pipe() });
        const decoder = new TextDecoder('utf-8', { fatal: false });
        for (;;) {
            const [bytes] = stream.read_line(null);
            if (bytes === null || lines.length >= max)
                break;
            lines.push(decoder.decode(bytes));
        }
    } catch (e) {
        return [[], false];
    } finally {
        proc?.force_exit();
    }
    return [lines, lines.length >= max];
}

function duration(sec) {
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
    const mm = h ? String(m).padStart(2, '0') : m;
    return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

// ---- thumbnail ----

const factory = GnomeDesktop.DesktopThumbnailFactory.new(GnomeDesktop.DesktopThumbnailSize.XLARGE);

function saveThumb(pixbufPath) {
    try {
        let pb = GdkPixbuf.Pixbuf.new_from_file_at_size(pixbufPath, 512, 512);
        factory.save_thumbnail(pb, uri, mtime);
        return factory.lookup(uri, mtime);
    } catch (e) {
        return null;
    }
}

function videoFrame(seconds) {
    GLib.mkdir_with_parents(cacheDir, 0o700);
    const tmp = GLib.build_filenamev([cacheDir, `frame-${GLib.uuid_string_random()}.png`]);
    const at = Math.min(seconds * 0.1, 30).toFixed(2);
    run([...LIMIT, 'nice', '-n', '10', 'ffmpeg', '-v', 'error', ...FF_SAFE, '-ss', at, '-i', path,
        '-frames:v', '1', '-vf', 'scale=512:-2', '-y', tmp]);
    const thumb = GLib.file_test(tmp, GLib.FileTest.EXISTS) ? saveThumb(tmp) : null;
    GLib.unlink(tmp);
    return thumb;
}

function officePage() {
    // LibreOffice renders page 1 to PNG. Its own profile keeps it independent
    // of a LibreOffice window the user may have open; flock serialises runs;
    // `unshare -rn` cuts network access, so linked remote content in a
    // document can't report that it was previewed. The output dir is per
    // file+mtime and removed once the thumbnail is saved.
    const key = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, uri, -1);
    const dir = GLib.build_filenamev([cacheDir, 'office', `${key}-${mtime}`]);
    const base = file.get_basename().replace(/\.[^.]*$/, '');
    const png = GLib.build_filenamev([dir, `${base}.png`]);
    if (!GLib.file_test(png, GLib.FileTest.EXISTS)) {
        GLib.mkdir_with_parents(dir, 0o700);
        const profile = GLib.build_filenamev([cacheDir, 'lo-profile']);
        run(['flock', '-w', '30', GLib.build_filenamev([cacheDir, 'lo.lock']),
            'timeout', '-k', '5', '60', 'unshare', '-rn', 'nice', '-n', '10', 'soffice',
            `-env:UserInstallation=${GLib.filename_to_uri(profile, null)}`, '--headless', '--norestore',
            '--convert-to', 'png', '--outdir', dir, path]);
    }
    const thumb = GLib.file_test(png, GLib.FileTest.EXISTS) ? saveThumb(png) : null;
    if (thumb) {
        GLib.unlink(png);
        GLib.rmdir(dir);
    }
    return thumb;
}

function thumbnail(mediaSeconds) {
    let thumb = factory.lookup(uri, mtime);
    if (thumb)
        return thumb;
    if (!factory.has_valid_failed_thumbnail(uri, mtime) && factory.can_thumbnail(uri, type, mtime)) {
        // generate_thumbnail returns null on failure in GNOME 42. Only record
        // a failure (shared with Files) for files that are done changing.
        let pb = null;
        try {
            pb = factory.generate_thumbnail(uri, type);
        } catch (e) {}
        if (pb) {
            factory.save_thumbnail(pb, uri, mtime);
            return factory.lookup(uri, mtime);
        }
        if (GLib.get_real_time() / 1e6 - mtime > 60)
            factory.create_failed_thumbnail(uri, mtime);
    }
    if (type.startsWith('video/') && mediaSeconds !== null)
        return videoFrame(mediaSeconds);
    if (OFFICE.test(type))
        return officePage();
    return null;
}

// ---- details ----

function probeMedia() {
    // Returns the duration in seconds (or null) and fills out.info.
    const json = run([...LIMIT, 'ffprobe', '-v', 'error', ...FF_SAFE, '-print_format', 'json',
        '-show_entries', 'format=duration:format_tags=title,artist:stream=codec_type,width,height', path]);
    if (!json)
        return null;
    const p = JSON.parse(json);
    const secs = parseFloat(p.format?.duration);
    if (secs > 0)
        out.info.push(duration(secs));
    const v = (p.streams ?? []).find(s => s.codec_type === 'video' && s.width);
    if (v && type.startsWith('video/'))
        out.info.push(`${v.width}×${v.height}`);
    const tags = p.format?.tags ?? {};
    const tag = k => tags[k] ?? tags[k.toUpperCase()];
    if (tag('title'))
        out.info.push([tag('artist'), tag('title')].filter(Boolean).join(' — '));
    return secs > 0 ? secs : null;
}

function archive(names, truncated, extra) {
    // Summarise to top-level entries, with item counts for folders. Archives
    // that wrap everything in one folder are listed from inside that folder.
    const files = names.filter(n => !n.endsWith('/')).length;
    let paths = names.map(n => n.replace(/^\.\//, '')).filter(Boolean);
    let root = '';
    for (;;) {
        const first = paths[0]?.split('/')[0];
        if (!first || !paths.every(p => p.startsWith(`${first}/`)))
            break;
        root += `${first}/`;
        paths = paths.map(p => p.slice(first.length + 1)).filter(Boolean);
    }
    if (root)
        extra += ` · in ${root}`;
    const top = new Map();
    for (const n of paths) {
        const parts = n.split('/').filter(Boolean);
        if (!parts.length)
            continue;
        const isDir = parts.length > 1 || n.endsWith('/');
        const key = parts[0] + (isDir ? '/' : '');
        top.set(key, (top.get(key) ?? 0) + (parts.length > 1 ? 1 : 0));
    }
    out.info.push(`${files}${truncated ? '+' : ''} file${files === 1 ? '' : 's'}${extra}`);
    const entries = [...top].sort(([a], [b]) =>
        (b.endsWith('/') - a.endsWith('/')) || a.localeCompare(b));
    out.list = entries.slice(0, LIST_ROWS).map(([k, n]) =>
        k.endsWith('/') ? `📁 ${k}  ${n}` : `📄 ${k}`);
    out.more = entries.length > LIST_ROWS;
}

let mediaSeconds = null;
if (type.startsWith('image/')) {
    const [fmt, w, h] = GdkPixbuf.Pixbuf.get_file_info(path);
    if (fmt && w && h)
        out.info.push(`${w}×${h}`);
} else if (type.startsWith('video/') || type.startsWith('audio/')) {
    mediaSeconds = probeMedia();
} else if (type === 'application/pdf') {
    const m = run([...LIMIT, 'pdfinfo', path]).match(/^Pages:\s+(\d+)/m);
    if (m)
        out.info.push(`${m[1]} page${m[1] === '1' ? '' : 's'}`);
} else if (OFFICE.test(type)) {
    // handled by the thumbnail
} else if (Gio.content_type_is_a(type, 'application/zip')) {
    const names = run([...LIMIT, 'unzip', '-Z1', path]).split('\n').filter(Boolean);
    const m = run([...LIMIT, 'unzip', '-Zt', path]).match(/([\d]+) bytes uncompressed/);
    archive(names, false, m ? ` · ${GLib.format_size(Number(m[1]))} unpacked` : '');
} else if (TAR.test(type)) {
    const [names, truncated] = runLines([...LIMIT, 'tar', '-tf', path], TAR_MAX_LINES);
    archive(names, truncated, '');
}

out.thumb = thumbnail(mediaSeconds);
print(JSON.stringify(out));
