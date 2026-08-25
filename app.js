/* ============================================================
   墨阅 · TXT 小说阅读器  —  主逻辑（存储 / 书架 / 导入 / 设置 / 账号）
   ============================================================ */
/* 全局运行时错误捕获：UC 等老旧内核遇到不支持的 API 会静默崩，这里把错误直接显示到屏幕，
   便于用户截图精确反馈根因，避免反复盲改。浮层定位用 left/right/bottom 长手（绝不用 inset，UC 不识别）。 */
window.addEventListener('error', function (e) {
  try {
    var d = document.getElementById('err-overlay');
    if (!d) {
      d = document.createElement('pre');
      d.id = 'err-overlay';
      d.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;background:rgba(150,0,0,.92);color:#fff;font:11px/1.4 monospace;padding:8px 10px;white-space:pre-wrap;max-height:42vh;overflow:auto';
      (document.body || document.documentElement).appendChild(d);
    }
    var msg = (e && e.message) ? e.message : String(e);
    if (e && e.filename) msg += '\n@' + e.filename + ':' + (e.lineno || '?');
    d.textContent = (d.textContent ? d.textContent + '\n' : '') + 'ERR: ' + msg;
  } catch (_) {}
});
window.addEventListener('unhandledrejection', function (e) {
  try {
    var d = document.getElementById('err-overlay');
    if (!d) {
      d = document.createElement('pre');
      d.id = 'err-overlay';
      d.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;background:rgba(150,0,0,.92);color:#fff;font:11px/1.4 monospace;padding:8px 10px;white-space:pre-wrap;max-height:42vh;overflow:auto';
      (document.body || document.documentElement).appendChild(d);
    }
    var reason = (e && e.reason) ? (e.reason.message || e.reason) : e;
    d.textContent = (d.textContent ? d.textContent + '\n' : '') + 'PROMISE ERR: ' + reason;
  } catch (_) {}
});
const App = {
  db: null,
  settings: null,
  account: null,
  currentBook: null,
  themes: [
    { id: 'cream',  name: '米黄', bg: '#F7F1E3', text: '#3a3a3a', sub: '#8a8275' },
    { id: 'gray',   name: '浅灰', bg: '#EEEEEE', text: '#333333', sub: '#888888' },
    { id: 'green',  name: '护眼', bg: '#D7E8D4', text: '#33443a', sub: '#6f8a72' },
    { id: 'blue',   name: '淡蓝', bg: '#E8EEF5', text: '#33414f', sub: '#7d8a99' },
    { id: 'kraft',  name: '牛皮', bg: '#D6BC92', text: '#5A3825', sub: '#8A6F4A' },
    { id: 'night',  name: '夜间', bg: '#2b2b30', text: '#b9b9b0', sub: '#7f7f78' }
  ],
  fonts: [
    { id: 'sys',  name: '系统',  css: '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif' },
    { id: 'song', name: '宋体',  css: '"Songti SC", "SimSun", serif' },
    { id: 'kai',  name: '楷体',  css: '"Kaiti SC", "KaiTi", serif' },
    { id: 'hei',  name: '黑体',  css: '"Heiti SC", "SimHei", sans-serif' },
    { id: 'mengmengdashouxieti',  name: '萌萌手写体',   css: '"mengmengdashouxieti", "Kaiti SC", cursive' },
    { id: 'xiaoxiangshoushu',    name: '潇湘书手',     css: '"xiaoxiangshoushu", "Kaiti SC", cursive' },
    { id: 'xiaopingguoshouxieti',name: '小苹果手写体', css: '"xiaopingguoshouxieti", "Kaiti SC", cursive' },
    { id: 'xiaoluolitashouxieti',name: '小萝莉他手写体',css: '"xiaoluolitashouxieti", "Kaiti SC", cursive' }
  ],
  covers: ['#b08968','#7d9b76','#6b8e9e','#a8758a','#c08a5e','#7a7d9b','#9e8a6b','#6e9b8f']
};

/* ---------- IndexedDB ---------- */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('novelReaderDB', 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('edits')) db.createObjectStore('edits', { keyPath: ['bookId', 'origStart'] });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('account')) db.createObjectStore('account', { keyPath: 'id' });
    };
    req.onsuccess = () => { App.db = req.result; resolve(App.db); };
    req.onerror = () => reject(req.error);
  });
}
function tx(store, mode) { return App.db.transaction(store, mode).objectStore(store); }
function idbGet(store, key) { return new Promise((res, rej) => { const r = tx(store,'readonly').get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
function idbGetAll(store) { return new Promise((res, rej) => { const r = tx(store,'readonly').getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
function idbPut(store, val) { return new Promise((res, rej) => { const r = tx(store,'readwrite').put(val); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
function idbDelete(store, key) { return new Promise((res, rej) => { const r = tx(store,'readwrite').delete(key); r.onsuccess = () => res(); r.onerror = () => rej(r.error); }); }

/* ---------- 工具 ---------- */
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(t._t); t._t = setTimeout(() => { t.hidden = true; }, 1600);
}
/* ---------- 视图切换 + 通用返回分层 ----------
   用 history 栈实现"阅读页 → 书架 → 退出网页"两段式返回：
   进入阅读页/设置页时 pushState，系统返回键/浏览器后退先回书架，再按一次才退出。
   初始用 replaceState 把书架设为栈底状态（保证从书架按返回能正常退出）。 */
let _navLock = false;
function showView(name, pushHistory) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const el = document.getElementById('view-' + name);
  if (el) el.classList.add('active');
  /* 进入阅读页：默认隐藏顶/底栏浮层（平时阅读态），点正文中央再切换显示 */
  if (name === 'reader') {
    el.classList.add('bars-hidden');
    el.classList.remove('bars-shown');
  }
  if (pushHistory && name !== 'bookshelf' && !_navLock) {
    history.pushState({ view: name }, '', '#' + name);
  }
}
/* 通用返回：优先走浏览器历史（与系统返回键一致），否则退回书架 */
function goBack() {
  if (history.length > 1) history.back();
  else showView('bookshelf', false);
}
window.addEventListener('popstate', () => {
  // 当前激活页若仍是阅读页/设置页，说明是从它们返回 → 落到书架（不退出）
  const active = document.querySelector('.view.active');
  const cur = active ? active.id.replace('view-', '') : 'bookshelf';
  if (cur === 'reader' || cur === 'settings') {
    _navLock = true;
    showView('bookshelf', false);
    _navLock = false;
    renderBookshelf();
  }
  // 若已在书架：popstate 不拦截，由浏览器继续后退/退出
});
function hashStr(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(16); }
function decodeText(buf) {
  // 先尝试 UTF-8（致命模式），失败回退 GBK（中文小说常见编码）
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch (e) { try { return new TextDecoder('gbk').decode(buf); } catch (e2) { return new TextDecoder('utf-8').decode(buf); } }
}

/* ---------- 章节自动识别（TXT 按章节拆分） ----------
   识别范围尽量放宽，覆盖常见网文/出版排版：
   1) 标准章：第X章/回/卷/节/部/篇/集/幕（中文数字或阿拉伯数字，X 前可加空格）
   2) 前缀符号：标题前可有 ★●◆▪·*、-、全角／半角括号【】()《》「」等包裹，如 ★第一章、*第3回*、【序章】
   3) 英文：Chapter N / CHAPTER N / Volume N
   4) 特殊篇名：序章/引子/楔子/后记/尾声/番外/外传/附录
   5) 单独成行的纯数字（如 1 / 123）：仅在「全书数字单独行占比高」时启用，避免把正文数字误判为章节
   返回章节数组（含 offset 字符偏移），供目录、进度、书架章数统计使用 */
const CHAPTER_RE = /^\s*(?:[★●◆▪·*\-–—=·•\s]*[\(\[【《「]|)*(?:第\s*[零一二三四五六七八九十百千两0-9]+\s*[章回卷节部篇集幕]|chapter\s+\d+|volume\s+\d+|序章|引子|楔子|后记|尾声|番外|外传|附录|第\d+章)(?:[\)\]】》」]|[★●◆▪·*\-–—=·•\s]*)*/i;

function detectChapters(text) {
  const lines = text.split('\n');
  const out = []; let pos = 0;
  // 第一遍：统计「单独成行纯数字行」占比，用于决定是否启用数字章节模式
  let nonEmpty = 0, numAlone = 0;
  for (const ln of lines) {
    const t = ln.replace(/\r$/, '').trim();
    if (!t) continue;
    nonEmpty++;
    if (/^\d{1,4}$/.test(t)) numAlone++;
  }
  const enableNumMode = nonEmpty > 8 && (numAlone / nonEmpty) >= 0.12;

  for (const ln of lines) {
    const t = ln.replace(/\r$/, '');
    const trimmed = t.trim();
    if (trimmed && trimmed.length <= 40 && CHAPTER_RE.test(t)) {
      out.push({ title: trimmed.slice(0, 30), offset: pos });
    } else if (enableNumMode && /^\d{1,4}$/.test(trimmed)) {
      out.push({ title: trimmed, offset: pos });
    }
    pos += t.length + 1;
  }
  return out;
}

/* ---------- 设置 ---------- */
function defaultSettings() {
  return { id: 'global', theme: 'cream', fontSize: 18, lineHeight: 1.8, font: 'sys', turn: 'flip' };
}
function applySettingsToCSS(s) {
  const root = document.documentElement.style;
  const theme = App.themes.find(t => t.id === s.theme) || App.themes[0];
  root.setProperty('--bg', theme.bg);
  root.setProperty('--text', theme.text);
  root.setProperty('--sub', theme.sub);
  root.setProperty('--font-size', s.fontSize + 'px');
  root.setProperty('--line-height', s.lineHeight);
  const font = App.fonts.find(f => f.id === s.font) || App.fonts[0];
  root.setProperty('--font-family', font.css);
  root.setProperty('--turn', s.turn === 'slide' ? 'slide' : 'none');
}
async function loadSettings() {
  let s = await idbGet('settings', 'global');
  if (!s) { s = defaultSettings(); await idbPut('settings', s); }
  App.settings = s; applySettingsToCSS(s);
}

/* ---------- 书架 ---------- */
async function renderBookshelf() {
  const books = await idbGetAll('books');
  books.sort((a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0));
  const list = document.getElementById('bookshelf-list');
  const empty = document.getElementById('bookshelf-empty');
  list.innerHTML = '';
  if (books.length === 0) { empty.style.display = 'flex'; return; }
  empty.style.display = 'none';
  books.forEach((b, i) => {
    const pct = b.totalLen ? Math.round((b.lastReadChar || 0) / b.totalLen * 100) : 0;
    const card = document.createElement('div');
    card.className = 'book-card';
    const color = App.covers[i % App.covers.length];
    card.innerHTML = `
      <div class="book-cover" style="background:${color}">${escapeHtml(b.title)}</div>
      <div class="book-meta">
        <p class="book-name">${escapeHtml(b.title)}</p>
        <div class="book-prog">${pct}% · ${b.lastReadAt ? '已读' : '未读'}${b.chapterCount ? ' · ' + b.chapterCount + '章' : ''}</div>
      </div>
      <div class="book-ops">
        <button class="book-op" data-act="rename" data-id="${b.id}">✎ 重命名</button>
        <button class="book-op book-op-del" data-act="del" data-id="${b.id}">🗑 删除</button>
      </div>`;
    card.querySelector('.book-cover').addEventListener('click', () => openBook(b.id));
    card.querySelector('.book-meta').addEventListener('click', () => openBook(b.id));
    card.querySelectorAll('.book-op').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        if (btn.dataset.act === 'del') {
          if (confirm('确定从书架删除《' + b.title + '》？纠错记录也会一并删除。')) {
            await idbDelete('books', id);
            const edits = await idbGetAll('edits');
            for (const ed of edits.filter(x => x.bookId === id)) await idbDelete('edits', [ed.bookId, ed.origStart]);
            renderBookshelf();
          }
        } else {
          openRename(id, b.title);
        }
      });
    });
    list.appendChild(card);
  });
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

/* ---------- 重命名书本 ---------- */
let _renameId = null;
function openRename(id, oldTitle) {
  _renameId = id;
  const input = document.getElementById('rename-input');
  input.value = oldTitle;
  document.getElementById('rename-modal').hidden = false;
  setTimeout(() => input.focus(), 50);
}
function closeRename() {
  document.getElementById('rename-modal').hidden = true;
  _renameId = null;
}
async function saveRename() {
  if (!_renameId) return;
  const input = document.getElementById('rename-input');
  const title = input.value.trim();
  if (!title) { showToast('书名不能为空'); return; }
  const book = await idbGet('books', _renameId);
  if (!book) { closeRename(); return; }
  book.title = title;
  book.updatedAt = Date.now();
  await idbPut('books', book);
  closeRename();
  renderBookshelf();
  showToast('已重命名为《' + title + '》');
}

async function openBook(id) {
  const book = await idbGet('books', id);
  if (!book) return;
  App.currentBook = book;
  showView('reader', true); // 进入阅读页压入 history，使系统返回先回书架
  Reader.open(book);
}

/* ---------- 导入 ---------- */
const MAX_TXT_SIZE = 50 * 1024 * 1024; // 50 MB

function validateTxtFile(file) {
  if (!file) return { ok: false, reason: '文件无效' };
  /* 文件夹兜底：尝试读取 1 字节失败 + size=0 → 真文件夹
     （旧版 Android 文件选择器对文件夹返回的 File 可能 size=0 且 type=''） */
  const size = file.size || 0;
  const name = (file.name || '').toLowerCase();
  const type = (file.type || '').toLowerCase();

  /* —— 多条件识别是否为 .txt ——
     旧 Android（Honor 9i 等 EMUI 文件选择器）常常返回：
       - name 不带扩展名（如 "新建文档" 而非 "新建文档.txt"）
       - type 为空或 application/octet-stream
     因此不能用单一条件硬卡。
  */
  const extOk = name.endsWith('.txt') || name.endsWith('.text');
  const mimeText = type.startsWith('text/') || type === 'application/octet-stream' || type === '';
  const mimeGuess = extOk || mimeText; /* 老 Android type='' 时靠扩展名或后续内容嗅探 */

  if (!mimeGuess) return { ok: false, reason: '仅支持 .txt 文本文件' };
  if (size === 0) return { ok: false, reason: '文件为空' };
  if (size > MAX_TXT_SIZE) return { ok: false, reason: '文件过大（超过 50MB）' };

  /* 标记：name 缺扩展名且 type 为空 → 老 Android 文件管理器，导入后再做内容嗅探 */
  const needSniff = !extOk && type === '';
  return { ok: true, needSniff };
}

async function handleImport(files) {
  const prog = document.getElementById('import-progress');
  prog.hidden = false;
  let imported = 0, skipped = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    prog.textContent = `正在导入 (${i + 1}/${files.length})：${file.name}`;
    /* —— 格式校验 —— */
    const check = validateTxtFile(file);
    if (!check.ok) {
      showToast(`跳过「${file.name}」：${check.reason}`);
      skipped++;
      continue;
    }
    try {
      const buf = await file.arrayBuffer();
      let text = decodeText(buf);
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // 去 BOM
      if (!text.trim()) { showToast(`跳过「${file.name}」：内容为空`); skipped++; continue; }

      /* 老 Android（Honor 9i 等）name 无扩展名 + type 空 → 内容嗅探兜底：
         若解码后前 4KB 内可打印字符比例过低，说明不是文本文件/是文件夹占位 → 拒掉 */
      if (check.needSniff) {
        const sample = text.slice(0, 4096);
        let printable = 0;
        for (let k = 0; k < sample.length; k++) {
          const c = sample.charCodeAt(k);
          // 允许可打印 ASCII、中文/日韩文（CJK 统一汉字+扩展A~F）、常见空白与换行
          if ((c >= 0x20 && c <= 0x7E) || c === 0x09 || c === 0x0A || c === 0x0D ||
              (c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3400 && c <= 0x4DBF) ||
              (c >= 0x20000 && c <= 0x2EBEF)) printable++;
        }
        const ratio = sample.length ? printable / sample.length : 0;
        if (ratio < 0.6) {
          showToast(`跳过「${file.name}」：不是有效的文本文件`);
          skipped++; continue;
        }
      }
      const id = 'b' + hashStr(file.name + '|' + text.length + '|' + text.slice(0, 300));
      const chapters = detectChapters(text);
      const book = {
        id, title: file.name.replace(/\.txt$/i, ''),
        content: text, totalLen: text.length,
        chapters, chapterCount: chapters.length,
        bookmarks: [],
        importedAt: Date.now(), lastReadAt: 0, lastReadChar: 0
      };
      await idbPut('books', book);
      imported++;
    } catch (e) { showToast('导入失败：' + file.name); skipped++; }
  }
  prog.hidden = true;
  renderBookshelf();
  if (imported && !skipped) showToast(`已导入 ${imported} 本书`);
  else if (imported && skipped) showToast(`已导入 ${imported} 本，跳过 ${skipped} 个`);
  else if (!imported && skipped) showToast(`未导入，${skipped} 个文件被跳过`);
}

/* ---------- 账号 ---------- */
async function loadAccount() { App.account = await idbGet('account', 'me'); renderAccount(); }
function renderAccount() {
  const area = document.getElementById('account-area');
  if (App.account) {
    area.innerHTML = `
      <div class="account-row">
        <div style="width:38px;height:38px;border-radius:50%;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:18px">${escapeHtml(App.account.email[0].toUpperCase())}</div>
        <div style="flex:1">
          <div>${escapeHtml(App.account.email)}</div>
          <div style="font-size:12px;color:var(--sub)">已登录（本地账号）</div>
        </div>
        <button class="wide-btn ghost" id="btn-logout" style="width:auto;margin:0;padding:6px 12px">退出</button>
      </div>`;
    document.getElementById('btn-logout').addEventListener('click', async () => {
      await idbDelete('account', 'me'); App.account = null; renderAccount(); showToast('已退出');
    });
  } else {
    area.innerHTML = `
      <div class="account-form">
        <input type="email" id="acc-email" placeholder="邮箱" />
        <input type="password" id="acc-pass" placeholder="密码" />
        <div class="row2">
          <button class="wide-btn primary" id="btn-login">登录 / 注册</button>
        </div>
        <p class="settings-note">本地账号用于标识设备数据；真实「跨设备云同步」需接入后端服务（见下方说明）。</p>
      </div>`;
    document.getElementById('btn-login').addEventListener('click', async () => {
      const email = document.getElementById('acc-email').value.trim();
      const pass = document.getElementById('acc-pass').value;
      if (!email || !pass) { showToast('请填写邮箱和密码'); return; }
      App.account = { id: 'me', email, passHash: hashStr(pass) };
      await idbPut('account', App.account);
      renderAccount(); showToast('登录成功');
    });
  }
}

/* ---------- 备份数据构造 / 恢复（导出、导入、云同步共用） ---------- */
async function buildBackupData() {
  const books = await idbGetAll('books');
  const edits = await idbGetAll('edits');
  return { books, edits, settings: App.settings };
}
async function restoreBackupData(d) {
  if (d.books) for (const b of d.books) await idbPut('books', b);
  if (d.edits) for (const e of d.edits) await idbPut('edits', e);
  if (d.settings) { App.settings = d.settings; await idbPut('settings', d.settings); applySettingsToCSS(d.settings); }
}

/* ---------- 本地备份导出 / 导入 ---------- */
async function exportBackup() {
  const data = await buildBackupData();
  data.type = 'moyue-backup'; data.version = 1; data.exportedAt = Date.now();
  data.account = App.account ? { email: App.account.email } : null;
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'moyue-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
  showToast('备份已导出');
}
async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.type !== 'moyue-backup') { showToast('不是有效的备份文件'); return; }
    await restoreBackupData(data);
    renderBookshelf(); renderAccount();
    showToast('备份已恢复');
  } catch (e) { showToast('恢复失败'); }
}

/* ---------- CloudBase 云同步 ---------- */
App.cb = { app: null, pass: '', connected: false };
function b64FromBytes(bytes) { let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }
function bytesFromB64(b64) { const s = atob(b64); const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function deriveKey(password, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encryptData(obj, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
  return { salt: b64FromBytes(salt), iv: b64FromBytes(iv), ct: b64FromBytes(new Uint8Array(ct)) };
}
async function decryptData(p, password) {
  const key = await deriveKey(password, bytesFromB64(p.salt));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytesFromB64(p.iv) }, key, bytesFromB64(p.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}
function setCbStatus(msg) { const el = document.getElementById('cb-status'); if (el) el.textContent = msg; }
function enableSyncButtons(on) { ['btn-cb-upload', 'btn-cb-download'].forEach(id => { const b = document.getElementById(id); if (b) b.disabled = !on; }); }
async function cbConnect() {
  const env = document.getElementById('cb-env').value.trim();
  const syncId = document.getElementById('cb-syncid').value.trim();
  const pass = document.getElementById('cb-pass').value;
  if (!env || !syncId || !pass) { setCbStatus('请填写环境ID、同步账号和密码'); return; }
  if (typeof tcb === 'undefined') { setCbStatus('CloudBase SDK 未加载'); return; }
  setCbStatus('连接中…');
  try {
    App.cb.app = tcb.init({ env });
    await App.cb.app.auth().signInAnonymously();
    App.cb.pass = pass; App.cb.connected = true;
    App.settings.cloudEnv = env; App.settings.cloudSyncId = syncId; await saveSettings();
    setCbStatus('已匿名登录，可以同步'); enableSyncButtons(true); showToast('连接成功');
  } catch (e) { App.cb.connected = false; setCbStatus('连接失败：' + (e && e.message ? e.message : e)); }
}
async function cbUpload() {
  if (!App.cb.connected) { setCbStatus('请先点「连接并匿名登录」'); return; }
  try {
    const data = await buildBackupData();
    const enc = await encryptData(data, App.cb.pass);
    const docId = await sha256Hex(App.settings.cloudSyncId);
    await App.cb.app.database().collection('moyue_sync').doc(docId).set(Object.assign({}, enc, { updatedAt: Date.now() }));
    setCbStatus('已上传到云端（' + new Date().toLocaleTimeString() + '）'); showToast('上传成功');
  } catch (e) { setCbStatus('上传失败：' + (e && e.message ? e.message : e)); }
}
async function cbDownload() {
  if (!App.cb.connected) { setCbStatus('请先点「连接并匿名登录」'); return; }
  try {
    const docId = await sha256Hex(App.settings.cloudSyncId);
    const res = await App.cb.app.database().collection('moyue_sync').doc(docId).get();
    const list = res.data; const doc = Array.isArray(list) ? list[0] : list;
    if (!doc) { setCbStatus('云端暂无该账号数据，请先上传'); return; }
    const plain = await decryptData(doc, App.cb.pass);
    await restoreBackupData(plain);
    renderBookshelf(); renderAccount(); buildSettingsUI();
    setCbStatus('已从云端恢复（' + new Date().toLocaleTimeString() + '）'); showToast('下载成功');
  } catch (e) { setCbStatus('下载失败：' + (e && e.message ? e.message : e)); }
}

/* ---------- 设置 UI 构建 ---------- */
function buildSettingsUI() {
  const s = App.settings;
  // 回填云同步配置 + 初始禁用同步按钮
  document.getElementById('cb-env').value = s.cloudEnv || '';
  document.getElementById('cb-syncid').value = s.cloudSyncId || '';
  enableSyncButtons(App.cb && App.cb.connected);
  if (!(App.cb && App.cb.connected)) setCbStatus('未连接');
  // 主题
  const tl = document.getElementById('theme-list');
  tl.innerHTML = '';
  App.themes.forEach(t => {
    const sw = document.createElement('div');
    sw.className = 'theme-swatch' + (t.id === s.theme ? ' active' : '');
    sw.style.background = t.bg; sw.dataset.id = t.id;
    sw.innerHTML = `<span>${t.name}</span>`;
    sw.addEventListener('click', () => { s.theme = t.id; saveSettings(); buildSettingsUI(); });
    tl.appendChild(sw);
  });
  // 字号 / 行距
  const fs = document.getElementById('set-font-size');
  fs.value = s.fontSize; document.getElementById('font-size-val').textContent = s.fontSize;
  fs.oninput = () => { document.getElementById('font-size-val').textContent = fs.value; s.fontSize = +fs.value; applySettingsToCSS(s); if (typeof Reader !== 'undefined') Reader.reloadSettings(); };
  fs.onchange = saveSettings;
  const lh = document.getElementById('set-line-height');
  lh.value = s.lineHeight; document.getElementById('line-height-val').textContent = s.lineHeight;
  lh.oninput = () => { document.getElementById('line-height-val').textContent = (+lh.value).toFixed(1); s.lineHeight = +lh.value; applySettingsToCSS(s); if (typeof Reader !== 'undefined') Reader.reloadSettings(); };
  lh.onchange = saveSettings;
  // 字体
  const fl = document.getElementById('font-family-list');
  fl.innerHTML = '';
  App.fonts.forEach(f => {
    const o = document.createElement('div');
    o.className = 'font-opt' + (f.id === s.font ? ' active' : '');
    o.textContent = f.name; o.style.fontFamily = f.css;
    o.addEventListener('click', () => { s.font = f.id; saveSettings(); buildSettingsUI(); });
    fl.appendChild(o);
  });
  // 翻页
  const tm = document.getElementById('turn-mode-list');
  tm.innerHTML = '';
  [['flip', '仿真翻页'], ['slide', '平移'], ['none', '无动画']].forEach(([id, name]) => {
    const o = document.createElement('div');
    o.className = 'seg-opt' + (s.turn === id ? ' active' : '');
    o.textContent = name;
    o.addEventListener('click', () => { s.turn = id; applySettingsToCSS(s); saveSettings(); buildSettingsUI(); });
    tm.appendChild(o);
  });
  document.getElementById('sync-note').textContent =
    '当前为「本地优先」存储：书籍、阅读进度、纠错记录都保存在本机。' +
    (App.account ? '已登录本地账号 ' + App.account.email + '。' : '') +
    '要实现真正的「换手机/多设备账号云同步」，需要接入后端数据库（如腾讯云 CloudBase）。可先用电脑备份导出/导入在设备间迁移数据；如需云同步，告诉我，我帮你接入 CloudBase。';
}
async function saveSettings() { await idbPut('settings', App.settings); }

/* ---------- 事件绑定 ---------- */
function bindEvents() {
  const fileInput = document.getElementById('file-input');
  fileInput.addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length) handleImport(files);
    e.target.value = '';
  });
  document.getElementById('btn-import-fab').addEventListener('click', () => fileInput.click());

  // 拖拽导入（桌面端）
  const shelf = document.getElementById('view-bookshelf');
  shelf.addEventListener('dragover', (e) => { e.preventDefault(); shelf.classList.add('drag-over'); });
  shelf.addEventListener('dragleave', () => shelf.classList.remove('drag-over'));
  shelf.addEventListener('drop', (e) => {
    e.preventDefault();
    shelf.classList.remove('drag-over');
    if (e.dataTransfer.files.length) handleImport(e.dataTransfer.files);
  });
  document.getElementById('btn-open-settings').addEventListener('click', () => { buildSettingsUI(); showView('settings', true); });
  document.getElementById('btn-settings-back').addEventListener('click', () => goBack());

  document.getElementById('btn-export').addEventListener('click', exportBackup);
  document.getElementById('btn-export-corrected').addEventListener('click', () => { if (Reader && Reader.exportCorrected) Reader.exportCorrected(); });
  document.getElementById('btn-export-corrected-bottom').addEventListener('click', () => { if (Reader && Reader.exportCorrected) Reader.exportCorrected(); });
  document.getElementById('btn-import-backup').addEventListener('click', () => document.getElementById('backup-input').click());
  document.getElementById('backup-input').addEventListener('change', (e) => {
    if (e.target.files[0]) importBackup(e.target.files[0]); e.target.value = '';
  });

  // CloudBase 云同步
  document.getElementById('btn-cb-connect').addEventListener('click', cbConnect);
  document.getElementById('btn-cb-upload').addEventListener('click', cbUpload);
  document.getElementById('btn-cb-download').addEventListener('click', cbDownload);

  // 阅读页控制：返回键走浏览器历史（与系统返回键行为一致，先回书架）
  document.getElementById('btn-reader-back').addEventListener('click', () => goBack());
  // 纠错：进入/退出段落弹窗编辑模式
  document.getElementById('btn-edit-mode').addEventListener('click', () => Reader.toggleEditMode());
  document.getElementById('btn-font').addEventListener('click', () => { buildFontPop(); togglePop('font-pop'); });

  // 重命名弹窗
  document.getElementById('rename-save').addEventListener('click', saveRename);
  document.getElementById('rename-cancel').addEventListener('click', closeRename);
  document.getElementById('rename-cancel2').addEventListener('click', closeRename);
  document.getElementById('rename-mask').addEventListener('click', closeRename);
  document.getElementById('rename-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveRename();
    else if (e.key === 'Escape') closeRename();
  });

  // 字体快捷面板
  const pfs = document.getElementById('pop-font-size');
  pfs.value = App.settings.fontSize;
  pfs.oninput = () => { App.settings.fontSize = +pfs.value; applySettingsToCSS(App.settings); document.getElementById('set-font-size').value = pfs.value; document.getElementById('font-size-val').textContent = pfs.value; if (typeof Reader !== 'undefined') Reader.reloadSettings(); };
  pfs.onchange = saveSettings;
  const plh = document.getElementById('pop-line-height');
  plh.value = App.settings.lineHeight;
  plh.oninput = () => { App.settings.lineHeight = +plh.value; applySettingsToCSS(App.settings); document.getElementById('set-line-height').value = plh.value; document.getElementById('line-height-val').textContent = (+plh.value).toFixed(1); if (typeof Reader !== 'undefined') Reader.reloadSettings(); };
  plh.onchange = saveSettings;

  // 纠错弹窗（段落编辑）
  document.getElementById('btn-edit-save').addEventListener('click', () => Reader.saveEdit());
  document.getElementById('btn-edit-cancel').addEventListener('click', () => Reader.closeEdit());
  document.getElementById('btn-edit-close').addEventListener('click', () => Reader.closeEdit());
  document.getElementById('edit-mask').addEventListener('click', () => Reader.closeEdit());

  // 查找 / 替换
  const frFindInput = document.getElementById('fr-find');
  const frReplInput = document.getElementById('fr-repl');
  const frStatus = document.getElementById('fr-status');
  document.getElementById('btn-find-replace').addEventListener('click', () => Reader.openFindReplace());
  document.getElementById('fr-close').addEventListener('click', () => Reader.closeFindReplace());
  document.getElementById('fr-mask').addEventListener('click', () => Reader.closeFindReplace());
  document.getElementById('fr-find-btn').addEventListener('click', () => {
    const t = frFindInput.value;
    if (!t) { frStatus.textContent = '请输入查找内容'; return; }
    const r = Reader.frSearch(t);
    if (r.total === 0) {
      frStatus.textContent = '未找到「' + t + '」';
      return;
    }
    frStatus.textContent = '找到 ' + r.total + ' 处（共 ' + r.paras.length + ' 段）';
    Reader.frGotoNext(); // 跳到第一处
  });
  document.getElementById('fr-next').addEventListener('click', () => {
    const t = frFindInput.value;
    if (!t) { frStatus.textContent = '请先输入并查找'; return; }
    if (!Reader.frHasMatches()) { frStatus.textContent = '请先点「查找」'; return; }
    const ok = Reader.frGotoNext();
    frStatus.textContent = ok ? '已跳到下一处' : '没有匹配项';
  });
  document.getElementById('fr-replace-all').addEventListener('click', async () => {
    const t = frFindInput.value;
    if (!t) { frStatus.textContent = '请输入查找内容'; return; }
    const repl = frReplInput.value;
    const r = await Reader.frReplaceAll(t, repl);
    if (r.changedParas === 0) {
      frStatus.textContent = '未找到可替换的内容';
      return;
    }
    frStatus.textContent = '已替换 ' + r.totalReplaced + ' 处（涉及 ' + r.changedParas + ' 段）';
    showToast('替换完成');
  });
}

function togglePop(id) {
  const el = document.getElementById(id);
  const willShow = el.hidden;
  document.querySelectorAll('.pop-panel').forEach(p => p.hidden = true);
  el.hidden = !willShow;
}
function buildFontPop() {
  const list = document.getElementById('font-pop-theme');
  if (!list) return;
  list.innerHTML = '';
  App.themes.forEach(t => {
    const sw = document.createElement('div');
    sw.className = 'theme-swatch' + (t.id === App.settings.theme ? ' active' : '');
    sw.style.background = t.bg; sw.dataset.id = t.id;
    sw.innerHTML = `<span>${t.name}</span>`;
    sw.addEventListener('click', () => {
      App.settings.theme = t.id; applySettingsToCSS(App.settings); saveSettings(); buildFontPop();
    });
    list.appendChild(sw);
  });
}

/* ---------- 启动 ---------- */
async function boot() {
  await openDB();
  await loadSettings();
  await loadAccount();
  await renderBookshelf();
  bindEvents();
  // 把书架设为 history 栈底，保证从书架按系统返回可正常退出网页
  history.replaceState({ view: 'bookshelf' }, '', location.pathname + location.search);
  showView('bookshelf', false);
}
boot();
