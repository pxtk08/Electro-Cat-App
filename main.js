const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL, fileURLToPath } = require('url');
const { SPECIAL_ID, README_RE, classifyZipName, extractZip } = require('./importer');
const { createUpdater } = require('./updater');

// Bản cài đặt (NSIS): dữ liệu nằm trong userData để KHÔNG bị xóa khi app tự cập nhật / gỡ cài
// (cùng chỗ với installed.json và settings.json). Khi chạy dev: nằm cạnh main.js.
const DATA_DIR = app.isPackaged ? path.join(app.getPath('userData'), 'data') : path.join(__dirname, 'data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

// Loại file: tong = file tổng (Unsplit), le = file chia lẻ (Split), cu = file cũ (định dạng trước đây)
const KINDS = ['tong', 'le', 'cu'];
// Mục đặc biệt "Điểm tele và thần đồng" không chia theo vùng/ngôn ngữ: data/TeleportOculi/<tele|oculi>/
const SPECIAL_KINDS = ['tele', 'oculi'];
const NAME_RE = /^[A-Za-z0-9_-]+$/;
// Mục "File không chính thức": data/Unofficial/<id vùng đất | Other>/<file>.json — người dùng tự phân loại, không chia theo ngôn ngữ
const UNOFFICIAL_ID = 'Unofficial';

// Thư mục chứa file theo (vùng, ngôn ngữ, loại); trả về null nếu tham số không hợp lệ
function kindDirOf(region, lang, kind) {
  if (!NAME_RE.test(String(region))) return null;
  if (region === SPECIAL_ID) return SPECIAL_KINDS.includes(kind) ? path.join(DATA_DIR, region, kind) : null;
  if (region === UNOFFICIAL_ID) return NAME_RE.test(String(kind)) ? path.join(DATA_DIR, region, kind) : null;
  if (!/^[a-z]{2}$/.test(String(lang)) || !KINDS.includes(kind)) return null;
  return path.join(DATA_DIR, region, lang, kind);
}

let win;

// Kiểm tra p nằm TRONG thư mục dir (không khớp nhầm "data_evil"; không phân biệt hoa/thường trên Windows)
function isInside(dir, p) {
  const norm = (x) => { const r = path.resolve(x); return process.platform === 'win32' ? r.toLowerCase() : r; };
  const d = norm(dir), t = norm(p);
  return t === d || t.startsWith(d + path.sep);
}

// Ghi file an toàn: chép sang file tạm cùng thư mục rồi đổi tên, tránh để chương trình khác đọc phải file dở dang
function safeCopy(src, dest) {
  const tmp = dest + '.' + process.pid + '.tmp';
  try {
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, dest);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw err;
  }
}

// Giới hạn dung lượng khi import
const JSON_MAX = 20 * 1024 * 1024;
const ANY_MAX = 100 * 1024 * 1024; // mục không chính thức: mọi loại file, tối đa 100MB/file
// Chỉ cho "Xem" các đuôi an toàn; file khác chỉ được hiện trong thư mục, không bị mở
const VIEW_EXT = new Set(['.json', '.txt', '.md', '.log']);

ipcMain.on('get-data-base', (e) => { e.returnValue = pathToFileURL(DATA_DIR).href + '/'; });

// ===================== Thư mục uni + nút "Dùng" =====================
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json'); // riêng cho từng máy
function loadSettings() { try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; } }
function saveSettings(o) { fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true }); fs.writeFileSync(SETTINGS_FILE, JSON.stringify(o, null, 2)); }
const targetName = () => loadSettings().target || 'waypoints.json'; // tên file waypoint trong thư mục uni

function dirInfo(dir) {
  let exists = false, hasTarget = false, jsonFiles = [];
  try {
    exists = fs.statSync(dir).isDirectory();
    if (exists) {
      const names = fs.readdirSync(dir);
      jsonFiles = names.filter((n) => /\.json$/i.test(n)).slice(0, 8);
      hasTarget = names.some((n) => n.toLowerCase() === targetName().toLowerCase());
    }
  } catch {}
  return { dir, exists, hasTarget, jsonFiles, target: targetName() };
}

ipcMain.handle('uni:get', () => { const s = loadSettings(); return s.uniDir ? dirInfo(s.uniDir) : { dir: null, exists: false }; });

// Tự tìm thư mục tên "uni" ở các ổ đĩa và thư mục quen thuộc
ipcMain.handle('uni:detect', () => {
  const found = new Set();
  if (process.platform === 'win32') for (let c = 67; c <= 90; c++) found.add(String.fromCharCode(c) + ':\\uni');
  for (const k of ['home', 'desktop', 'documents', 'downloads']) { try { found.add(path.join(app.getPath(k), 'uni')); } catch {} }
  return [...found].map(dirInfo).filter((i) => i.exists);
});

ipcMain.handle('uni:browse', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Chọn thư mục uni', properties: ['openDirectory'],
    defaultPath: process.platform === 'win32' ? 'C:\\' : app.getPath('home')
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return dirInfo(r.filePaths[0]);
});

ipcMain.handle('uni:set', (_e, dir) => {
  dir = String(dir);
  const info = dirInfo(dir);
  if (!info.exists) return { error: 'Thư mục không tồn tại.' };
  try { fs.accessSync(dir, fs.constants.W_OK); }
  catch { return { error: 'Không có quyền ghi vào thư mục này (thử mở launcher bằng Run as administrator).' }; }
  const st = loadSettings(); st.uniDir = dir; saveSettings(st);
  return info;
});

let lastUse = null;
function pruneBackups(bdir, keep = 10) {
  try { fs.readdirSync(bdir).sort().slice(0, -keep).forEach((n) => fs.rmSync(path.join(bdir, n), { force: true })); } catch {}
}

// "Dùng": sao lưu waypoint cũ trong uni rồi thay bằng file đã chọn
ipcMain.handle('uni:use', (_e, region, lang, kind, file) => {
  const st = loadSettings();
  if (!st.uniDir) return { error: 'Chưa chọn thư mục uni.' };
  const kdir = kindDirOf(region, lang, kind);
  if (!kdir || !file || path.basename(String(file)) !== String(file)) return { error: 'Tham số không hợp lệ.' };
  if (!/\.json$/i.test(String(file))) return { error: 'Chỉ file .json mới dùng được làm waypoint.' };
  const src = path.join(kdir, file);
  if (!fs.existsSync(src)) return { error: 'Không tìm thấy file: ' + src };
  if (!dirInfo(st.uniDir).exists) return { error: 'Thư mục uni không còn tồn tại.' };
  const targetPath = path.join(st.uniDir, targetName());
  try {
    let backup = null;
    if (fs.existsSync(targetPath)) {
      const bdir = path.join(st.uniDir, '_electrocat_backup');
      fs.mkdirSync(bdir, { recursive: true });
      backup = path.join(bdir, new Date().toISOString().replace(/[:.]/g, '-') + '_' + targetName());
      fs.copyFileSync(targetPath, backup);
      pruneBackups(bdir);
    }
    safeCopy(src, targetPath);
    lastUse = { targetPath, backup };
    return { ok: true };
  } catch (err) { return { error: 'Lỗi: ' + err.message }; }
});

ipcMain.handle('uni:undo', () => {
  if (!lastUse) return { error: 'Không có gì để hoàn tác.' };
  try {
    if (lastUse.backup) safeCopy(lastUse.backup, lastUse.targetPath);
    else fs.rmSync(lastUse.targetPath, { force: true });
    lastUse = null; return { ok: true };
  } catch (err) { return { error: err.message }; }
});
// =====================================================================

// ===================== Quét thư mục data + kéo thả file =====================
function countPoints(full) {
  try {
    const j = JSON.parse(fs.readFileSync(full, 'utf8'));
    if (Array.isArray(j)) return j.length;
    for (const k of ['points', 'waypoints', 'data']) if (Array.isArray(j[k])) return j[k].length;
    return 0;
  } catch { return 0; }
}
const listDir = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };

// Trả về { files: {Vùng: {lang: {tong:[{file,points}], le:[...], cu:[...]}}}, readmes: {...} }
// Riêng mục TeleportOculi: files.TeleportOculi = { _: { tele:[...], oculi:[...] } }
// all = true (mục không chính thức): liệt kê mọi file; file không phải .json có points = null
function scanKind(kdir, all = false) {
  return listDir(kdir)
    .filter((e) => e.isFile() && (all ? !/\.\d+\.tmp$/.test(e.name) : /\.json$/i.test(e.name)))
    .map((e) => ({ file: e.name, points: /\.json$/i.test(e.name) ? countPoints(path.join(kdir, e.name)) : (all ? null : 0) }))
    .sort((a, b) => a.file.localeCompare(b.file, undefined, { numeric: true })); // 2. trước 10.
}
// Tìm file README trong 1 thư mục (nếu có)
function findReadme(dir) {
  const e = listDir(dir).find((x) => x.isFile() && README_RE.test(x.name));
  return e ? e.name : null;
}
ipcMain.handle('data:scan', () => {
  const files = {}, readmes = {}; // readmes: "Vùng|lang|loại" -> tên file README
  for (const r of listDir(DATA_DIR)) {
    if (!r.isDirectory() || !NAME_RE.test(r.name)) continue;
    const rdir = path.join(DATA_DIR, r.name);
    files[r.name] = {};
    if (r.name === UNOFFICIAL_ID) {
      files[r.name]._ = {};
      for (const l of listDir(rdir)) {
        if (l.isDirectory() && NAME_RE.test(l.name)) files[r.name]._[l.name] = scanKind(path.join(rdir, l.name), true);
      }
      continue;
    }
    if (r.name === SPECIAL_ID) {
      files[r.name]._ = {};
      for (const k of SPECIAL_KINDS) {
        files[r.name]._[k] = scanKind(path.join(rdir, k));
        const rm = findReadme(path.join(rdir, k)); if (rm) readmes[`${r.name}|_|${k}`] = rm;
      }
    }
    for (const l of listDir(rdir)) {
      if (!l.isDirectory()) continue;
      if (r.name === SPECIAL_ID || !/^[a-z]{2}$/.test(l.name)) continue;
      files[r.name][l.name] = {};
      for (const k of KINDS) {
        files[r.name][l.name][k] = scanKind(path.join(rdir, l.name, k));
        const rm = findReadme(path.join(rdir, l.name, k)); if (rm) readmes[`${r.name}|${l.name}|${k}`] = rm;
      }
    }
  }
  return { files, readmes };
});

// Ghi 1 file vào thư mục đích, trả về 'added' hoặc 'updated'
function writeInto(destDir, name, data) {
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, name);
  const existed = fs.existsSync(dest);
  const tmp = dest + '.' + process.pid + '.tmp';
  try { fs.writeFileSync(tmp, data); fs.renameSync(tmp, dest); }
  catch (err) { try { fs.rmSync(tmp, { force: true }); } catch {} throw err; }
  return existed ? 'updated' : 'added';
}

// Kéo thả:
//  - .zip  -> tự giải nén và phân loại theo TÊN FILE (vùng / ngôn ngữ / loại), bỏ qua mục đang chọn
//  - .json -> data/<Vùng>/<lang>/<kind>/ (mục đang chọn)
// Trả về { added, updated, failed, zips:[{zip,region,lang,kind,special,added,updated}], zipFailed:[{zip,code}] }
function importPaths(region, lang, kind, paths) {
  const res = { added: [], updated: [], failed: [], zips: [], zipFailed: [] };
  const list = Array.isArray(paths) ? paths : [];
  const manual = region === UNOFFICIAL_ID; // mục không chính thức: người dùng tự chọn tab, zip cũng vào thẳng tab đó
  const hasLoose = manual || list.some((p) => !/\.zip$/i.test(String(p)));
  const looseDir = kindDirOf(region, lang, kind);
  if (hasLoose && !looseDir) return { error: 'Tham số không hợp lệ.' };

  for (const p of list) {
    const name = path.basename(String(p));
    try {
      if (!name || !fs.statSync(p).isFile()) { res.failed.push(name || String(p)); continue; }
      const ext = path.extname(name).toLowerCase();

      if (ext === '.zip') {
        // Mục không chính thức: zip có tên theo chuẩn chính thức (nhận ra được vùng/ngôn ngữ/loại hoặc tele/thần đồng) thì
        // tự chuyển lên mục chính thức; chỉ zip không nhận ra mới ở lại tab đang mở
        let c = classifyZipName(name), asManual = false;
        if (manual) { if (c.error) { c = { region, lang: null, kind }; asManual = true; } else c.redirected = true; }
        if (c.error) { res.zipFailed.push({ zip: name, code: c.error }); continue; }
        const destDir = asManual ? looseDir
          : c.special ? kindDirOf(SPECIAL_ID, '', c.special)
          : kindDirOf(c.region, c.lang, c.kind);

        let ex;
        try { ex = extractZip(p, [targetName()], { all: asManual }); }
        catch (err) { res.zipFailed.push({ zip: name, code: err.code || 'bad' }); continue; }
        if (!ex.jsons.length) { res.zipFailed.push({ zip: name, code: 'empty' }); continue; }

        const r = { zip: name, region: c.special ? SPECIAL_ID : c.region, lang: c.lang || null, kind: c.special || c.kind, added: 0, updated: 0, redirected: !!c.redirected };
        for (const f of ex.jsons) r[writeInto(destDir, f.name, f.data)]++;
        if (ex.readme) { // thay README cũ (kể cả khác đuôi) bằng README của zip mới
          for (const e of listDir(destDir)) if (e.isFile() && README_RE.test(e.name)) { try { fs.rmSync(path.join(destDir, e.name), { force: true }); } catch {} }
          writeInto(destDir, ex.readme.name, ex.readme.data);
        }
        res.zips.push(r);
        continue;
      }

      const isJson = ext === '.json';
      // Mục chính thức: chỉ nhận .zip và .json. Mục không chính thức (manual): nhận MỌI loại file, không kiểm tra nội dung
      if (!manual && !isJson) { res.failed.push(name); continue; }
      if (fs.statSync(p).size > (manual ? ANY_MAX : JSON_MAX)) { res.failed.push(name); continue; }
      if (isJson && !manual) { JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } // mục chính thức: phải là JSON hợp lệ
      res[writeInto(looseDir, name, fs.readFileSync(p))].push(name);
    } catch { res.failed.push(name); }
  }
  return res;
}
ipcMain.handle('data:import', (_e, region, lang, kind, paths) => importPaths(region, lang, kind, paths));

// ===================== Đổi tên hiển thị (chỉ trong app, không đụng tới file thật) =====================
// Lưu trong settings.json (riêng từng máy): names = { "đường/dẫn/tương/đối/trong/data": "tên hiển thị" }
const aliasKey = (full) => path.relative(DATA_DIR, full).split(path.sep).join('/');
function dropAlias(full) {
  try {
    const st = loadSettings(), k = aliasKey(full);
    if (st.names && Object.prototype.hasOwnProperty.call(st.names, k)) { delete st.names[k]; saveSettings(st); }
  } catch {}
}
// Chuyển tên hiển thị đã đổi sang đường dẫn mới khi file được di chuyển
function moveAlias(oldFull, newFull) {
  try {
    const st = loadSettings(), ok = aliasKey(oldFull), nk = aliasKey(newFull);
    if (st.names && Object.prototype.hasOwnProperty.call(st.names, ok)) { st.names[nk] = st.names[ok]; delete st.names[ok]; saveSettings(st); }
  } catch {}
}
ipcMain.handle('names:get', () => { const n = loadSettings().names; return n && typeof n === 'object' ? n : {}; });
ipcMain.handle('names:set', (_e, key, name) => {
  key = String(key); name = String(name == null ? '' : name).trim().slice(0, 120);
  if (!key.includes('/') || key.length > 400 || key.includes('..')) return { error: 'Tham số không hợp lệ.' };
  const st = loadSettings();
  const names = st.names && typeof st.names === 'object' ? st.names : {};
  if (name) names[key] = name; else delete names[key]; // tên rỗng = quay về tên gốc
  st.names = names; saveSettings(st);
  return { ok: true, names };
});

// Xóa file: chuyển vào Thùng rác (khôi phục được). kind = tong|le|cu|tele|oculi (hoặc tab của mục không chính thức)
ipcMain.handle('data:delete', async (_e, region, lang, kind, files) => {
  const dir = kindDirOf(region, lang, kind);
  if (!dir || !Array.isArray(files) || files.length > 1000) return { error: 'Tham số không hợp lệ.' };
  const res = { deleted: [], failed: [] };
  for (const f of files) {
    const name = String(f);
    const full = path.join(dir, name);
    if (!name || path.basename(name) !== name || !isInside(dir, full) || !fs.existsSync(full)) { res.failed.push(name); continue; }
    try { await shell.trashItem(full); res.deleted.push(name); dropAlias(full); }
    catch { res.failed.push(name); }
  }
  return res;
});

// Di chuyển file giữa các tab của mục "File không chính thức" (chỉ trong mục này)
ipcMain.handle('data:move', (_e, fromKind, toKind, files) => {
  const from = kindDirOf(UNOFFICIAL_ID, '', fromKind), to = kindDirOf(UNOFFICIAL_ID, '', toKind);
  if (!from || !to || from === to || !Array.isArray(files) || files.length > 1000) return { error: 'Tham số không hợp lệ.' };
  const res = { moved: [], exists: [], failed: [] };
  for (const f of files) {
    const name = String(f), src = path.join(from, name), dest = path.join(to, name);
    try {
      if (!name || path.basename(name) !== name || !isInside(from, src) || !fs.statSync(src).isFile()) { res.failed.push(name); continue; }
      if (fs.existsSync(dest)) { res.exists.push(name); continue; } // không ghi đè file cùng tên
      fs.mkdirSync(to, { recursive: true });
      try { fs.renameSync(src, dest); }
      catch (err) { if (err.code !== 'EXDEV') throw err; fs.copyFileSync(src, dest); fs.rmSync(src, { force: true }); }
      moveAlias(src, dest);
      res.moved.push(name);
    } catch { res.failed.push(name); }
  }
  return res;
});

// Đọc file văn bản (README, .txt, .md, .log) để hiện trong app; tối đa 256 KB
const READ_EXT = new Set(['.txt', '.md', '.log']);
ipcMain.handle('data:read', (_e, region, lang, kind, file) => {
  const dir = kindDirOf(region, lang, kind);
  if (!dir || !file || path.basename(String(file)) !== String(file)) return { error: 'Tham số không hợp lệ.' };
  const full = path.join(dir, String(file));
  if (!isInside(dir, full) || !(READ_EXT.has(path.extname(String(file)).toLowerCase()) || README_RE.test(String(file)))) return { error: 'Không đọc được loại file này.' };
  try {
    const st = fs.statSync(full);
    if (!st.isFile()) return { error: 'Không tìm thấy file.' };
    if (st.size > 256 * 1024) return { error: 'File quá lớn để xem trong app (tối đa 256 KB).' };
    const buf = fs.readFileSync(full);
    const text = (buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8')).replace(/^\uFEFF/, '');
    return { name: String(file), text };
  } catch { return { error: 'Không đọc được file.' }; }
});

ipcMain.handle('data:open', () => { shell.openPath(DATA_DIR); return { ok: true }; });
// =====================================================================

function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 760, minWidth: 820, minHeight: 560,
    backgroundColor: '#18121f', autoHideMenuBar: true, title: 'Electro Cat - By pxtk.08',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  // Nút "Xem": mở file bằng chương trình mặc định của máy
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) { shell.openExternal(url); return { action: 'deny' }; }
    if (url.startsWith('file:')) {
      try {
        const p = fileURLToPath(url);
        if (isInside(DATA_DIR, p) && fs.existsSync(p)) {
          if (VIEW_EXT.has(path.extname(p).toLowerCase())) shell.openPath(p);
          else shell.showItemInFolder(p); // file lạ/.exe…: chỉ hiện trong thư mục, không mở (tránh bị chạy)
        }
      } catch {}
    }
    return { action: 'deny' };
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// ===================== Tự tải / cập nhật dữ liệu từ GitHub =====================
const MANIFEST_URL = 'https://raw.githubusercontent.com/pxtk08/Electro-Cat-App-Data/main/manifest.json';
const updater = createUpdater({
  manifestUrl: MANIFEST_URL,
  stateFile: path.join(app.getPath('userData'), 'installed.json'),
  tmpDir: path.join(app.getPath('temp'), 'electrocat-dl'),
  importPaths: (paths) => importPaths(null, null, null, paths),
  hasData: (c) => { // thư mục đích của zip còn file .json nào không (để biết người dùng đã xóa tay hay chưa)
    const dir = c.special ? kindDirOf(SPECIAL_ID, '', c.special) : kindDirOf(c.region, c.lang, c.kind);
    return !!dir && listDir(dir).some((e) => e.isFile() && /\.json$/i.test(e.name));
  },
  onEvent: (ev) => { if (win && !win.isDestroyed()) win.webContents.send('sync:event', ev); }
});
ipcMain.handle('sync:check', (_e, mode) => updater.check({ mode }));
ipcMain.handle('sync:list', () => updater.list());
// =====================================================================

// ===================== Tự cập nhật chính app (electron-updater + GitHub Releases) =====================
function setupAppUpdater() {
  if (!app.isPackaged) return; // chạy dev (npm start) thì bỏ qua
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); }
  catch (e) { console.error('[app-update] thiếu electron-updater (chạy npm install):', e.message); return; } // thiếu thư viện thì app vẫn chạy bình thường
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // chưa bấm khởi động lại thì tự cài khi người dùng tắt app
  autoUpdater.on('error', (e) => console.error('[app-update]', e && e.message)); // mất mạng...: im lặng, lần sau thử lại
  autoUpdater.on('update-downloaded', async (info) => {
    if (!win || win.isDestroyed()) return;
    const r = await dialog.showMessageBox(win, {
      type: 'info', buttons: ['Khởi động lại ngay', 'Để sau'], defaultId: 0, cancelId: 1,
      title: 'Có bản cập nhật', message: 'ElectroCat ' + info.version + ' đã tải xong.',
      detail: 'Khởi động lại để dùng bản mới. Chọn "Để sau" thì app sẽ tự cập nhật khi bạn tắt app.'
    });
    if (r.response === 0) autoUpdater.quitAndInstall();
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 6 * 60 * 60 * 1000).unref(); // app mở lâu thì cứ 6 giờ kiểm tra lại
}
// =====================================================================

app.whenReady().then(() => {
  createWindow();
  win.webContents.once('did-finish-load', () => { updater.start(); setupAppUpdater(); }); // dữ liệu: mỗi 24h; app: mỗi 6h
});
app.on('window-all-closed', () => app.quit());
