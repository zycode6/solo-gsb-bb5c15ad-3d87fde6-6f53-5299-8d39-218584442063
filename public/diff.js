/*
 * diff.js —— 基线对比引擎（纯函数，无 DOM 依赖）
 *
 * 可在 Node 下单测（module.exports），浏览器中通过 <script> 直接引入
 * （挂载为 window.FocusDiff）。
 *
 * 匹配模型：
 *  节点身份不是单一的 nth-of-type 序号（兄弟节点插入会导致序号整体平移、
 *  全量误判），而是由 analyzer.js 预先计算的四元组：
 *    - uid：文档内唯一的 #id（重复 id 不可靠，返回 null）
 *    - fingerprint：标签 + 语义属性 + class + 归一化文本
 *    - scope：祖先 id 链，圈定「同指纹节点」的比较范围
 *    - path：tag:nth-of-type 完整结构路径（仅作组内决胜，不单独定身份）
 *
 * 分级匹配：
 *  1. 双方均只出现一次的 uid 直接 1:1（method='id'，高置信）；
 *  2. 剩余节点按 scope + fingerprint 分组：
 *     - 结构路径互为后缀（中间插入/删除包裹层）且候选互唯一 → suffix（高）；
 *     - 组内双方各剩 1 个 → fingerprint（高）；
 *     - 路径完全一致：组内数量相等且全部对上 → path（高）；
 *       数量不等时，仅当多出的节点都位于同级兄弟序列「尾部」
 *       （既有节点 nth-of-type 索引不变）才采信，否则整体降级；
 *  3. 无法唯一决胜 → rank 低置信配对，并在 ambiguous 中显式标记；
 *     落单节点：另一侧任何位置都不存在同指纹节点才判为新增/移除，
 *     否则同样标记歧义，绝不靠猜测定性。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.FocusDiff = factory();
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var STATUS_LABELS = {
    ordered: '进入顺序',
    excluded: '被排除',
    programmatic: '仅脚本可聚焦',
    'not-focusable': '非候选'
  };

  var REASON_RANK = '同组内存在多个指纹相同的节点，且缺少唯一 id 或可区分的结构路径；' +
    '兄弟节点插入 / 置换后无法可靠判定对应关系';
  var REASON_EXTRA = '存在指纹相同的其他候选且缺少稳定 id，' +
    '无法判断该节点是新增 / 移除，还是既有节点发生了移位';

  function statusLabel(status) {
    return STATUS_LABELS[status] || (status == null ? '未知' : String(status));
  }

  /** 压缩为可放进结果 / 导出 JSON 的最小节点描述 */
  function mini(n) {
    return {
      selector: n.selector,
      label: n.label,
      tag: n.tag,
      status: n.status,
      step: n.step == null ? null : n.step,
      text: n.text || ''
    };
  }

  function groupKey(n) {
    return (n.scope || '') + '' + (n.fingerprint || '');
  }

  function splitPath(p) {
    return p ? String(p).split('/') : [];
  }

  /**
   * 两条结构路径是否「结构后缀」关系：存在长度 ≥2 的公共尾部，且不是完全相同路径。
   * 对应在公共尾部之上的任意位置插入 / 删除包裹层——插入点上方的段不必相同
   * （例如 body 下直接的 section 被包进 body > div > section）。
   * 公共尾部仅 1 段（叶子自身被直接包裹）与「替换为同指纹节点」不可区分，
   * 那种情况交给指纹 1:1 阶段，此处不采信。
   */
  function isSuffixPath(pa, pb) {
    var a = splitPath(pa);
    var b = splitPath(pb);
    if (a.length === 0 || b.length === 0 || a.length === b.length) return false;
    var common = 0;
    var i = a.length - 1;
    var j = b.length - 1;
    while (i >= 0 && j >= 0 && a[i] === b[j]) {
      common++;
      i--;
      j--;
    }
    return common >= 2;
  }

  function removeNode(arr, n) {
    var i = arr.indexOf(n);
    if (i >= 0) arr.splice(i, 1);
  }

  /**
   * 反复挑选「双方候选都互唯一」的配对，直到没有进展为止。
   * 任何一边出现多候选都留给后续（更保守的）阶段处理。
   */
  function mutualUniquePairs(bs, cs, test) {
    var pairs = [];
    var usedB = {}, usedC = {};
    var progressed = true;
    while (progressed) {
      progressed = false;
      for (var i = 0; i < bs.length; i++) {
        if (usedB[i]) continue;
        var cands = [];
        for (var j = 0; j < cs.length; j++) {
          if (!usedC[j] && test(bs[i], cs[j])) cands.push(j);
        }
        if (cands.length !== 1) continue;
        var jOnly = cands[0];
        var back = [];
        for (var k = 0; k < bs.length; k++) {
          if (!usedB[k] && test(bs[k], cs[jOnly])) back.push(k);
        }
        if (back.length !== 1) continue;
        usedB[i] = true;
        usedC[jOnly] = true;
        pairs.push([bs[i], cs[jOnly]]);
        progressed = true;
      }
    }
    return pairs;
  }

  /**
   * 结构路径完全一致时的判定：
   *  - 双方数量相等且全部对上 → 高置信（同指纹节点集合与次序都未变；
   *    即便内容发生交换，在无 id 时也不可观测，按未变化处理）；
   *  - 数量不等：路径 :1/:2 保持不变既可能是「尾部增删」，也可能是
   *    「头部 / 中间增删 + 其余平移」，两种假设同样成立 → 不在此处定性，
   *    返回 false 由调用方整体降级为歧义，绝不靠猜测定新增 / 移除 / 移位。
   */
  function pairByExactPathIfBalanced(bun, cun, commit) {
    var cByPath = {};
    cun.forEach(function (c) { cByPath[c.path || ''] = c; }); // 完整路径在单文档内唯一
    var exact = [];
    bun.forEach(function (b) {
      var c = cByPath[b.path || ''];
      if (c) exact.push([b, c]);
    });
    var exB = bun.filter(function (b) { return !exact.some(function (p) { return p[0] === b; }); });
    var exC = cun.filter(function (c) { return !exact.some(function (p) { return p[1] === c; }); });

    if (exB.length === 0 && exC.length === 0 && exact.length > 0) {
      exact.forEach(function (p) { commit(p[0], p[1], 'path', 'high'); });
      return true;
    }
    return false;
  }

  function countByStatus(nodes) {
    var r = { total: nodes.length, ordered: 0, excluded: 0, programmatic: 0, other: 0 };
    nodes.forEach(function (n) {
      if (n.status === 'ordered' || n.status === 'excluded' || n.status === 'programmatic') {
        r[n.status]++;
      } else {
        r.other++;
      }
    });
    return r;
  }

  /**
   * 对比基线与当前两组节点描述。
   * @param {Array} baselineNodes 钉基线时的节点（含 uid/fingerprint/scope/path/step/status）
   * @param {Array} currentNodes 当前重算的节点
   * @returns {Object} summary + matches + added/removed/moved/statusChanged/ambiguous
   */
  function computeBaselineDiff(baselineNodes, currentNodes) {
    var B = (baselineNodes || []).slice();
    var C = (currentNodes || []).slice();

    var matched = [];      // {b,c,method,confidence}
    var ambigPairs = [];   // {b,c,reason}
    var ambigNodes = [];   // {side,node,reason}
    var unmatchedB = [];
    var unmatchedC = [];

    function commitPair(b, c, method, confidence) {
      matched.push({ b: b, c: c, method: method, confidence: confidence });
      removeNode(B, b);
      removeNode(C, c);
    }
    function commitAmbigPair(b, c, reason) {
      matched.push({ b: b, c: c, method: 'rank', confidence: 'low' });
      ambigPairs.push({ b: b, c: c, reason: reason });
      removeNode(B, b);
      removeNode(C, c);
    }
    function commitUnmatched(n, side) {
      (side === 'baseline' ? unmatchedB : unmatchedC).push(n);
      removeNode(side === 'baseline' ? B : C, n);
    }
    function commitAmbigNode(n, side, reason) {
      ambigNodes.push({ side: side, node: n, reason: reason });
      removeNode(side === 'baseline' ? B : C, n);
    }

    /* ---- 阶段 1：唯一 id 1:1 ---- */
    var bUid = {}, cUid = {};
    B.forEach(function (n) { if (n.uid) { (bUid[n.uid] = bUid[n.uid] || []).push(n); } });
    C.forEach(function (n) { if (n.uid) { (cUid[n.uid] = cUid[n.uid] || []).push(n); } });
    Object.keys(bUid).forEach(function (u) {
      var bs = bUid[u];
      var cs = cUid[u];
      if (cs && bs.length === 1 && cs.length === 1) {
        commitPair(bs[0], cs[0], 'id', 'high');
      }
      // id 在任一侧重复（非法/歧义 HTML）→ 不参与 id 匹配，落入指纹分组
    });

    /* 任一侧是否存在某指纹（用于判断落单节点能否被定性为新增/移除） */
    var bFp = {}, cFp = {};
    B.forEach(function (n) { bFp[n.fingerprint] = true; });
    C.forEach(function (n) { cFp[n.fingerprint] = true; });

    /* ---- 阶段 2：scope + 指纹分组 ---- */
    var bGroups = {}, cGroups = {};
    B.forEach(function (n) { var k = groupKey(n); (bGroups[k] = bGroups[k] || []).push(n); });
    C.forEach(function (n) { var k = groupKey(n); (cGroups[k] = cGroups[k] || []).push(n); });
    var allKeys = Object.keys(Object.assign({}, bGroups, cGroups));

    allKeys.forEach(function (k) {
      var bun = (bGroups[k] || []).slice();
      var cun = (cGroups[k] || []).slice();

      // (a) 结构路径存在 ≥2 段公共后缀且互唯一：在公共部分之上插入/删除包裹层
      var suffixPairs = mutualUniquePairs(bun, cun, function (b, c) {
        return isSuffixPath(b.path, c.path);
      });
      suffixPairs.forEach(function (p) {
        removeNode(bun, p[0]);
        removeNode(cun, p[1]);
        commitPair(p[0], p[1], 'suffix', 'high');
      });

      if (bun.length === 0 && cun.length === 0) return;

      // (b) 同组双方各剩一个：指纹在该 scope 内唯一，即为同一节点
      if (bun.length === 1 && cun.length === 1) {
        commitPair(bun[0], cun[0], 'fingerprint', 'high');
        return;
      }

      if (bun.length > 0 && cun.length > 0) {
        // (c) 路径完全一致且数量平衡 → 高置信；数量不平衡（疑似头部/中间增删）→ 歧义
        if (pairByExactPathIfBalanced(bun, cun, commitPair)) return;

        // 无法唯一决胜：顺序配对记为低置信，落单者标记歧义（不臆断新增/移除）
        var pairCount = Math.min(bun.length, cun.length);
        for (var i = 0; i < pairCount; i++) {
          commitAmbigPair(bun[i], cun[i], REASON_RANK);
        }
        bun.slice(pairCount).forEach(function (b) { commitAmbigNode(b, 'baseline', REASON_EXTRA); });
        cun.slice(pairCount).forEach(function (c) { commitAmbigNode(c, 'current', REASON_EXTRA); });
        return;
      }

      // 组只在一侧存在：另一侧任何位置都没有同指纹节点才定性新增/移除
      var fp = (bun[0] || cun[0]).fingerprint;
      if (bun.length === 0) {
        if (!bFp[fp]) cun.forEach(function (c) { commitUnmatched(c, 'current'); });
        else cun.forEach(function (c) { commitAmbigNode(c, 'current', REASON_EXTRA); });
      } else {
        if (!cFp[fp]) bun.forEach(function (b) { commitUnmatched(b, 'baseline'); });
        else bun.forEach(function (b) { commitAmbigNode(b, 'baseline', REASON_EXTRA); });
      }
    });

    /* ---- 汇总差异 ---- */
    var added = unmatchedC.map(mini);
    var removed = unmatchedB.map(mini);
    var moved = [];
    var statusChanged = [];
    var ambiguous = [];
    var matchesOut = [];
    var methodCounts = { id: 0, fingerprint: 0, suffix: 0, path: 0, rank: 0 };
    var highCount = 0;
    var lowCount = 0;
    var unchangedCount = 0;

    matched.forEach(function (m) {
      var rec = {
        method: m.method,
        confidence: m.confidence,
        baseline: mini(m.b),
        current: mini(m.c)
      };
      methodCounts[m.method]++;
      if (m.confidence === 'low') {
        lowCount++;
        rec.kind = 'ambiguous';
      } else {
        highCount++;
        if (m.b.status !== m.c.status) {
          rec.kind = 'status-changed';
          statusChanged.push({
            selector: m.c.selector,
            label: m.c.label,
            fromStatus: m.b.status,
            toStatus: m.c.status,
            fromStatusLabel: statusLabel(m.b.status),
            toStatusLabel: statusLabel(m.c.status),
            fromStep: m.b.step == null ? null : m.b.step,
            toStep: m.c.step == null ? null : m.c.step,
            baseline: mini(m.b),
            current: mini(m.c)
          });
        } else if (m.b.status === 'ordered' && m.b.step !== m.c.step) {
          rec.kind = 'moved';
          moved.push({
            selector: m.c.selector,
            label: m.c.label,
            from: m.b.step,
            to: m.c.step,
            baseline: mini(m.b),
            current: mini(m.c)
          });
        } else {
          rec.kind = 'unchanged';
          unchangedCount++;
        }
      }
      matchesOut.push(rec);
    });

    ambigPairs.forEach(function (a) {
      ambiguous.push({
        kind: 'ambiguous-pair',
        baseline: mini(a.b),
        current: mini(a.c),
        reason: a.reason
      });
    });
    ambigNodes.forEach(function (a) {
      ambiguous.push({
        kind: 'ambiguous-node',
        side: a.side,
        node: mini(a.node),
        reason: a.reason
      });
    });

    var summary = {
      baseline: countByStatus(baselineNodes || []),
      current: countByStatus(currentNodes || []),
      matchedHigh: highCount,
      matchedLow: lowCount,
      matched: highCount + lowCount,
      unchanged: unchangedCount,
      added: added.length,
      removed: removed.length,
      moved: moved.length,
      statusChanged: statusChanged.length,
      ambiguous: ambiguous.length,
      methodCounts: methodCounts
    };
    summary.changes = summary.added + summary.removed + summary.moved + summary.statusChanged;

    return {
      summary: summary,
      matches: matchesOut,
      added: added,
      removed: removed,
      moved: moved,
      statusChanged: statusChanged,
      ambiguous: ambiguous
    };
  }

  return {
    computeBaselineDiff: computeBaselineDiff,
    statusLabel: statusLabel,
    STATUS_LABELS: STATUS_LABELS,
    // 导出供测试
    _isSuffixPath: isSuffixPath
  };
});
