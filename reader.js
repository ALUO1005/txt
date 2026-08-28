/* ============================================================
   墨阅 · 阅读页逻辑（分页 / 翻页动画 / 进度 / 目录 / 书签 / 跳转 / 段落纠错）
   版本：chrome13（长按正文进入段落纠错；保存/取消后自动退出；用 elementFromPoint 取真实段落修复"选错段"）
   ============================================================ */
const Reader = (function () {
  let book = null;
  let origParas = [];     // {origStart, origEnd, text}
  let correctedParas = []; // 应用纠错后的段落文本（纠错数据仍在，但无编辑 UI）
  let pages = [];         // 每页是 display-item 数组
  let index = 0;          // 当前页索引
  let frontEl = null, backEl = null; // 双页层
  let animating = false;
  let editMode = false;
  let editingPara = -1;  /* 当前正在编辑的段落索引（origParas 下标） */
  const viewport = () => document.getElementById('reader-viewport');
  const isTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
  // 滑动方向：true = 向右滑翻到下一页（与右侧点击一致，单手更顺）；
  // 改为 false 即翻书式：向右滑翻到上一页。一键切换。
  const SWIPE_RIGHT_IS_NEXT = false;
  const DUR = 360;
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const clamp = p => Math.max(0, Math.min(pages.length - 1, p));

  /* ---------- 视口尺寸（chrome11：缩 body 物理让位 + JS vpH 同步减） ----------
     chrome9 的 padding-bottom:100px 让位法实测不够：lineHeight 会把最后一行的字底顶到
     vpH-100+lineH ≈ vpH-72，已经在 UC 底部工具栏（≈80px）里——文字被切。
     chrome10 试 `html.uc body { bottom: 110px }` 后代选择器——UA 截图证实 UC 没识别（文字仍被切）。
     chrome11 多重保险让位：
     1) CSS：`body.uc { bottom: 150px !important }`（类名加在 body 本身，不用 html.uc，更稳）；
     2) JS：applyUCLayout 直接 `document.body.style.setProperty('bottom', '150px', 'important')`，
            内联 !important 优先级最高，UC 想忽略也忽略不掉；
     3) 动态检测：优先用 window.visualViewport.height 减 innerHeight 算真实 navbar 高度，
        如果 visualViewport 在 UC 上不灵（返回等于 innerHeight），自动用 150 兜底；
     4) UC_BODY_RESERVE 与 CSS 严格 1:1，paginate 时 vpH 也减同样值，杜绝"CSS/JS 高度不一致"
        复发的 chrome5/6 老问题。 */
  let UC_BODY_RESERVE = 150;  /* chrome11: 从 110 升到 150 兜底（UC navbar 实测 100-130px） */
  function getUCReserveHeight() {
    /* 优先用 visualViewport 算真实 navbar 高度（更精准）。
       如果 visualViewport 在 UC 上失灵（返回 ≈ innerHeight），就用兜底值 150。 */
    if (window.visualViewport && window.visualViewport.height > 0) {
      const vvH = window.visualViewport.height;
      const winH = window.innerHeight || vvH;
      if (vvH < winH - 20 && vvH > 100) {
        return Math.round(winH - vvH);  /* visualViewport 真的小于 innerHeight 时，差额 ≈ navbar */
      }
    }
    return UC_BODY_RESERVE;  /* visualViewport 失灵时用兜底 */
  }
  function getStageInnerSize() {
    let vvH = window.visualViewport ? window.visualViewport.height : 0;
    let innerH = window.innerHeight || 0;
    const isUC = /UCBrowser|UCWEB|UcWeb/i.test(navigator.userAgent);
    const isWX = /MicroMessenger/i.test(navigator.userAgent);

    /* UC 让位常量——chrome11: 使用全局 UC_BODY_RESERVE（applyUCLayout 已根据 visualViewport 动态更新），
       兜底 150（已被 css body.uc { bottom: 150px !important } 同步）。 */
    const UC_RESERVE = isUC ? UC_BODY_RESERVE : 0;

    /* 标准浏览器优先 vvH；UC 上视觉视口常失真（visualViewport 等于 innerHeight 含 navbar），
       直接用 innerHeight 后再减去 UC_RESERVE（与 CSS body.uc bottom 严格 1:1） */
    let vpH = 0;
    if (!isUC && vvH >= 100 && vvH < 5000) vpH = vvH;
    else if (innerH >= 100 && innerH < 5000) vpH = innerH;
    else if (document.documentElement && document.documentElement.clientHeight >= 100) vpH = document.documentElement.clientHeight;
    else vpH = 640;
    if (vpH < 200) vpH = 640;
    if (isUC) vpH = Math.max(200, vpH - UC_RESERVE);

    /* 宽度多级 fallback（uc 旧内核 clientWidth 可能返回失真值） */
    let winW = 0;
    const vp = viewport();
    if (vp && vp.clientWidth && vp.clientWidth >= 50) winW = vp.clientWidth;
    if ((!winW || winW < 50) && window.innerWidth && window.innerWidth >= 50) winW = window.innerWidth;
    if ((!winW || winW < 50) && document.documentElement && document.documentElement.clientWidth && document.documentElement.clientWidth >= 50)
      winW = document.documentElement.clientWidth;
    if (!winW || winW < 50) winW = 360;

    /* fp-content padding 顶/底各 8（chrome10：UC 让位改靠缩 body，padding 不再当让位） */
    const PAD_TOP = 8, PAD_BOT = 8, PAD_X = 28;
    return {
      vw: Math.max(160, winW - PAD_X),
      vh: Math.max(120, vpH - PAD_TOP - PAD_BOT),
      vpH,
      winW,
      rawInnerH: innerH,
      rawVvH: vvH,
      ua: isUC ? 'uc' : (isWX ? 'wx' : 'std')
    };
  }

  /* UC class 注入 + 内联样式兜底（chrome11 三重保险）：
     1) class 加在 body 本身（不用 documentElement）——避开 chrome10 失败的
        `html.uc body` 后代选择器不被 UC 识别的坑；
     2) 内联 `body.style.bottom = Xpx` + setProperty('important') —— 这是 DOM 上的
        inline !important，优先级最高，CSS 选择器怎么失效都不会影响；
     3) 用 visualViewport 动态算真实 navbar 高度（如果可用），否则用兜底值 150。
     这是 chrome10 失败后的"最后一根稻草"——之前 CSS 路径全部失效，
     JS 内联样式 + !important 是 UC 唯一不可能忽略的通道。 */
  function applyUCLayout() {
    const isUC = /UCBrowser|UCWEB|UcWeb/i.test(navigator.userAgent);
    if (!isUC) return;
    /* 1) 加 class 到 body（不是 documentElement）——选择器更短、更可能被 UC 解析 */
    if (!document.body.classList.contains('uc')) {
      document.body.classList.add('uc');
    }
    /* 2) 同步更新全局 reserve（让 paginate 用同一数字） */
    const reserve = getUCReserveHeight();
    UC_BODY_RESERVE = reserve;
    /* 3) 内联样式 + !important（最后兜底，前面 CSS 选择器都失败也能生效） */
    try {
      const bs = document.body.style;
      bs.setProperty('top', '0', 'important');
      bs.setProperty('right', '0', 'important');
      bs.setProperty('bottom', reserve + 'px', 'important');
      bs.setProperty('left', '0', 'important');
    } catch (e) { /* setProperty 在 UC 上应该没问题，try/catch 防御性兜底 */ }
  }

  /* ---------- 纠错数据应用（仅用于保留已保存的纠错结果，无编辑 UI） ---------- */
  async function buildCorrected() {
    const edits = (await idbGetAll('edits')).filter(e => e.bookId === book.id);
    const map = {};
    edits.forEach(e => { map[e.origStart] = e; });
    correctedParas = origParas.map(p => {
      const ed = map[p.origStart];
      return ed ? ed.text : p.text;
    });
  }

  /* ---------- 分页（累加法：每段精确按 lines*lineH + 段间距累计，超可用高开新页） ----------
     核心思想：
     - charsPerLine = floor(innerW / (fontSize * 0.95)) - 1
       0.95 系数贴近 system 字体的汉字等宽（1em）；手写体偏宽时偏保守（不会高估每行字数）。
     - 不用 floor(availH / lineH) - 1 这种粗估，改用**逐项累加**：
       itemH = lines × lineH；段交界处 + 0.5em 段间距（与 CSS margin: 0 0 0.5em 对齐）
       curH + segGap + itemH > usableH → 开新页
     - usableH = availH - lineH*0.5（半行 buffer 吸收渲染/安全区/字宽估算误差）
     决绝不会再出现「末行被 overflow:hidden 裁切」的根因：每页累加高度严格 ≤ usableH ≤ fp-content 实际高。 */
  /* 不能出现在行首的字符 */
  const NO_START_SET = new Set('！？。，、；：）】》〉」』”’…—～·％‰°℃!?),.:;)]}%'.split(''));
  /* 不能出现在行尾的字符 */
  const NO_END_SET = new Set('（【《〈「『“‘·—([{'.split(''));
  let _consts = null;
  function measureConsts() {
    const fontSize = App.settings.fontSize;
    const lh = App.settings.lineHeight || 1.8;
    return { lineH: fontSize * lh, fontSize, lineHeight: lh };
  }
  /* 把一个段落切成"每块一行"，按纯字符数估算，禁则只做行末回退（不可拆字） */
  function chunkParagraph(text, paraIndex, charsPerLine, indentChars, out) {
    const n = text.length;
    let s = 0, firstLine = true;
    while (s < n) {
      let budget = firstLine ? Math.max(2, charsPerLine - indentChars) : charsPerLine;
      let e = Math.min(n, s + Math.floor(budget));
      if (e > s + 1) {
        /* 禁则②：本块末字符不能排行尾（NO_END 字符） → 推回上一字 */
        while (e > s + 1 && NO_END_SET.has(text[e - 1])) e--;
        /* 禁则①：下一字符不能排行首（NO_START 字符）→ 把该字符一并塞入本行 */
        let g1 = 0;
        while (e < n && NO_START_SET.has(text[e]) && g1 < 2) { e++; g1++; }
      }
      out.push({
        paraIndex, start: s, end: e, text: text.slice(s, e),
        isFirst: firstLine, depth: 0
      });
      s = e;
      firstLine = false;
    }
  }
  /* 让出一帧 */
  function yieldFrame() {
    return new Promise(res => {
      if (typeof MessageChannel !== 'undefined') {
        const ch = new MessageChannel();
        ch.port1.onmessage = () => res();
        ch.port2.postMessage(0);
      } else {
        setTimeout(res, 0);
      }
    });
  }
  async function paginate() {
    const c = _consts = measureConsts();
    const fontSize = c.fontSize;
    const lineH = c.lineH;
    const lhNum = c.lineHeight;

    const stage = getStageInnerSize();
    const innerW = stage.vw;
    const availH = stage.vh;

    /* 字符宽度：汉字等宽 1em，0.95 系数稍微保守一点（手写体偏宽时不会高估每行字数）。
       -1 给中文标点挤压点空间，留 1 字 buffer。 */
    const charW = fontSize * 0.95;
    const charsPerLine = Math.max(12, Math.floor(innerW / charW) - 1);

    /* 段间距高度：CSS .fp-content p { margin: 0 0 0.5em } → 0.5em = fontSize * 0.5 px */
    const segGapH = fontSize * 0.5;

    /* 留半行 buffer 吸收渲染误差（安全区/字宽偏差/fp-content padding 等）。*/
    const bufferH = lineH * 0.5;
    const usableH = Math.max(lineH * 4, availH - bufferH);

    const indentChars = 2;

    /* ---- 1) 按字符数切行 ---- */
    const expanded = [];
    const CHUNK = 80;
    for (let i = 0; i < correctedParas.length; i++) {
      const text = correctedParas[i];
      if (!text || !text.length) { expanded.push({ paraIndex: i, start: 0, end: 0, blank: true, depth: 0, isFirst: true }); }
      else { chunkParagraph(text, i, charsPerLine, indentChars, expanded); }
      if ((i & (CHUNK - 1)) === (CHUNK - 1)) await yieldFrame();
    }

    /* ---- 2) 累加分页（精确按行高+段间距逐项累计，超可用高开新页） ---- */
    pages = []; let cur = []; let curH = 0; let prevPara = -1;
    for (const it of expanded) {
      let itemH;
      if (it.blank) {
        itemH = lineH; /* 空段占 1 行 */
      } else {
        const rem = it.end - it.start;
        const lines = Math.max(1, Math.ceil(rem / charsPerLine));
        itemH = lines * lineH;
      }
      const segGap = (cur.length && prevPara !== it.paraIndex) ? segGapH : 0;

      if (cur.length && curH + segGap + itemH > usableH) {
        pages.push(cur);
        cur = [it];
        curH = itemH;
        prevPara = it.paraIndex;
      } else {
        cur.push(it);
        curH += segGap + itemH;
        prevPara = it.paraIndex;
      }
    }
    if (cur.length) pages.push(cur);
    if (pages.length === 0) pages.push([]);

    _consts = c;
  }

  /* ---------- 渲染到某一页层 ----------
     阅读态：同一段落的行块合并成一个 <p>（段内行距 = lineH，段间 0.9em 与分页 gapLines 一致）；
     跨页续段渲染为新 <p> 且 text-indent:0（续行不缩进）。 */
  function renderPageInto(el, idx) {
    const content = el.querySelector('.fp-content');
    const page = pages[idx];
    if (!page || !page.length) { content.innerHTML = '<p style="text-indent:0;opacity:.4">（本页无内容）</p>'; el._idx = idx; return; }
    const lineH = _consts ? _consts.lineH : 18; /* 空段高度与分页行高一致 */
    let html = '';
    let run = null; /* { paraIndex, start, end, blank } */
    const flush = () => {
      if (!run) return;
      if (run.blank) {
        html += '<p style="text-indent:0;margin:0;height:' + lineH + 'px"></p>';
      } else {
        const src = correctedParas[run.paraIndex];
        const ind = run.start === 0 ? '2em' : '0';
        html += '<p class="para-edit" data-para="' + run.paraIndex + '" style="text-indent:' + ind + '">' +
          escapeHtml(src.slice(run.start, run.end)) + '</p>';
      }
      run = null;
    };
    for (const it of page) {
      if (it.blank) { flush(); run = { blank: true }; continue; }
      if (run && !run.blank && run.paraIndex === it.paraIndex) {
        run.end = it.end; /* 同段续块，合并 */
      } else {
        flush();
        run = { paraIndex: it.paraIndex, start: it.start, end: it.end };
      }
    }
    flush();
    content.innerHTML = html;
    el._idx = idx;
    /* 纠错点击不再在此逐段绑定：改为在 bindGestures 里对 vp 做事件委托
       （handleTap 用 e.target.closest('.para-edit') 取真实段落），避免重复/错位绑定。
       长按进入纠错则在 bindGestures 用 elementFromPoint 直接定位手指下的段落。 */
    /* === 诊断浮层（仅 ?debug=1 时显示，不影响正常阅读）===
       chrome6 起：输出 vpH/fcH/fcTop/fcBottom/navbarReserve 五个真实尺寸，
       让用户硬刷 ?debug=1 直接看到所有数字、便于精确诊断。同时保留
       lastLineBottom（负数=溢出被切）与 linesPerPage 等历史字段。 */
    if (/[?&]debug=1/.test(location.search)) {
      const vp = viewport();
      const fc = content;
      const fcRect = fc ? fc.getBoundingClientRect() : null;
      const vpRect = vp ? vp.getBoundingClientRect() : null;
      const ps = fc ? fc.querySelectorAll('p') : [];
      const last = ps.length ? ps[ps.length - 1].getBoundingClientRect() : null;
      const fcBottom = fcRect ? fcRect.bottom : 0;
      const lastBottom = last ? last.bottom : 0;
      /* chrome11：UC 让位改靠 CSS body.uc { bottom: 150px !important } + JS 内联样式兜底，
         不再用 fp-content padding 让位（chrome9 验证 100px padding 不够，lineHeight 把字底顶进 navbar）。
         期望行为：UC 上 fcH ≈ innerHeight - reserve（body 被缩了 reserve px，fp-content 继承），
         navbarReserve = innerHeight - fcH ≈ reserve，lastLineBottom 应为正数（文字底部距 fp-content 底还有空隙）。
         vpH 同步减 reserve = JS 算出的分页可用高度，CSS/JS 严格 1:1。 */
      const stage = getStageInnerSize();
      const fcH = fcRect ? Math.round(fcRect.height) : 0;
      const navbarReserve = fcH ? Math.round(window.innerHeight - fcH) : 0;
      const info = [
        'winH=' + Math.round(window.innerHeight) + ' (window.innerHeight, 含 UC navbar)',
        'vpH=' + Math.round(stage.vpH) + ' (getStageInnerSize, UC 减 reserve=' + UC_BODY_RESERVE + ' 与 CSS body 严格 1:1)',
        'vh(分页可用)=' + Math.round(stage.vh) + ' = vpH - 8 - 8',
        'PAD_BOT=8 (chrome11: 让位靠缩 body+内联样式, padding 仅做视觉留白)',
        'fcH=' + fcH + ' (fp-content 实测高, 继承 body 高, UC=innerH-reserve)',
        'fcTop=' + (fcRect ? Math.round(fcRect.top) : '?'),
        'fcBottom=' + (fcRect ? Math.round(fcRect.bottom) : '?'),
        'navbarReserve(估)=' + navbarReserve + ' ≈ UC 上 body 实际缩量(应≈' + UC_BODY_RESERVE + ')',
        'UA=' + (navigator.userAgent.match(/UCBrowser|UCWEB|MicroMessenger|iPhone|Android/i) || ['?'])[0],
        'lastLineBottom=' + (function () {
          if (!last) return '?';
          return Math.round(fcBottom - lastBottom) + 'px (正数=文字底部在 fp-content 底之上, 负=溢出)';
        })(),
        'linesPerPage=' + (typeof pages !== 'undefined' && pages[idx] ? pages[idx].length : '?'),
        'idx=' + idx
      ].join('\n');
      let dbg = document.getElementById('debug-overlay');
      if (!dbg) {
        dbg = document.createElement('pre');
        dbg.id = 'debug-overlay';
        dbg.style.cssText = 'position:fixed;left:8px;top:8px;z-index:9999;background:rgba(0,0,0,.82);color:#0f0;font:11px/1.45 monospace;padding:10px 12px;border-radius:8px;max-width:92vw;white-space:pre-wrap;pointer-events:none;box-shadow:0 2px 12px rgba(0,0,0,.4)';
        document.body.appendChild(dbg);
      }
      dbg.textContent = info;
    }
  }

  /* ---------- 段落纠错（弹窗式：点正文段落 → 弹出编辑本段） ---------- */
  function openEdit(pi) {
    if (!book || pi < 0 || pi >= origParas.length) return;
    editingPara = pi;
    const orig = origParas[pi];
    const cur = correctedParas[pi] != null ? correctedParas[pi] : orig.text;
    const ta = document.getElementById('edit-text');
    ta.value = cur;
    const modal = document.getElementById('edit-modal');
    modal.hidden = false;
    void modal.offsetWidth;
    modal.classList.add('open');
    /* 等弹窗绘制后聚焦（iOS/UC 上延迟聚焦更稳，避免键盘弹起又被布局挤掉） */
    setTimeout(() => { try { ta.focus(); } catch (e) {} }, 60);
  }
  function closeEdit() {
    exitEditMode();   /* 关闭弹窗即退出纠错，回到阅读模式（保存/取消都走这里） */
    const modal = document.getElementById('edit-modal');
    modal.classList.remove('open');
    setTimeout(() => { modal.hidden = true; }, 250);
    editingPara = -1;
  }
  /* 退出纠错模式：去掉高亮、取消按钮 active，回到纯阅读态（不丢已保存的纠错数据） */
  function exitEditMode() {
    if (!editMode) return;
    editMode = false;
    const vp = viewport();
    if (vp) vp.classList.remove('edit-on');
    const btn = document.getElementById('btn-edit-mode');
    if (btn) btn.classList.remove('active');
  }
  async function saveEdit() {
    if (!book || editingPara < 0) { closeEdit(); return; }
    const pi = editingPara;
    const orig = origParas[pi];
    const newText = document.getElementById('edit-text').value;
    try {
      if (newText === orig.text) {
        /* 与原文相同 → 删除已有纠错记录 */
        await idbDelete('edits', [book.id, orig.origStart]);
      } else {
        await idbPut('edits', { bookId: book.id, origStart: orig.origStart, text: newText, at: Date.now() });
      }
      await buildCorrected();
      await paginate();
      /* 先退出纠错（去掉高亮），再重排渲染 → 保存后直接回到阅读模式 */
      exitEditMode();
      /* 重新定位到当前段落所在页 */
      const target = paraFirstPage(pi);
      index = target;
      renderPageInto(frontEl, index);
      renderPageInto(backEl, clamp(index + 1));
      frontEl.style.transform = ''; backEl.style.transform = '';
      setZ(); afterNavigate();
      showToast('已保存本段纠错');
    } catch (e) {
      showToast('保存失败：' + ((e && e.message) || e));
      console.error(e);
    }
    closeEdit();
  }
  function toggleEditMode() {
    if (editMode) {
      /* 退出纠错模式：仅去掉高亮，不丢已保存的纠错数据 */
      editMode = false;
      viewport().classList.remove('edit-on');
      document.getElementById('btn-edit-mode').classList.remove('active');
      renderPageInto(frontEl, index);
      renderPageInto(backEl, clamp(index + 1));
      showToast('已退出纠错');
      return;
    }
    /* 进入纠错模式：段落可点击编辑 */
    editMode = true;
    viewport().classList.add('edit-on');
    document.getElementById('btn-edit-mode').classList.add('active');
    renderPageInto(frontEl, index);
    renderPageInto(backEl, clamp(index + 1));
    showToast('纠错模式：点击正文任意段落即可修改；再点「✎ 纠错」退出');
  }

  /* ---------- 查找 / 替换（作用于 correctedParas，复用 edits 持久化） ----------
     设计：用户看到的文本 = correctedParas；替换某段 = 改 correctedParas[pi] 并写
     edits[bookId, origParas[pi].origStart]，与段落弹窗纠错共用同一套持久化，互不冲突。 */
  let frMatchParas = [];   /* 含匹配项的段落下标列表（origParas 下标） */
  let frCursor = -1;       /* 当前匹配游标（用于「下一处」循环跳转） */
  function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  /* 给定段落下标，返回它首次出现的页码（复用 saveEdit 里已有的段落→页码逻辑） */
  function paraFirstPage(pi) {
    for (let i = 0; i < pages.length; i++) {
      if (pages[i].some(it => it.paraIndex === pi)) return i;
    }
    return 0;
  }
  /* 全书查找：返回 { total, paras } —— total 为总匹配次数，paras 为含匹配的段落下标数组 */
  function findInBook(findText) {
    if (!findText) return { total: 0, paras: [] };
    const re = new RegExp(escapeRegExp(findText), 'g');
    let total = 0; const paras = [];
    for (let pi = 0; pi < origParas.length; pi++) {
      const cur = correctedParas[pi] != null ? correctedParas[pi] : origParas[pi].text;
      const m = cur.match(re);
      if (m) { total += m.length; paras.push(pi); }
    }
    return { total, paras };
  }
  /* 全书替换：对每个含 findText 的段落做全局替换，写 edits，返回 { changedParas, totalReplaced } */
  async function replaceAllInBook(findText, replText) {
    if (!findText) return { changedParas: 0, totalReplaced: 0 };
    const re = new RegExp(escapeRegExp(findText), 'g');
    let changedParas = 0, totalReplaced = 0;
    for (let pi = 0; pi < origParas.length; pi++) {
      const cur = correctedParas[pi] != null ? correctedParas[pi] : origParas[pi].text;
      if (cur.indexOf(findText) === -1) continue;
      const m = cur.match(re);
      const newText = cur.replace(re, replText);
      totalReplaced += (m ? m.length : 0);
      correctedParas[pi] = newText;
      changedParas++;
      const orig = origParas[pi];
      if (newText === orig.text) {
        await idbDelete('edits', [book.id, orig.origStart]);
      } else {
        await idbPut('edits', { bookId: book.id, origStart: orig.origStart, text: newText, at: Date.now() });
      }
    }
    return { changedParas, totalReplaced };
  }

  function openFindReplace() {
    const modal = document.getElementById('find-replace-modal');
    if (!modal) return;
    modal.hidden = false;
  }
  function closeFindReplace() {
    const modal = document.getElementById('find-replace-modal');
    if (!modal) return;
    modal.hidden = true;
    frMatchParas = []; frCursor = -1;
  }
  /* 查找并重置游标；返回 { total, paras } */
  function frSearch(findText) {
    const r = findInBook(findText);
    frMatchParas = r.paras;
    frCursor = -1;
    return r;
  }
  /* 跳到下一个匹配段落所在页（循环）；返回是否还有匹配 */
  function frGotoNext() {
    if (!frMatchParas.length) return false;
    frCursor = (frCursor + 1) % frMatchParas.length;
    const pi = frMatchParas[frCursor];
    goTo(paraFirstPage(pi));
    return true;
  }
  /* 全部替换 + 重新分页渲染；返回 { changedParas, totalReplaced } */
  async function frReplaceAll(findText, replText) {
    const r = await replaceAllInBook(findText, replText);
    if (r.changedParas > 0) {
      await paginate();
      index = clamp(index);
      renderPageInto(frontEl, index);
      renderPageInto(backEl, clamp(index + 1));
      frontEl.style.transform = ''; backEl.style.transform = '';
      setZ(); afterNavigate();
    }
    return r;
  }
  function frHasMatches() { return frMatchParas.length > 0; }

  /* ---------- 导出修正版 txt（把全部纠错 + 替换烘焙进正文，下载成干净 txt） ---------- */
  function makeExportName(title) {
    let base = (title || '文档').replace(/\.(txt|text)$/i, '');
    return base + '-修正版.txt';
  }
  async function exportCorrected() {
    if (!book) { showToast('请先打开一本书再导出'); return; }
    /* 从 IndexedDB 重新读取该书的全部纠错/替换，确保导出的是"已保存的所有修改"，
       不依赖内存里 correctedParas 的实时状态 */
    const edits = (await idbGetAll('edits')).filter(e => e.bookId === book.id);
    const map = {};
    edits.forEach(e => { map[e.origStart] = e.text; });
    const parts = origParas.map(p =>
      Object.prototype.hasOwnProperty.call(map, p.origStart) ? map[p.origStart] : p.text
    );
    const text = parts.join('\n');
    const blob = new Blob(['﻿' + text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = makeExportName(book.title);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    showToast('已导出修正版（含全部纠错与替换）');
  }

  function setZ() { if (frontEl) frontEl.style.zIndex = 2; if (backEl) backEl.style.zIndex = 1; }

  /* ---------- 进度 / 位置 ---------- */
  function firstOrigStart(idx) {
    const page = pages[idx];
    if (!page || !page.length) return 0;
    const pi = page[0].paraIndex;
    return origParas[pi] ? origParas[pi].origStart : 0;
  }
  function updateProgress() {
    /* 顶部百分比已由 updateProgressBar 维护 */
  }
  function updateProgressBar() {
    if (!book) return;
    const start = firstOrigStart(index);
    const bookPct = book.totalLen ? (start / book.totalLen * 100) : 0;
    let label = '全书 ' + bookPct.toFixed(1) + '%';
    const ch = getChapters();
    if (ch.length) {
      let idx = 0;
      for (let i = 0; i < ch.length; i++) { if (ch[i].offset <= start) idx = i; else break; }
      const chStart = ch[idx].offset;
      const chEnd = (idx + 1 < ch.length) ? ch[idx + 1].offset : book.totalLen;
      const chLen = Math.max(1, chEnd - chStart);
      const chPct = Math.min(100, Math.max(0, (start - chStart) / chLen * 100));
      label += ' · ' + chPct.toFixed(0) + '%';
    }
    /* 顶部进度（顶栏右侧，不占正文空间） */
    const topPct = document.getElementById('reader-top-pct');
    if (topPct) topPct.textContent = label;
  }
  function savePosition() {
    if (!book) return;
    book.lastReadChar = firstOrigStart(index);
    book.lastReadAt = Date.now();
    idbPut('books', book);
  }
  function findPageByOrigStart(pos) {
    for (let i = 0; i < pages.length; i++) {
      const fs = firstOrigStart(i);
      if (fs >= pos) return i;
    }
    return pages.length - 1;
  }

  /* ---------- 导航：翻页 / 跳转 ---------- */
  function afterNavigate() { updateProgress(); updateProgressBar(); savePosition(); updateNavChrome(); }

  function go(delta) {
    if (animating || !book) return;
    const target = clamp(index + delta);
    if (target === index) { showToast(delta > 0 ? '已经是最后一页' : '已经是第一页'); return; }
    /* UC 旧内核对 Element.animate / 3D 渲染支持不全，翻页动画会崩或丢帧；
       统一走 instant（无动画），保证能翻页且正文稳定可见。其余浏览器按设置走动画。 */
    const isUC = /UCBrowser|UCWEB|UcWeb/i.test(navigator.userAgent);
    if (isUC) { doInstant(target); return; }
    const mode = App.settings.turn || 'flip';
    if (mode === 'flip') doFlip(target, delta);
    else if (mode === 'slide') doSlide(target, delta);
    else doInstant(target);
  }
  function goTo(target) {
    if (animating || !book) return;
    target = clamp(target);
    if (target === index) { afterNavigate(); return; }
    doInstant(target);
  }

  function doInstant(target) {
    target = clamp(target);
    renderPageInto(frontEl, target);
    renderPageInto(backEl, clamp(target + 1));
    frontEl.style.transform = ''; backEl.style.transform = '';
    setZ();
    index = target; afterNavigate();
  }

  async function doSlide(target, dir) {
    animating = true;
    const cur = frontEl, nxt = backEl;
    renderPageInto(nxt, target);
    cur.style.transition = 'none'; nxt.style.transition = 'none';
    const fromX = dir > 0 ? '100%' : '-100%';
    const toX = dir > 0 ? '-100%' : '100%';
    nxt.style.transform = 'translateX(' + fromX + ')';
    cur.style.transform = 'translateX(0)';
    nxt.style.zIndex = dir > 0 ? 2 : 3; cur.style.zIndex = dir > 0 ? 3 : 2;
    void nxt.offsetWidth;
    cur.style.transition = 'transform .28s ease'; nxt.style.transition = 'transform .28s ease';
    cur.style.transform = 'translateX(' + toX + ')';
    nxt.style.transform = 'translateX(0)';
    await wait(300);
    cur.style.transition = ''; nxt.style.transition = '';
    frontEl = nxt; backEl = cur; setZ();
    index = target; afterNavigate(); animating = false;
  }

  async function doFlip(target, dir) {
    animating = true;
    const cur = frontEl, nxt = backEl;
    cur.style.transition = ''; nxt.style.transition = '';
    cur.style.transform = 'rotateY(0deg)'; nxt.style.transform = 'rotateY(0deg)';
    const sCur = cur.querySelector('.fp-shade'), sNxt = nxt.querySelector('.fp-shade');
    sCur.style.opacity = 0; sNxt.style.opacity = 0;
    if (dir > 0) {
      renderPageInto(nxt, target);
      cur.style.transformOrigin = 'left center'; nxt.style.transformOrigin = 'left center';
      cur.style.zIndex = 3; nxt.style.zIndex = 2;
      const a1 = cur.animate(
        [{ transform: 'rotateY(0deg)' }, { transform: 'rotateY(-180deg)' }],
        { duration: DUR, easing: 'ease-in-out' });
      const a2 = sCur.animate(
        [{ opacity: 0 }, { opacity: 0.5 }],
        { duration: DUR, easing: 'ease-in' });
      await Promise.all([a1.finished, a2.finished]);
    } else {
      renderPageInto(nxt, target);
      cur.style.transformOrigin = 'left center'; nxt.style.transformOrigin = 'left center';
      cur.style.zIndex = 2; nxt.style.zIndex = 3;
      nxt.style.transform = 'rotateY(-180deg)';
      const a1 = nxt.animate(
        [{ transform: 'rotateY(-180deg)' }, { transform: 'rotateY(0deg)' }],
        { duration: DUR, easing: 'ease-in-out' });
      const a2 = sNxt.animate(
        [{ opacity: 0.5 }, { opacity: 0 }],
        { duration: DUR, easing: 'ease-out' });
      await Promise.all([a1.finished, a2.finished]);
      nxt.style.transform = 'rotateY(0deg)';
    }
    frontEl = nxt; backEl = cur; setZ();
    index = target; afterNavigate(); animating = false;
  }

  /* ---------- 控件显隐 ----------
     按需求固定显示顶/底栏：此函数只确保两者都显示，绝不隐藏（避免页面跳动）。
     中部点击已不再调用本函数。 */
  /* 点击正文中央：切换顶/底栏浮层显隐。
     顶/底栏已改为 absolute 浮层，显隐只改 opacity（CSS transition），DOM 不增删、viewport 不重排 → 正文零跳动。
     平时阅读态为 bars-hidden（隐藏），点击中央切到 bars-shown，再点切回。 */
  function toggleControls() {
    const reader = document.getElementById('view-reader');
    if (!reader) return;
    const shown = reader.classList.contains('bars-shown');
    reader.classList.toggle('bars-shown', !shown);
    reader.classList.toggle('bars-hidden', shown);
  }
  /* 是否有覆盖层（弹窗/抽屉/浮面板）打开：打开时正文中央点击不触发显隐，避免误触 */
  function isOverlayOpen() {
    return !!document.querySelector('.modal:not([hidden]), .drawer.open, .pop-panel:not([hidden]), #rename-modal:not([hidden])');
  }

  function rerenderKeepingChar(char) {
    paginate();
    const target = findPageByOrigStart(char);
    renderPageInto(frontEl, target);
    renderPageInto(backEl, clamp(target + 1));
    frontEl.style.transform = ''; backEl.style.transform = '';
    setZ();
    index = target; afterNavigate();
  }

  /* ---------- 手势 ---------- */
  /* 长按纠错手势状态（模块级，handleTap 与 bindGestures 共用） */
  let lpTimer = null, lpX = 0, lpY = 0, lpFired = false;
  const LP_MS = 450, LP_MOVE = 12;
  function handleTap(clientX, target) {
    /* 长按手势已触发纠错 → 这次抬起不再翻页/显隐，避免重复触发 */
    if (lpFired) { lpFired = false; return; }
    /* 覆盖层（弹窗/抽屉/浮面板）打开时，正文点击交给覆盖层，不翻页也不显隐 */
    if (isOverlayOpen()) return;
    /* 纠错模式（点「✎ 纠错」进入的点击模式）：点段落 → 弹窗改本段；点别处不翻页/不显隐 */
    if (editMode) {
      const p = target && target.closest ? target.closest('.para-edit') : null;
      if (p && p.dataset && p.dataset.para != null) openEdit(+p.dataset.para);
      return;
    }
    const w = viewport().clientWidth;
    const r = clientX / w;
    if (r < 0.25) go(-1);
    else if (r > 0.75) go(1);
    else toggleControls();   /* 中央区域点击 → 切换顶/底栏浮层显隐 */
  }
  let resizeTimer = null;
  function bindGestures() {
    const vp = viewport();
    let sx = 0, sy = 0, moved = false;
    vp.addEventListener('touchstart', (e) => { const t = e.touches[0]; sx = t.clientX; sy = t.clientY; moved = false; }, { passive: true });
    vp.addEventListener('touchmove', (e) => {
      const t = e.touches[0];
      const dx = t.clientX - sx, dy = t.clientY - sy;
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) moved = true;
      // 横向滑动时阻止浏览器把横滑当成"后退/前进"手势（UC/安卓旧 WebView 常见），确保滑动翻页可靠
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 8) e.preventDefault();
    }, { passive: false });
    vp.addEventListener('touchend', (e) => {
      const t = e.changedTouches[0];
      const dx = t.clientX - sx, dy = t.clientY - sy;
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
        const right = dx > 0;
        go(right === SWIPE_RIGHT_IS_NEXT ? 1 : -1);
      }
      else if (!moved) { handleTap(t.clientX, e.target); }
    });
    if (!isTouch) {
      vp.addEventListener('click', (e) => { handleTap(e.clientX, e.target); });
    }
    /* 长按进入纠错（取代点「✎ 纠错」按钮）：手指长按正文 → 直接打开该段编辑弹窗。
       用 elementFromPoint 取到手指下的真实段落元素，从根上避免"点到 A 段却弹出 B 段"的选错问题。 */
    vp.addEventListener('contextmenu', (e) => { e.preventDefault(); }); // 长按不弹系统菜单/复制条
    const lpStart = (x, y) => {
      if (isOverlayOpen()) return;
      lpX = x; lpY = y; lpFired = false;
      clearTimeout(lpTimer);
      lpTimer = setTimeout(() => {
        lpFired = true;
        const elx = document.elementFromPoint(lpX, lpY);
        const para = elx && elx.closest ? elx.closest('.para-edit') : null;
        if (para && para.dataset && para.dataset.para != null) openEdit(+para.dataset.para);
      }, LP_MS);
    };
    const lpMove = (x, y) => {
      if (Math.abs(x - lpX) > LP_MOVE || Math.abs(y - lpY) > LP_MOVE) clearTimeout(lpTimer);
    };
    const lpEnd = () => { clearTimeout(lpTimer); };
    vp.addEventListener('touchstart', (e) => { const t = e.touches[0]; if (t) lpStart(t.clientX, t.clientY); }, { passive: true });
    vp.addEventListener('touchmove', (e) => { const t = e.touches[0]; if (t) lpMove(t.clientX, t.clientY); }, { passive: true });
    vp.addEventListener('touchend', lpEnd, { passive: true });
    vp.addEventListener('touchcancel', lpEnd, { passive: true });
    if (!isTouch) {
      vp.addEventListener('mousedown', (e) => lpStart(e.clientX, e.clientY));
      vp.addEventListener('mousemove', (e) => lpMove(e.clientX, e.clientY));
      vp.addEventListener('mouseup', lpEnd);
      vp.addEventListener('mouseleave', lpEnd);
    }
    /* window resize（系统字体大小变化、屏幕旋转）→ 重排 */
    window.addEventListener('resize', () => {
      if (!book) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { rerenderKeepingChar(firstOrigStart(index)); applyUCLayout(); }, 200);
    });
    /* visualViewport.resize（UC 切全屏/分屏、弹出/收起键盘、等）→ 重排 */
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', () => {
        if (!book) return;
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => { rerenderKeepingChar(firstOrigStart(index)); applyUCLayout(); }, 200);
      });
    }
  }

  /* ---------- 章节 / 目录 / 书签 ---------- */
  function getChapters() {
    if (book && book.chapters) return book.chapters;
    if (book && typeof detectChapters === 'function') return detectChapters(book.content);
    return [];
  }
  function currentChapterTitle(char) {
    const ch = getChapters();
    let t = '';
    for (const c of ch) { if (c.offset <= char) t = c.title; else break; }
    return t;
  }
  function openDrawer(tab) {
    const d = document.getElementById('toc-drawer');
    d.hidden = false;
    void d.offsetWidth;
    d.classList.add('open');
    /* drawer-body 用 position:absolute + top 兜底（CSS 已给 64px）。
       head 高度只在"合理正数"时才覆盖 top，避免 UC 上 offsetHeight 返回异常大/0 值
       把 body 顶飞或压成 0 高度。head 实际高度通常 50–70px，64px 兜底已足够贴近。 */
    const head = d.querySelector('.drawer-head');
    const body = d.querySelector('.drawer-body');
    if (head && body) {
      const h = head.offsetHeight;
      if (h && h > 20 && h < 200) body.style.top = h + 'px';
    }
    switchTab(tab || drawerTab);
  }
  function closeDrawer() {
    const d = document.getElementById('toc-drawer');
    d.classList.remove('open');
    setTimeout(() => { d.hidden = true; }, 250);
  }
  function switchTab(tab) {
    drawerTab = tab;
    document.querySelectorAll('.dtab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    const toc = document.getElementById('toc-list'), bm = document.getElementById('bm-list');
    if (tab === 'toc') { toc.hidden = false; bm.hidden = true; renderTOC(); }
    else { toc.hidden = true; bm.hidden = false; renderBookmarks(); }
  }
  function renderTOC() {
    const list = document.getElementById('toc-list');
    const ch = getChapters();
    if (!ch.length) { list.innerHTML = '<div class="toc-empty">未识别到章节标题<br>可在设置中切换翻页方式，或手动跳转</div>'; return; }
    const cur = firstOrigStart(index);
    let activeIdx = -1;
    for (let i = 0; i < ch.length; i++) { if (ch[i].offset <= cur) activeIdx = i; else break; }
    list.innerHTML = '';
    ch.forEach((c, i) => {
      const item = document.createElement('div');
      item.className = 'toc-item' + (i === activeIdx ? ' active' : '');
      item.textContent = c.title;
      item.addEventListener('click', () => { goTo(findPageByOrigStart(c.offset)); closeDrawer(); });
      list.appendChild(item);
    });
  }
  function renderBookmarks() {
    const list = document.getElementById('bm-list');
    const bms = (book && book.bookmarks) || [];
    list.innerHTML = '';
    const add = document.createElement('button');
    add.className = 'wide-btn primary bm-add';
    add.textContent = '＋ 添加当前页为书签';
    add.addEventListener('click', addBookmark);
    list.appendChild(add);
    if (!bms.length) {
      const e = document.createElement('div'); e.className = 'toc-empty'; e.textContent = '还没有书签';
      list.appendChild(e); return;
    }
    const cur = index;
    bms.forEach((m, i) => {
      const row = document.createElement('div');
      row.className = 'bm-item' + (m.page === cur ? ' active' : '');
      const info = document.createElement('div');
      info.className = 'bm-info';
      info.innerHTML = '<div class="bm-label">' + escapeHtml(m.label) + '</div><div class="bm-sub">第 ' + (m.page + 1) + ' 页</div>';
      const del = document.createElement('button');
      del.className = 'bm-del'; del.textContent = '×';
      del.addEventListener('click', (ev) => { ev.stopPropagation(); removeBookmark(i); });
      row.appendChild(info); row.appendChild(del);
      row.addEventListener('click', () => { goTo(m.page); closeDrawer(); });
      list.appendChild(row);
    });
  }
  async function addBookmark() {
    if (!book) return;
    if (!book.bookmarks) book.bookmarks = [];
    const label = currentChapterTitle(firstOrigStart(index)) || ('第 ' + (index + 1) + ' 页');
    book.bookmarks.push({ char: firstOrigStart(index), page: index, label, at: Date.now() });
    await idbPut('books', book);
    renderBookmarks();
    showToast('已添加书签');
  }
  async function removeBookmark(i) {
    if (!book || !book.bookmarks) return;
    book.bookmarks.splice(i, 1);
    await idbPut('books', book);
    renderBookmarks();
  }
  function updateNavChrome() {
    const d = document.getElementById('toc-drawer');
    if (d.hidden) return;
    if (drawerTab === 'toc') renderTOC(); else renderBookmarks();
  }

  function bindUI() {
    /* ---------- 按页数跳转：底部弹窗 + 滑动条（不弹键盘） ---------- */
    const jumpModal = document.getElementById('jump-modal');
    const jumpRange = document.getElementById('jump-range');
    const jumpCur = document.getElementById('jump-cur');
    const jumpTotal = document.getElementById('jump-total');
    const jumpScaleEnd = document.getElementById('jump-scale-end');

    function openJump() {
      if (!book || pages.length === 0) return;
      const total = pages.length;
      jumpRange.min = 1;
      jumpRange.max = total;
      jumpRange.value = index + 1;
      jumpCur.textContent = (index + 1);
      jumpTotal.textContent = total;
      jumpScaleEnd.textContent = '第 ' + total + ' 页';
      jumpModal.hidden = false;
      void jumpModal.offsetWidth;
      jumpModal.classList.add('open');
      /* 避免 iOS/UC 在弹窗出现时自动聚焦触发键盘 —— 这里本就没有输入框，
         但保险起见把 range 设成 -1 tabindex 无关，主要靠没有文本输入控件 */
    }
    function closeJump() {
      jumpModal.classList.remove('open');
      setTimeout(() => { jumpModal.hidden = true; }, 250);
    }
    function gotoPage(pg) {
      pg = Math.max(1, Math.min(pages.length, pg));
      goTo(pg - 1);
      closeJump();
    }

    document.getElementById('btn-jump').addEventListener('click', openJump);
    document.getElementById('jump-close').addEventListener('click', closeJump);
    document.getElementById('jump-cancel').addEventListener('click', closeJump);
    document.getElementById('jump-mask').addEventListener('click', closeJump);
    document.getElementById('jump-confirm').addEventListener('click', () => gotoPage(+jumpRange.value));
    jumpRange.addEventListener('input', () => { jumpCur.textContent = (+jumpRange.value); });
    /* 滑块拖动结束（change）不自动跳转，等用户点"跳转"，体验更接近截图中的底部弹窗 */

    document.getElementById('btn-reader-toc').addEventListener('click', () => openDrawer('toc'));
    document.getElementById('toc-close').addEventListener('click', closeDrawer);
    document.getElementById('drawer-mask').addEventListener('click', closeDrawer);
    document.querySelectorAll('.dtab').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  }

  /* ---------- 打开一本书 ---------- */
  async function open(b) {
    book = b;
    document.getElementById('reader-title').textContent = b.title;
    const lines = b.content.split('\n');
    let pos = 0; origParas = [];
    for (const ln of lines) {
      const text = ln.replace(/\r$/, '');
      origParas.push({ origStart: pos, origEnd: pos + text.length, text });
      pos += text.length + 1;
    }
    document.getElementById('reader-bottombar').hidden = false;
    document.getElementById('reader-topbar').hidden = false;

    frontEl = document.getElementById('flip-a');
    backEl = document.getElementById('flip-b');
    frontEl.style.transform = ''; backEl.style.transform = '';
    frontEl.style.zIndex = ''; backEl.style.zIndex = '';

    /* chrome6 UC 兼容：applyUCLayout 写 fc.style.height（inline 100% 生效），
       fp-content 真实高度 = innerH - navbarReserve（UC navbar 让位）。
       后续 paginate 用 getStageInnerSize 读 fc.style.height 得到 fcH，
       再算可用高 = fcH - 16，分页预估与 fp-content 真实可绘区严格 1:1，
       从原理上杜绝「末行被 overflow:hidden 切」。 */
    applyUCLayout();

    const loading = document.getElementById('reader-loading');
    loading.hidden = false;
    loading.textContent = '正在排版…';
    // 先让「正在排版」绘制出来，再做后续（大文件时避免白屏假死）。
    // 关键兼容：UC 浏览器在视图切换时会**暂停/节流**页面定时器（setTimeout）与
    // requestAnimationFrame，导致"等一帧"的 await 永远不 resolve → 永远卡在「正在排版…」。
    // MessageChannel 的 postMessage 回调**不受定时器/rAF 节流影响**，是已知最可靠的让帧方式；
    // 同时保留 rAF + setTimeout 双兜底，确保任意环境都不卡死。
    await new Promise(r => {
      let fired = false;
      const finish = () => { if (!fired) { fired = true; r(); } };
      if (typeof MessageChannel !== 'undefined') {
        const ch = new MessageChannel();
        ch.port1.onmessage = finish;
        ch.port2.postMessage(0);
      } else {
        requestAnimationFrame(() => requestAnimationFrame(finish));
        setTimeout(finish, 200);
      }
    });
    let failed = false;
    try {
      await buildCorrected();
      await paginate();
      index = b.lastReadChar ? findPageByOrigStart(b.lastReadChar) : 0;
      renderPageInto(frontEl, index);
      renderPageInto(backEl, clamp(index + 1));
      setZ();
      afterNavigate();
    } catch (e) {
      failed = true;
      // 把确切错误直接显示在加载区（而非只弹 toast，便于用户在 UC 上截图反馈精确原因）
      const msg = (e && e.message) ? e.message : String(e);
      loading.textContent = '打开失败：' + msg;
      showToast('打开失败：' + msg);
      console.error('Reader.open 失败：', e);
    } finally {
      // 失败时保留错误文本在加载区，不隐藏；成功才隐藏
      if (!failed) loading.hidden = true;
    }
  }

  function reloadSettings() {
    if (!book) return;
    rerenderKeepingChar(firstOrigStart(index));
  }

  bindGestures();
  bindUI();

  return {
    open, go, goTo, toggleControls, toggleEditMode, saveEdit, closeEdit, reloadSettings,
    openDrawer, closeDrawer, switchTab, addBookmark,
    openFindReplace, closeFindReplace, frSearch, frGotoNext, frReplaceAll, frHasMatches,
    exportCorrected,
    onTap: toggleControls
  };
})();
