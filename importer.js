// importer.js — đọc file .zip (không cần thư viện ngoài) và phân loại theo tên: vùng / ngôn ngữ / loại
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SPECIAL_ID = 'TeleportOculi';

// ---- Bảng nhận diện. Khi thêm vùng mới vào REGIONS trong index.html, nhớ thêm vào đây ----
// Giá trị là các cách viết (đã bỏ dấu, chữ thường, bỏ khoảng trắng và ký tự đặc biệt)
const REGION_ALIASES = {
  Mondstadt: ['mondstadt'],
  Dragonspine: ['dragonspine'],
  Liyue: ['liyue'],
  Inazuma: ['inazuma'],
  Sumeru: ['sumeru'],
  Fontaine: ['fontaine'],
  Natlan: ['natlan'],
  NodKrai: ['nodkrai'],
  Snezhnaya: ['snezhnaya'],
  Enkanomiya: ['enkanomiya'],
  Chasm: ['chasm', 'vucdasau', 'khumongam'],
  SeaOfBygoneEras: ['seaofbygoneeras', 'bienkynguyencu'],
  AncientSacredMountain: ['ancientsacredmountain', 'nuithanhvienco'],
  TempleOfSpace: ['templeofspace', 'thandienkhonggian'],
  FrostMoon: ['frostmoon', 'suongnguyet']
};

const LANG_PATTERNS = [
  ['vi', /\b(vietnamese|tieng viet|vn|vi)\b/],
  ['en', /\b(english|tieng anh|en)\b/],
  ['ru', /\b(russian|tieng nga|ru)\b/],
  ['pt', /\b(portuguese|tieng bo dao nha|pt)\b/]
];

// Bỏ dấu tiếng Việt, về chữ thường
const fold = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase();

/**
 * Phân loại theo tên file zip.
 * Trả về { special:'tele'|'oculi' } | { region, lang, kind:'tong'|'le'|'cu' } | { error:'ambiguous'|'region'|'lang' }
 *  - "Unsplit Ver." -> tong (file tổng)   - "Split Ver." -> le (file chia lẻ)   - không ghi gì -> cu (file cũ)
 */
function classifyZipName(zipName) {
  const base = path.basename(String(zipName)).replace(/\.zip$/i, '');
  const f = fold(base);

  // Mục "Điểm tele / thần đồng của mọi vùng"
  const isOculi = /oculus|oculi|than dong/.test(f);
  const isTele = /teleport|\btele\b|diem tele/.test(f);
  if (isOculi && isTele) return { error: 'ambiguous' };
  if (isOculi) return { special: 'oculi' };
  if (isTele) return { special: 'tele' };

  // Vùng đất: chọn vùng có cách viết khớp; nếu khớp nhiều vùng khác nhau thì từ chối
  const compact = f.replace(/[^a-z0-9]/g, '');
  const hit = Object.keys(REGION_ALIASES).filter((id) => REGION_ALIASES[id].some((a) => compact.includes(a)));
  if (hit.length !== 1) return { error: 'region' };

  const langs = LANG_PATTERNS.filter(([, re]) => re.test(f)).map(([l]) => l);
  if (langs.length !== 1) return { error: 'lang' };

  const kind = /unsplit/.test(f) ? 'tong' : /split/.test(f) ? 'le' : 'cu';
  return { region: hit[0], lang: langs[0], kind };
}

// ---- Đọc zip (chỉ hỗ trợ kiểu nén Stored và Deflate, không hỗ trợ zip64/mã hóa) ----
const MAX_ZIP = 300 * 1024 * 1024;
const MAX_ENTRIES = 5000;

function decodeName(buf, flags) {
  if (flags & 0x800) return buf.toString('utf8');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { return buf.toString('latin1'); }
}

/** Trả về danh sách [{ name, isDir, read(maxBytes) }]; ném lỗi có .code nếu zip hỏng/không hỗ trợ */
function readZip(file) {
  const fail = (code, msg) => Object.assign(new Error(msg || code), { code });
  const st = fs.statSync(file);
  if (st.size > MAX_ZIP) throw fail('toobig');
  const buf = fs.readFileSync(file);

  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw fail('bad', 'Không phải file zip hợp lệ');

  const total = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdOffset === 0xffffffff) throw fail('zip64', 'Zip64 chưa được hỗ trợ');
  if (total > MAX_ENTRIES) throw fail('toobig');

  const entries = [];
  let pos = cdOffset;
  for (let n = 0; n < total; n++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) throw fail('bad');
    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOff = buf.readUInt32LE(pos + 42);
    const name = decodeName(buf.subarray(pos + 46, pos + 46 + nameLen), flags).replace(/\\/g, '/');
    pos += 46 + nameLen + extraLen + commentLen;

    entries.push({
      name,
      isDir: name.endsWith('/'),
      read(maxBytes) {
        if (flags & 1) throw fail('encrypted', 'File zip có mật khẩu');
        if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) throw fail('bad');
        const start = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
        const raw = buf.subarray(start, start + compSize);
        if (method === 0) {
          if (raw.length > maxBytes) throw fail('toobig');
          return raw;
        }
        if (method === 8) {
          try { return zlib.inflateRawSync(raw, { maxOutputLength: maxBytes }); }
          catch (e) { throw fail(/maxOutputLength|larger than/i.test(e.message) ? 'toobig' : 'bad', e.message); }
        }
        throw fail('method', 'Kiểu nén chưa được hỗ trợ');
      }
    });
  }
  return entries;
}

// README đi kèm zip: README, README.txt, README.md (mục chính thức giữ lại để người dùng đọc)
const README_RE = /^readme(\.(txt|md))?$/i;
const README_MAX = 256 * 1024;
const JSON_MAX = 20 * 1024 * 1024;
const TOTAL_MAX = 300 * 1024 * 1024;
const ANY_MAX = 100 * 1024 * 1024; // mục không chính thức: giới hạn mỗi file bất kỳ

const safeName = (s) => s.replace(/[<>:"|?*\x00-\x1f]/g, '_').trim();

/**
 * Giải nén zip và gom file cần dùng: chỉ lấy .json (mục chính thức); bỏ qua mọi thứ khác (thư mục...). README được giữ riêng.
 * Tên file được "làm phẳng" (chỉ lấy tên cuối), nên không thể ghi ra ngoài thư mục đích (zip-slip).
 * Nếu 2 file trong zip trùng tên (khác thư mục) thì thêm tên thư mục vào trước để không bị mất.
 * Trả về { jsons:[{name,data}], skipped:n, readme }
 */
// opts.all = true (mục không chính thức): KHÔNG lọc đuôi file, KHÔNG kiểm tra JSON
function extractZip(file, genericNames = [], opts = {}) {
  const entries = readZip(file).filter((e) => !e.isDir && !/(^|\/)(__MACOSX|\.DS_Store)(\/|$)/.test(e.name));
  const generic = new Set(['waypoints.json', ...genericNames.map((n) => String(n).toLowerCase())]);
  const dirOf = (e) => path.posix.dirname(e.name);

  // Bản chia lẻ: mỗi thư mục con ("1. Rương", "2. Rương Đánh Quái"...) chỉ chứa 1 file waypoint tên chung.
  // Nếu có từ 2 thư mục như vậy trở lên thì lấy TÊN THƯ MỤC làm tên file ("1. Rương.json").
  const jsonsByDir = new Map();
  for (const e of entries) {
    if (path.posix.extname(e.name).toLowerCase() !== '.json') continue;
    const d = dirOf(e);
    jsonsByDir.set(d, (jsonsByDir.get(d) || []).concat(e));
  }
  const folderNamed = new Set();
  for (const [d, list] of jsonsByDir) {
    if (d !== '.' && list.length === 1 && generic.has(path.posix.basename(list[0].name).toLowerCase())) folderNamed.add(d);
  }
  if (folderNamed.size < 2) folderNamed.clear();

  const wanted = (e) => (folderNamed.has(dirOf(e)) ? path.posix.basename(dirOf(e)) + '.json' : path.posix.basename(e.name));
  const counts = new Map();
  for (const e of entries) {
    const key = wanted(e).toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const out = { jsons: [], skipped: 0, readme: null };
  // Mục chính thức: giữ lại 1 file README (ưu tiên cái nằm ở thư mục nông nhất) để hiện nút "README" cạnh nút Dùng
  if (!opts.all) {
    const cand = entries.filter((e) => README_RE.test(path.posix.basename(e.name)))
      .sort((a, b) => a.name.split('/').length - b.name.split('/').length || a.name.localeCompare(b.name));
    if (cand.length) {
      try {
        const ext = path.posix.extname(cand[0].name).toLowerCase() || '.txt';
        out.readme = { name: 'README' + ext, data: cand[0].read(README_MAX) };
      } catch {}
    }
  }
  const used = new Set();
  let budget = TOTAL_MAX;
  for (const e of entries) {
    const base = path.posix.basename(e.name);
    const ext = path.posix.extname(base).toLowerCase();
    const isJson = ext === '.json';
    if (!opts.all && !isJson) { out.skipped++; continue; }

    let name = wanted(e);
    if (counts.get(name.toLowerCase()) > 1) {
      // Trùng tên: thêm đường dẫn thư mục vào để không bị mất file
      const dir = dirOf(e);
      name = folderNamed.has(dir) ? dir.split('/').join('_') + '.json' : (dir === '.' ? '' : dir.split('/').join('_') + '_') + name;
    }
    name = safeName(name);
    if (!name || used.has(name.toLowerCase())) { out.skipped++; continue; }
    used.add(name.toLowerCase());

    const data = e.read(Math.min(opts.all ? ANY_MAX : JSON_MAX, budget));
    budget -= data.length;
    if (isJson && !opts.all) {
      try { JSON.parse(data.toString('utf8').replace(/^\uFEFF/, '')); } catch { out.skipped++; continue; }
    }
    out.jsons.push({ name, data }); // với opts.all, "jsons" chứa mọi loại file
  }
  return out;
}

module.exports = { SPECIAL_ID, REGION_ALIASES, README_RE, classifyZipName, readZip, extractZip };
