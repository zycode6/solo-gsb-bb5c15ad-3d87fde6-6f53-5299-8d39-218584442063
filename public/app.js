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
    tabOrder: document.getElementById('tab-order'),
    tabExcluded: document.getElementById('tab-excluded'),
    orderList: document.getElementById('order-list'),
    orderCount: document.getElementById('order-count'),
    excludedPanel: document.getElementById('excluded-panel'),
    excludedList: document.getElementById('excluded-list'),
    excludedCount: document.getElementById('excluded-count'),
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
    routeTimer: null     // 路线响应超时计时器
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
    renderResults();
    setStatus('已计算：' + state.order.length + ' 个可聚焦节点', 'ok');

    // 按稳定选择器恢复编辑前的位置
    if (state.restoreSelector) {
      var idx = state.order.indexOf(state.restoreSelector);
      if (idx >= 0) {
        els.restoreHint.textContent = '已按稳定选择器恢复到位置 ' + (idx + 1) + '：' + state.restoreSelector;
        sendToFrame({ type: 'highlight', step: idx });
      } else {
        els.restoreHint.textContent = '原节点（' + state.restoreSelector + '）已不在 Tab 顺序中，未恢复。';
        updateStepUI();
      }
      state.restoreSelector = null;
    } else {
      updateStepUI();
    }
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

  function renderResults() {
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
      btn.className = 'node-item';
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
      box.className = 'node-item';

      var title = document.createElement('span');
      title.textContent = e.label + ' ';
      var tag = document.createElement('span');
      tag.className = 'badge';
      tag.textContent = e.status === 'programmatic' ? 'tabindex<0' :
        (e.status === 'excluded' ? '已排除' : '提示');
      title.appendChild(tag);
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
          reasons: (e.reasons || []).map(function (r) { return { code: r.code, message: r.message }; }),
          warnings: (e.warnings || []).map(function (w) { return { code: w.code, message: w.message }; })
        };
      }),
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
    els.tabOrder.classList.toggle('active', isOrder);
    els.tabExcluded.classList.toggle('active', !isOrder);
    els.tabOrder.setAttribute('aria-selected', String(isOrder));
    els.tabExcluded.setAttribute('aria-selected', String(!isOrder));
    els.orderList.hidden = !isOrder;
    els.excludedPanel.hidden = isOrder;
  }
  els.tabOrder.addEventListener('click', function () { switchTab('order'); });
  els.tabExcluded.addEventListener('click', function () { switchTab('excluded'); });

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
