// updater.js — tự tải zip từ manifest online, kiểm tra sha256, rồi đưa vào importer có sẵn (tự phân loại theo TÊN FILE)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { classifyZipName } = require('./importer');

const TIMEOUT_MS = 20000;            // chờ server phản hồi tối đa 20s
const MAX_FILE = 300 * 1024 * 1024;  // khớp giới hạn zip trong importer.js

/**
 * manifestUrl : link raw tới manifest.json
 * stateFile   : file lưu trạng thái đã cài (nằm trong userData, riêng từng máy)
 * tmpDir      : thư mục tạm để tải về
 * importPaths : (paths[]) => kết quả của data:import (hàm import có sẵn trong main.js)
 * onEvent     : (ev) => gửi tiến độ cho giao diện
 * hasData     : ({region,lang,kind}|{special}) => true nếu thư mục đích của file zip đó vẫn còn dữ liệu trên máy
 */
function createUpdater({ manifestUrl, stateFile, tmpDir, importPaths, onEvent = () => {}, hasData = () => true }) {
  let busy = false;

  const loadState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } };
  const saveState = (s) => { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(s, null, 2)); };

  async function http(url) {
    if (!/^https:\/\//i.test(url)) throw new Error('Chỉ chấp nhận link https');
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r;
    } finally { clearTimeout(t); }
  }

  // File zip này đã cài nhưng dữ liệu đã bị xóa khỏi máy? (đoán thư mục đích từ TÊN FILE, giống lúc import)
  const present = (f) => {
    try { const c = classifyZipName(path.basename(f.path)); return c.error ? true : !!hasData(c); }
    catch { return true; }
  };

  // path trong manifest là đường dẫn tương đối so với vị trí manifest.json (có thể có dấu cách/tiếng Việt)
  const fileUrl = (rel) => new URL(rel.split('/').map(encodeURIComponent).join('/'), manifestUrl).href;

  async function readManifest() {
    const sep = manifestUrl.includes('?') ? '&' : '?';
    const m = await (await http(manifestUrl + sep + 't=' + Date.now())).json(); // t=... để tránh bị cache
    if (!m || !Array.isArray(m.files)) throw new Error('manifest không hợp lệ');
    return m.files.filter((f) => f && typeof f.path === 'string' && !f.path.includes('..')
      && /^[0-9a-f]{64}$/i.test(f.sha256 || '') && /\.zip$/i.test(f.path))
      .map((f) => ({ ...f, sha256: f.sha256.toLowerCase() }));
  }

  async function download(f, dest, onProgress) {
    const r = await http(fileUrl(f.path));
    const total = Number(r.headers.get('content-length')) || f.size || 0;
    if (total > MAX_FILE) throw new Error('File quá lớn');
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(dest);
    let got = 0;
    try {
      for await (const chunk of r.body) {
        got += chunk.length;
        if (got > MAX_FILE) throw new Error('File quá lớn');
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise((res) => out.once('drain', res));
        onProgress(got, total);
      }
    } catch (e) { out.destroy(); throw e; }
    await new Promise((res, rej) => out.end((err) => (err ? rej(err) : res())));
    return hash.digest('hex');
  }

  /**
   * mode: 'update' (mặc định) = chỉ cập nhật các file đã từng tải qua app
   *       'all'    = tải tất cả file trong manifest
   *       [paths]  = chỉ tải các file được chọn (dùng cho màn hình chọn vùng/ngôn ngữ)
   * auto: true = kiểm tra tự động (khi mở app / mỗi 24h): KHÔNG tải lại file mà người dùng đã xóa khỏi máy.
   *       Bấm "Kiểm tra cập nhật" thủ công thì file đã xóa sẽ được tải lại.
   */
  async function check({ mode = 'update', auto = false } = {}) {
    if (busy) return { busy: true };
    busy = true;
    const result = { checked: false, updated: [], failed: [], error: null };
    try {
      onEvent({ phase: 'checking' });
      const files = await readManifest();
      result.checked = true;
      const st = loadState();
      st.files = st.files || {};

      const todo = files.filter((f) => {
        const missing = (f.path in st.files) && !present(f);        // đã cài nhưng dữ liệu không còn trên máy
        if (missing && auto) return false;                          // tự động: tôn trọng việc người dùng đã xóa
        if (st.files[f.path] === f.sha256 && !missing) return false; // đã mới nhất
        if (mode === 'all') return true;
        if (Array.isArray(mode)) return mode.includes(f.path);
        return f.path in st.files;                                  // 'update': chỉ file đã cài
      });

      for (let i = 0; i < todo.length; i++) {
        const f = todo[i];
        const name = path.basename(f.path);
        const dir = path.join(tmpDir, String(i));
        fs.mkdirSync(dir, { recursive: true });
        const tmp = path.join(dir, name); // giữ NGUYÊN tên file vì importer phân loại theo tên
        let lastPct = -1;
        try {
          onEvent({ phase: 'downloading', name, index: i + 1, total: todo.length, percent: 0 });
          const got = await download(f, tmp, (b, t) => {
            const pct = t ? Math.round((b * 100) / t) : null;
            if (pct !== lastPct) { lastPct = pct; onEvent({ phase: 'downloading', name, index: i + 1, total: todo.length, percent: pct }); }
          });
          if (got !== f.sha256) throw new Error('Sai mã hash (file tải về bị lỗi hoặc manifest chưa cập nhật)');
          const r = importPaths([tmp]);
          const ok = r && !r.error && (r.zips.length + r.added.length + r.updated.length) > 0;
          if (!ok) throw new Error('Không nhận diện được tên file hoặc import thất bại');
          st.files[f.path] = got;
          saveState(st); // lưu ngay từng file, lỡ tắt app giữa chừng vẫn giữ tiến độ
          result.updated.push(name);
        } catch (e) {
          result.failed.push({ name, error: e.message });
        }
      }
      st.lastCheck = Date.now();
      saveState(st);
    } catch (e) {
      result.error = e.message; // thường là mất mạng: im lặng bỏ qua, lần sau thử lại
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      busy = false;
      onEvent({ phase: 'done', ...result });
    }
    return result;
  }

  // Danh sách file trong manifest + trạng thái (cho màn hình chọn file tải)
  async function list() {
    try {
      const files = await readManifest();
      const st = loadState().files || {};
      return {
        files: files.map((f) => ({
          path: f.path, name: path.basename(f.path), size: f.size || 0,
          installed: f.path in st && present(f), upToDate: st[f.path] === f.sha256 && present(f)
        }))
      };
    } catch (e) { return { error: e.message }; }
  }

  // Kiểm tra ngay khi mở app, rồi lặp lại mỗi 24h nếu app vẫn đang mở
  function start() {
    check({ auto: true }).catch(() => {});
    const t = setInterval(() => check({ auto: true }).catch(() => {}), 24 * 60 * 60 * 1000);
    if (t.unref) t.unref();
  }

  return { check, list, start };
}

module.exports = { createUpdater };
