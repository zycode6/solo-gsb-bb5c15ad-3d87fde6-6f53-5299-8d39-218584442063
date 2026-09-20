/*
 * app.js —— 父页面主逻辑（原生 JavaScript）
 *
 * 流程：
 *  1. 读取用户 HTML / CSS，剥离用户脚本与危险属性（DOMParser，不执行脚本）；
 *  2. 把「净化后的 HTML + 用户 CSS + 分析脚本 analyzer.js」拼成 srcdoc，
 *     装入 sandbox="allow-scripts"（无 allow-same-origin）的 iframe；
 *  3. 通过 postMessage 接收焦点路线，渲染顺序列表与诊断；
 *  4. 步进高亮（Tab / Shift+Tab）；编辑重算后按稳定选择器恢复当前位置；
 *  5. 汇总报告经 POST /api/export 导出为 JSON 附件。
 */
(function () {
  'use strict';

  var SOURCE = 'focus-lab';

  var els = {
    html: document.getElementById('html-input'),
    css: document.getElementById('css-input'),
    autoApply: document.getElementById('auto-apply'),
    applyBtn: document.getElementById('apply-btn'),
    frame: document.getElementById('preview-frame'),
    status: document.getElementById('preview-status'),
    prevBtn: document.getElementById('prev-btn'),
    nextBtn: document.getElementById('next-btn'),
    captureBtn: document.getElementById('step-capture'),
    stepIndicator: document.getElementById('step-indicator'),
    restoreHint: document.getElementById('restore-hint'),
    exportBtn: document.getElementById('export-btn'),
    pinBtn: document.getElementById('pin-btn'),
    clearBaselineBtn: document.getElementById('clear-baseline-btn'),
    tabOrder: document.getElementById('tab-order'),
    tabExcluded: document.getElementById('tab-excluded'),
    tabBaseline: document.getElementById('tab-baseline'),
    orderList: document.getElementById('order-list'),
    orderCount: document.getElementById('order-count'),
    excludedPanel: document.getElementById('excluded-panel'),
    excludedList: document.getElementById('excluded-list'),
    excludedCount: document.getElementById('excluded-count'),
    baselinePanel: document.getElementById('baseline-panel'),
    baselineList: document.getElementById('baseline-list'),
    baselineCount: document.getElementById('baseline-count'),
    baselineMetaText: document.getElementById('baseline-meta-text'),
    diagnosticsList: document.getElementById('diagnostics-list')
  };

  var state = {
    analyzerSrc: null,   // analyzer.js 源码文本
    entries: [],         // 最近一次路线节点
    order: [],           // selector 数组（Tab 顺序）
    diagnostics: [],
    stats: null,
    currentStep: -1,     // 当前高亮在顺序中的下标
    restoreSelector: null, // 待恢复的稳定选择器
    routeTimer: null,    // 路线响应超时计时器
    baseline: null,      // 基线快照 {pinnedAt, htmlHash, cssHash, htmlLen, cssLen, stats, nodes}
    diff: null           // 基线对比结果（FocusDiff.computeBaselineDiff 的返回值）
  };

  /* ---------------- 示例输入 ---------------- */

  var SAMPLE_HTML = [
    '<h1>示例：注册表单</h1>',
    '<button>第一个按钮</button>',
    '<a href="#">普通链接</a>',
    '<input type="text" placeholder="用户名">',
    '<button tabindex="3">正数 tabindex=3</button>',
    '<button tabindex="1">正数 tabindex=1（插队到最前）</button>',
    '<div tabindex="0">可聚焦的 div</div>',
    '<button disabled>禁用按钮</button>',
    '<input type="hidden" value="secret">',
    '<p hidden>隐藏段落 <a href="#">其中的链接</a></p>',
    '<div inert>',
    '  <button>inert 容器内的按钮</button>',
    '</div>',
    '<div class="gone"><button>display:none 内的按钮</button></div>',
    '<button tabindex="-1">仅脚本可聚焦</button>',
    '<details>',
    '  <summary>详情摘要</summary>',
    '  <button>闭合 details 内的按钮</button>',
    '</details>',
    '<fieldset disabled>',
    '  <legend>整组禁用</legend>',
    '  <input type="text" placeholder="被 fieldset 禁用">',
    '</fieldset>',
    '<a>没有 href 的链接（不可聚焦）</a>',
    '<div aria-hidden="true"><button>aria-hidden 内的可聚焦按钮</button></div>',
    '<script>alert("这段用户脚本会被剥离，不会执行")<' + '/script>'
  ].join('\n');

  var SAMPLE_CSS = [
    'body { font-family: sans-serif; padding: 12px; }',
    'button, a, input, summary, div[tabindex] { display: inline-block; margin: 4px; padding: 4px 8px; }',
    '.gone { display: none; }',
    ':focus { outline: 2px dashed #4f8cff; }'
  ].join('\n');

  /* ---------------- 净化：剥离用户脚本 ---------------- */

  /**
   * 用 DOMParser 解析（不会执行脚本），移除：
   *  - <script>、<base>、<meta http-equiv>（如 refresh 跳转）
   *  - 所有 on* 事件属性
   *  - javascript: / data:text/html 协议的链接类属性
   *  - srcdoc（防止注入未净化的嵌套文档）
   */
  function sanitizeHtml(html) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var kill = doc.querySelectorAll('script, base, meta[http-equiv]');
    for (var i = 0; i < kill.length; i++) kill[i].remove();

    var all = doc.querySelectorAll('*');
    for (var j = 0; j < all.length; j++) {
      var el = all[j];
      var attrs = Array.prototype.slice.call(el.attributes);
      for (var k = 0; k < attrs.length; k++) {
        var name = attrs[k].name.toLowerCase();
        var compact = String(attrs[k].value).replace(/[\s\x00-\x1F]+/g, '').toLowerCase();
        if (name.indexOf('on') === 0) {
          el.removeAttribute(attrs[k].name);
        } else if (name === 'srcdoc') {
          el.removeAttribute(attrs[k].name);
        } else if (
          (name === 'href' || name === 'src' || name === 'xlink:href' ||
           name === 'formaction' || name === 'action' || name === 'poster') &&
          (compact.indexOf('javascript:') === 0 || compact.indexOf('data:text/html') === 0)
        ) {
          el.removeAttribute(attrs[k].name);
        }
      }
    }
    return doc.documentElement.outerHTML;
  }

  /** 拼装 srcdoc：净化 HTML + 用户 CSS + 分析脚本 */
  function buildSrcdoc(html, css, analyzerSrc) {
    var doc = new DOMParser().parseFromString(sanitizeHtml(html), 'text/html');
    var style = doc.createElement('style');
    style.textContent = css;
    (doc.head || doc.documentElement).appendChild(style);
    var script = doc.createElement('script');
    script.textContent = analyzerSrc;
    (doc.body || doc.documentElement).appendChild(script);
    return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
  }

  /* ---------------- 渲染与重算 ---------------- */

  function setStatus(text, kind) {
    els.status.textContent = text;
    els.status.className = 'status' + (kind ? ' ' + kind : '');
  }

  function setRestoreHint(text) {
    els.restoreHint.textContent = text || '';
  }

  /** djb2 → 8 位十六进制摘要，仅用于基线元信息（标识输入版本，非加密用途） */
  function hashText(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) {
      h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  function applyAndRecompute() {
    if (!state.analyzerSrc) return;
    // 记录当前高亮节点的稳定选择器，供重算后恢复位置
    if (state.currentStep >= 0 && state.order[state.currentStep]) {
      state.restoreSelector = state.order[state.currentStep];
    }
    setStatus('渲染中…');
    clearTimeout(state.routeTimer);
    state.routeTimer = setTimeout(function () {
      setStatus('预览脚本未响应（可能存在语法错误）', 'err');
    }, 5000);
    els.frame.srcdoc = buildSrcdoc(els.html.value, els.css.value, state.analyzerSrc);
  }

  var debounceTimer = null;
  function scheduleApply() {
    if (!els.autoApply.checked) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(applyAndRecompute, 600);
  }

  /* ---------------- 消息处理 ---------------- */

  window.addEventListener('message', function (ev) {
    if (ev.source !== els.frame.contentWindow) return; // 只接受预览 iframe 的消息
    var d = ev.data || {};
    if (d.source !== SOURCE) return;

    if (d.type === 'route') {
      clearTimeout(state.routeTimer);
      onRoute(d.payload);
    } else if (d.type === 'highlighted') {
      state.currentStep = d.step;
      updateStepUI();
    } else if (d.type === 'highlight-miss') {
      setRestoreHint('差异项对应的节点（' + d.selector + '）在当前文档中找不到，无法高亮。');
    } else if (d.type === 'error') {
      clearTimeout(state.routeTimer);
      setStatus('分析脚本错误：' + d.message, 'err');
    }
  });

  function onRoute(payload) {
    state.entries = payload.entries || [];
    state.order = payload.order || [];
    state.diagnostics = payload.diagnostics || [];
    state.stats = payload.stats || null;
    state.currentStep = -1;
    computeDiff();
    renderResults();
    renderBaselinePanel();
    var extra = state.baseline ? ('；与基线相比 ' + diffSummaryPhrase(state.diff)) : '';
    setStatus('已计算：' + state.order.length + ' 个可聚焦节点' + extra, 'ok');

    // 按稳定选择器恢复编辑前的位置
    if (state.restoreSelector) {
      var idx = state.order.indexOf(state.restoreSelector);
      if (idx >= 0) {
        setRestoreHint('已按稳定选择器恢复到位置 ' + (idx + 1) + '：' + state.restoreSelector);
        sendToFrame({ type: 'highlight', step: idx });
      } else {
        setRestoreHint('原节点（' + state.restoreSelector + '）已不在 Tab 顺序中，未恢复。');
        updateStepUI();
      }
      state.restoreSelector = null;
    } else {
      updateStepUI();
    }
  }

  function diffSummaryPhrase(diff) {
    if (!diff) return '';
    var s = diff.summary;
    var parts = [];
    if (s.added) parts.push('新增 ' + s.added);
    if (s.removed) parts.push('移除 ' + s.removed);
    if (s.moved) parts.push('移位 ' + s.moved);
    if (s.statusChanged) parts.push('状态变化 ' + s.statusChanged);
    if (s.ambiguous) parts.push('歧义 ' + s.ambiguous);
    return parts.length ? parts.join('、') : '无差异';
  }

  function sendToFrame(msg) {
    msg.target = SOURCE;
    if (els.frame.contentWindow) els.frame.contentWindow.postMessage(msg, '*');
  }

  /* ---------------- 结果渲染 ---------------- */

  function entryBySelector(selector) {
    for (var i = 0; i < state.entries.length; i++) {
      if (state.entries[i].selector === selector) return state.entries[i];
    }
    return null;
  }

  /* ---------------- 基线对比 ---------------- */

  /** 当前节点的快照（身份字段 + 状态 + 序号），钉基线与导出使用 */
  function snapshotNodes() {
    return state.entries.map(function (e) {
      return {
        selector: e.selector,
        label: e.label,
        tag: e.tag,
        text: e.text || '',
        status: e.status,
        step: e.step == null ? null : e.step,
        uid: e.uid || null,
        fingerprint: e.fingerprint,
        scope: e.scope,
        path: e.path
      };
    });
  }

  function computeDiff() {
    if (state.baseline && window.FocusDiff) {
      state.diff = window.FocusDiff.computeBaselineDiff(state.baseline.nodes, snapshotNodes());
    } else {
      state.diff = null;
    }
  }

  function pinBaseline() {
    if (!state.entries.length) return;
    state.baseline = {
      pinnedAt: new Date().toISOString(),
      htmlHash: hashText(els.html.value),
      cssHash: hashText(els.css.value),
      htmlLength: els.html.value.length,
      cssLength: els.css.value.length,
      stats: state.stats ? JSON.parse(JSON.stringify(state.stats)) : null,
      nodes: snapshotNodes()
    };
    computeDiff();
    renderBaselinePanel();
    renderResults();
    setStatus('已钉为基线：' + state.baseline.nodes.length + ' 个候选节点；后续重算将自动对比', 'ok');
  }

  function clearBaseline() {
    state.baseline = null;
    state.diff = null;
    renderBaselinePanel();
    renderResults();
    setStatus('已清除基线', null);
  }

  /**
   * 为顺序 / 排除列表建立 selector → 差异类型 的索引，用于行内徽标。
   * 低置信（歧义）配对不在顺序列表标成 moved，避免错误信息。
   */
  function buildDiffIndex() {
    var current = {};
    var baseline = {};
    var diff = state.diff;
    if (!diff) return { current: current, baseline: baseline };

    diff.moved.forEach(function (d) { current[d.selector] = 'moved'; });
    diff.statusChanged.forEach(function (d) { current[d.selector] = 'status'; });
    diff.added.forEach(function (n) { current[n.selector] = 'added'; });
    diff.removed.forEach(function (n) { baseline[n.selector] = 'removed'; });
    diff.ambiguous.forEach(function (a) {
      if (a.kind === 'ambiguous-pair') {
        current[a.current.selector] = 'ambiguous';
        baseline[a.baseline.selector] = 'ambiguous';
      } else if (a.side === 'current') {
        current[a.node.selector] = 'ambiguous';
      } else {
        baseline[a.node.selector] = 'ambiguous';
      }
    });
    return { current: current, baseline: baseline };
  }

  function findDiffForCurrent(selector) {
    var diff = state.diff;
    if (!diff) return null;
    var i;
    for (i = 0; i < diff.moved.length; i++) if (diff.moved[i].selector === selector) return diff.moved[i];
    for (i = 0; i < diff.statusChanged.length; i++) if (diff.statusChanged[i].selector === selector) return diff.statusChanged[i];
    for (i = 0; i < diff.added.length; i++) if (diff.added[i].selector === selector) return diff.added[i];
    for (i = 0; i < diff.ambiguous.length; i++) {
      var a = diff.ambiguous[i];
      if ((a.kind === 'ambiguous-pair' && a.current.selector === selector) ||
          (a.kind === 'ambiguous-node' && a.side === 'current' && a.node.selector === selector)) {
        return a;
      }
    }
    return null;
  }

  /** 差异项点击：联动 iframe 高亮（按选择器，覆盖被排除节点） */
  function highlightDiffSelector(selector) {
    setRestoreHint('');
    sendToFrame({ type: 'highlight-selector', selector: selector });
  }

  var DIFF_LABELS = {
    added: '新增',
    removed: '已移除',
    moved: '移位',
    status: '状态变化',
    ambiguous: '歧义'
  };

  /** 在顺序 / 排除列表行内追加差异徽标（移位带前后序号） */
  function appendDiffBadge(container, kind, detail) {
    if (!kind) return;
    var badge = document.createElement('span');
    badge.className = 'diff-badge ' + kind;
    if (kind === 'moved' && detail) {
      badge.textContent = DIFF_LABELS.moved + ' #' + detail.from + ' → #' + detail.to;
    } else if (kind === 'status' && detail) {
      badge.textContent = detail.fromStatusLabel + ' → ' + detail.toStatusLabel;
    } else {
      badge.textContent = DIFF_LABELS[kind] || kind;
    }
    container.appendChild(badge);
  }

  function renderResults() {
    var diffIndex = buildDiffIndex();
    // Tab 顺序列表
    els.orderList.innerHTML = '';
    els.orderCount.textContent = String(state.order.length);
    if (state.order.length === 0) {
      var tip = document.createElement('li');
      tip.className = 'empty-tip';
      tip.textContent = '没有可 Tab 聚焦的元素。';
      els.orderList.appendChild(tip);
    }
    state.order.forEach(function (selector, i) {
      var e = entryBySelector(selector) || { label: selector, selector: selector };
      var li = document.createElement('li');
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'node-item diff-' + (diffIndex.current[selector] || 'none');
      btn.dataset.step = String(i);

      var line = document.createElement('span');
      var no = document.createElement('span');
      no.className = 'step-no';
      no.textContent = String(i + 1);
      line.appendChild(no);
      line.appendChild(document.createTextNode(' ' + e.label));
      if (e.tabIndex > 0) {
        var b = document.createElement('span');
        b.className = 'badge positive';
        b.textContent = 'tabindex=' + e.tabIndex;
        line.appendChild(b);
      } else if (e.hasTabindexAttr) {
        var b0 = document.createElement('span');
        b0.className = 'badge';
        b0.textContent = 'tabindex=0';
        line.appendChild(b0);
      }
      appendDiffBadge(line, diffIndex.current[selector], findDiffForCurrent(selector));
      btn.appendChild(line);

      var sel = document.createElement('span');
      sel.className = 'sel';
      sel.textContent = e.selector;
      btn.appendChild(sel);

      if (e.text) {
        var t = document.createElement('span');
        t.className = 'text';
        t.textContent = '“' + e.text + '”';
        btn.appendChild(t);
      }

      btn.addEventListener('click', function () {
        sendToFrame({ type: 'highlight', step: i });
      });
      li.appendChild(btn);
      els.orderList.appendChild(li);
    });

    // 排除列表（含 tabindex<0 的“仅编程聚焦”节点）
    els.excludedList.innerHTML = '';
    var excluded = state.entries.filter(function (e) {
      return e.status === 'excluded' || e.status === 'programmatic' ||
        (e.warnings && e.warnings.length > 0);
    });
    els.excludedCount.textContent = String(excluded.length);
    if (excluded.length === 0) {
      var li0 = document.createElement('li');
      li0.className = 'empty-tip';
      li0.textContent = '没有被排除的候选元素。';
      els.excludedList.appendChild(li0);
    }
    excluded.forEach(function (e) {
      var li = document.createElement('li');
      var box = document.createElement('div');
      box.className = 'node-item diff-' + (diffIndex.current[e.selector] || 'none');
      box.setAttribute('role', 'button');
      box.tabIndex = 0;
      box.title = '点击在预览中高亮';

      var title = document.createElement('span');
      title.textContent = e.label + ' ';
      var tag = document.createElement('span');
      tag.className = 'badge';
      tag.textContent = e.status === 'programmatic' ? 'tabindex<0' :
        (e.status === 'excluded' ? '已排除' : '提示');
      title.appendChild(tag);
      appendDiffBadge(title, diffIndex.current[e.selector], findDiffForCurrent(e.selector));
      box.appendChild(title);

      (e.reasons || []).forEach(function (r) {
        var rEl = document.createElement('span');
        rEl.className = 'reason';
        rEl.textContent = r.message;
        box.appendChild(rEl);
      });
      (e.warnings || []).forEach(function (w) {
        var wEl = document.createElement('span');
        wEl.className = 'reason';
        wEl.textContent = '⚠ ' + w.message;
        box.appendChild(wEl);
      });

      var sel2 = document.createElement('span');
      sel2.className = 'sel';
      sel2.textContent = e.selector;
      box.appendChild(sel2);

      function locate() { highlightDiffSelector(e.selector); }
      box.addEventListener('click', locate);
      box.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); locate(); }
      });

      li.appendChild(box);
      els.excludedList.appendChild(li);
    });

    // 全局诊断
    els.diagnosticsList.innerHTML = '';
    if (state.diagnostics.length === 0) {
      var liD = document.createElement('li');
      liD.className = 'empty-tip';
      liD.textContent = '暂无诊断信息。';
      els.diagnosticsList.appendChild(liD);
    }
    state.diagnostics.forEach(function (dg) {
      var li = document.createElement('li');
      li.className = 'diag ' + (dg.level === 'warn' ? 'warn' : 'info');
      li.textContent = (dg.level === 'warn' ? '⚠ ' : 'ℹ ') + dg.message;
      els.diagnosticsList.appendChild(li);
    });
  }

  function updateStepUI() {
    var total = state.order.length;
    els.stepIndicator.textContent = (state.currentStep >= 0 ? state.currentStep + 1 : '–') + ' / ' + total;
    var items = els.orderList.querySelectorAll('.node-item');
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('current', Number(items[i].dataset.step) === state.currentStep);
    }
    els.prevBtn.disabled = total === 0;
    els.nextBtn.disabled = total === 0;
  }

  /* ---------------- 基线对比面板 ---------------- */

  var STATUS_TAGS = {
    ordered: '进入顺序',
    excluded: '被排除',
    programmatic: '仅脚本可聚焦',
    'not-focusable': '非候选'
  };
  function statusTag(s) { return STATUS_TAGS[s] || (s == null ? '未知' : String(s)); }

  function diffRow(kind, titleHtml, nodeForHighlight, selectorText) {
    var li = document.createElement('li');
    li.className = 'diff-row ' + kind;
    var btn = document.createElement(nodeForHighlight ? 'button' : 'div');
    btn.type = nodeForHighlight ? 'button' : '';
    btn.className = 'node-item';

    var head = document.createElement('span');
    var tagEl = document.createElement('span');
    tagEl.className = 'diff-badge ' + kind;
    tagEl.textContent = DIFF_LABELS[kind] || kind;
    head.appendChild(tagEl);
    head.appendChild(document.createTextNode(' ' + titleHtml));
    btn.appendChild(head);

    if (selectorText) {
      var sel = document.createElement('span');
      sel.className = 'sel';
      sel.textContent = selectorText;
      btn.appendChild(sel);
    }
    if (nodeForHighlight) {
      btn.addEventListener('click', function () { highlightDiffSelector(nodeForHighlight); });
    }
    li.appendChild(btn);
    return li;
  }

  function renderBaselinePanel() {
    els.baselineList.innerHTML = '';
    var diff = state.diff;

    if (!state.baseline) {
      els.baselineMetaText.textContent =
        '尚未钉入基线。分析完成后点击右上「📌 钉为基线」，此后每次重算都会与之对比。';
      els.clearBaselineBtn.hidden = true;
      els.baselineCount.textContent = '0';
      var empty = document.createElement('li');
      empty.className = 'empty-tip';
      empty.textContent = '无基线。';
      els.baselineList.appendChild(empty);
      return;
    }

    var bl = state.baseline;
    var pinned = new Date(bl.pinnedAt);
    els.baselineMetaText.textContent =
      '基线钉于 ' + pinned.toLocaleString() +
      '（HTML#' + bl.htmlHash + ' / ' + bl.htmlLength + ' 字符，CSS#' + bl.cssHash + ' / ' + bl.cssLength +
      ' 字符，' + bl.nodes.length + ' 个候选节点，其中 ' +
      (bl.stats ? bl.stats.ordered : '?') + ' 个进入 Tab 顺序）';
    els.clearBaselineBtn.hidden = false;

    if (!diff) {
      els.baselineCount.textContent = '0';
      var loading = document.createElement('li');
      loading.className = 'empty-tip';
      loading.textContent = '等待对比结果…';
      els.baselineList.appendChild(loading);
      return;
    }

    var s = diff.summary;
    var totalFlags = s.added + s.removed + s.moved + s.statusChanged + s.ambiguous;
    els.baselineCount.textContent = String(totalFlags);

    // 汇总条
    var sum = document.createElement('li');
    sum.className = 'diff-summary';
    sum.textContent =
      '高置信匹配 ' + s.matchedHigh + ' / 低置信 ' + s.matchedLow +
      '（id ' + s.methodCounts.id + ' · 指纹 ' + s.methodCounts.fingerprint +
      ' · 路径 ' + s.methodCounts.path + ' · 包裹 ' + s.methodCounts.suffix + '）；' +
      '新增 ' + s.added + '，移除 ' + s.removed + '，移位 ' + s.moved +
      '，状态变化 ' + s.statusChanged + '，未变化 ' + s.unchanged +
      '，歧义 ' + s.ambiguous;
    els.baselineList.appendChild(sum);

    diff.added.forEach(function (n) {
      els.baselineList.appendChild(diffRow(
        'added', n.label + '（' + statusTag(n.status) + (n.step ? '，序号 #' + n.step : '') + '）',
        n.selector, n.selector
      ));
    });

    diff.removed.forEach(function (n) {
      els.baselineList.appendChild(diffRow(
        'removed', n.label + '（基线：' + statusTag(n.status) + (n.step ? '，序号 #' + n.step : '') + '）',
        n.selector, n.selector
      ));
    });

    diff.moved.forEach(function (d) {
      els.baselineList.appendChild(diffRow(
        'moved', d.label + '：序号 #' + d.from + ' → #' + d.to,
        d.selector, d.selector
      ));
    });

    diff.statusChanged.forEach(function (d) {
      var extra = d.fromStatus === 'ordered' || d.toStatus === 'ordered'
        ? '（序号 ' + (d.fromStep ? '#' + d.fromStep : '—') + ' → ' + (d.toStep ? '#' + d.toStep : '—') + '）'
        : '';
      els.baselineList.appendChild(diffRow(
        'status', d.label + '：' + d.fromStatusLabel + ' → ' + d.toStatusLabel + extra,
        d.selector, d.selector
      ));
    });

    diff.ambiguous.forEach(function (a) {
      var li;
      if (a.kind === 'ambiguous-pair') {
        li = diffRow(
          'ambiguous',
          '未匹配（配对存疑）：基线 ' + a.baseline.label +
            (a.baseline.step ? ' #' + a.baseline.step : '') +
            ' ↔ 当前 ' + a.current.label + (a.current.step ? ' #' + a.current.step : '') +
            ' — ' + a.reason,
          a.current.selector, a.current.selector
        );
      } else {
        var n = a.node;
        li = diffRow(
          'ambiguous',
          '未匹配（' + (a.side === 'baseline' ? '基线侧' : '当前侧') + '）：' + n.label +
            (n.step ? ' #' + n.step : '') + ' — ' + a.reason,
          a.side === 'current' ? n.selector : null,
          n.selector
        );
      }
      els.baselineList.appendChild(li);
    });

    if (s.unchanged > 0) {
      var ok = document.createElement('li');
      ok.className = 'diff-unchanged';
      ok.textContent = '其余 ' + s.unchanged + ' 个节点匹配且无变化。';
      els.baselineList.appendChild(ok);
    }
  }

  /* ---------------- 步进（Tab / Shift+Tab） ---------------- */

  function stepNext() {
    if (state.order.length === 0) return;
    var next = state.currentStep < 0 ? 0 : (state.currentStep + 1) % state.order.length;
    sendToFrame({ type: 'highlight', step: next });
  }

  function stepPrev() {
    if (state.order.length === 0) return;
    var prev = state.currentStep < 0 ? state.order.length - 1
      : (state.currentStep - 1 + state.order.length) % state.order.length;
    sendToFrame({ type: 'highlight', step: prev });
  }

  els.nextBtn.addEventListener('click', stepNext);
  els.prevBtn.addEventListener('click', stepPrev);

  // “捕获 Tab”按钮：聚焦后按 Tab / Shift+Tab 即步进，不移动真实焦点
  els.captureBtn.addEventListener('keydown', function (ev) {
    if (ev.key === 'Tab') {
      ev.preventDefault();
      if (ev.shiftKey) stepPrev(); else stepNext();
    }
  });
  els.captureBtn.addEventListener('focus', function () {
    els.captureBtn.classList.add('armed');
  });
  els.captureBtn.addEventListener('blur', function () {
    els.captureBtn.classList.remove('armed');
  });

  /* ---------------- 导出 ---------------- */

  function buildReport() {
    return {
      tool: 'focus-route-lab',
      generatedAt: new Date().toISOString(),
      stats: state.stats,
      order: state.order.map(function (selector, i) {
        var e = entryBySelector(selector) || {};
        return {
          step: i + 1,
          selector: selector,
          label: e.label || null,
          tabIndex: e.tabIndex === undefined ? null : e.tabIndex,
          text: e.text || ''
        };
      }),
      nodes: state.entries.map(function (e) {
        return {
          selector: e.selector,
          label: e.label,
          tag: e.tag,
          status: e.status,
          step: e.step,
          tabIndex: e.tabIndex,
          domIndex: e.domIndex,
          uid: e.uid || null,
          fingerprint: e.fingerprint,
          scope: e.scope,
          path: e.path,
          reasons: (e.reasons || []).map(function (r) { return { code: r.code, message: r.message }; }),
          warnings: (e.warnings || []).map(function (w) { return { code: w.code, message: w.message }; })
        };
      }),
      baseline: state.baseline ? {
        pinnedAt: state.baseline.pinnedAt,
        htmlHash: state.baseline.htmlHash,
        cssHash: state.baseline.cssHash,
        htmlLength: state.baseline.htmlLength,
        cssLength: state.baseline.cssLength,
        stats: state.baseline.stats,
        nodeCount: state.baseline.nodes.length,
        nodes: state.baseline.nodes
      } : null,
      baselineComparison: state.diff ? {
        summary: state.diff.summary,
        matches: state.diff.matches,
        diff: {
          added: state.diff.added,
          removed: state.diff.removed,
          moved: state.diff.moved,
          statusChanged: state.diff.statusChanged,
          ambiguous: state.diff.ambiguous
        }
      } : null,
      diagnostics: state.diagnostics
    };
  }

  els.exportBtn.addEventListener('click', function () {
    var report = buildReport();
    // 优先走服务端导出接口；失败时退化为浏览器本地下载
    fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report)
    }).then(function (res) {
      if (!res.ok) throw new Error('export failed: ' + res.status);
      return res.blob();
    }).catch(function () {
      return new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    }).then(function (blob) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'focus-route-report.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    });
  });

  /* ---------------- 标签页切换 ---------------- */

  function switchTab(which) {
    var isOrder = which === 'order';
    var isExcluded = which === 'excluded';
    var isBaseline = which === 'baseline';
    els.tabOrder.classList.toggle('active', isOrder);
    els.tabExcluded.classList.toggle('active', isExcluded);
    els.tabBaseline.classList.toggle('active', isBaseline);
    els.tabOrder.setAttribute('aria-selected', String(isOrder));
    els.tabExcluded.setAttribute('aria-selected', String(isExcluded));
    els.tabBaseline.setAttribute('aria-selected', String(isBaseline));
    els.orderList.hidden = !isOrder;
    els.excludedPanel.hidden = !isExcluded;
    els.baselinePanel.hidden = !isBaseline;
  }
  els.tabOrder.addEventListener('click', function () { switchTab('order'); });
  els.tabExcluded.addEventListener('click', function () { switchTab('excluded'); });
  els.tabBaseline.addEventListener('click', function () { switchTab('baseline'); });

  els.pinBtn.addEventListener('click', pinBaseline);
  els.clearBaselineBtn.addEventListener('click', clearBaseline);

  /* ---------------- 启动 ---------------- */

  els.applyBtn.addEventListener('click', applyAndRecompute);
  els.html.addEventListener('input', scheduleApply);
  els.css.addEventListener('input', scheduleApply);

  els.html.value = SAMPLE_HTML;
  els.css.value = SAMPLE_CSS;

  fetch('/analyzer.js')
    .then(function (res) {
      if (!res.ok) throw new Error('analyzer.js 加载失败');
      return res.text();
    })
    .then(function (src) {
      state.analyzerSrc = src;
      applyAndRecompute();
    })
    .catch(function (err) {
      setStatus(String(err.message || err), 'err');
    });
})();
