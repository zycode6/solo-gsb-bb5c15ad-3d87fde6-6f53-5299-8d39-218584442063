'use strict';

/**
 * diff.js 纯函数单元测试（Node 环境，无 DOM）。
 * 运行：npm test
 */

const assert = require('assert');
const { computeBaselineDiff, _isSuffixPath } = require('../public/diff.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    console.error('  ✗ ' + name);
    console.error(err);
    process.exitCode = 1;
  }
}

/**
 * 构造节点描述。
 * @param {string} id 唯一 id（'' 表示无 id）
 * @param {string} tag 标签
 * @param {number} [idx] 在同 tag 兄弟中的序号（拼到 path）
 * @param {object} [opt] {scope, fp, status, step, parent}
 */
function n(id, tag, idx, opt) {
  opt = opt || {};
  const parent = opt.parent !== undefined ? opt.parent : 'html/body';
  return {
    selector: id ? '#' + id : (parent ? parent + '/' : '') + tag + ':' + (idx || 1),
    label: tag + (id ? '#' + id : ''),
    tag: tag,
    status: opt.status || 'ordered',
    step: opt.step === undefined ? null : opt.step,
    uid: id || null,
    fingerprint: opt.fp !== undefined ? opt.fp : 'tag=' + tag + '|text=' + (id || tag + idx),
    scope: opt.scope || '',
    path: (parent ? parent + '/' : '') + tag + ':' + (idx || 1),
    text: opt.text || ''
  };
}

function withSteps(nodes) {
  return nodes.map((x, i) => Object.assign({}, x, { step: i + 1 }));
}

function ids(list) { return list.map(x => x.selector); }

console.log('isSuffixPath（包裹层增删）');
test('公共尾部（≥2 段）即视为包裹层增删', () => {
  assert.strictEqual(_isSuffixPath('html/body/section:1/button:1', 'html/body/div:1/section:1/button:1'), true);
  assert.strictEqual(_isSuffixPath('html/body/form:1/section:1/button:1', 'html/body/div:1/form:1/section:1/button:1'), true);
  assert.strictEqual(_isSuffixPath('html/body/section:1/button:1', 'html/body/section:1/button:1'), false);
  // 仅叶子 1 段相同：与「替换为同指纹节点」不可区分，不算 suffix
  assert.strictEqual(_isSuffixPath('html/body/button:1', 'html/body/div:1/button:1'), false);
  assert.strictEqual(_isSuffixPath('html/body/a:1', 'html/body/a:2'), false);
});

console.log('阶段1：唯一 id');
test('头部插入兄弟：id 节点全部高置信匹配且识别为移位，新节点为新增', () => {
  const base = withSteps([n('a', 'button'), n('b', 'a'), n('c', 'input')]);
  const cur = [
    n('', 'button', 1, { fp: 'tag=button|text=new', step: 1 }),
    Object.assign({}, n('a', 'button', 2), { step: 2 }),
    Object.assign({}, n('b', 'a', 2), { step: 3 }),
    Object.assign({}, n('c', 'input', 2), { step: 4 })
  ];
  const d = computeBaselineDiff(base, cur);
  assert.strictEqual(d.summary.matchedHigh, 3);
  assert.strictEqual(d.summary.added, 1);
  assert.strictEqual(d.summary.ambiguous, 0);
  assert.deepStrictEqual(ids(d.added), ['html/body/button:1']);
  assert.deepStrictEqual(d.moved.map(m => [m.from, m.to]), [[1, 2], [2, 3], [3, 4]]);
});

test('id 一致、tabindex 次序调整：识别为移位而非换节点', () => {
  const base = [
    Object.assign({}, n('x', 'button', 1), { step: 1 }),
    Object.assign({}, n('y', 'button', 1), { step: 2 })
  ];
  const cur = [
    Object.assign({}, n('y', 'button', 1), { step: 1 }),
    Object.assign({}, n('x', 'button', 1), { step: 2 })
  ];
  const d = computeBaselineDiff(base, cur);
  assert.strictEqual(d.summary.matchedHigh, 2);
  assert.strictEqual(d.summary.added, 0);
  assert.strictEqual(d.summary.removed, 0);
  assert.ok(d.moved.some(m => m.selector === '#x' && m.from === 1 && m.to === 2));
  assert.ok(d.moved.some(m => m.selector === '#y' && m.from === 2 && m.to === 1));
});

test('重复 id 不可靠：不参与 id 匹配，改用 scope+指纹 1:1', () => {
  const base = withSteps([n('dup', 'button', 1, { scope: 's1' }), n('dup', 'button', 1, { scope: 's2' })]);
  const cur = withSteps([n('dup', 'button', 1, { scope: 's1' }), n('dup', 'button', 1, { scope: 's2' })]);
  const d = computeBaselineDiff(base, cur);
  assert.strictEqual(d.summary.methodCounts.id, 0);
  assert.strictEqual(d.summary.methodCounts.fingerprint, 2);
  assert.strictEqual(d.summary.added, 0);
  assert.strictEqual(d.summary.removed, 0);
  assert.strictEqual(d.summary.ambiguous, 0);
});

console.log('阶段2：指纹 + 结构路径');
test('无 id 同指纹兄弟数量相等、路径一致 → 高置信 path 匹配', () => {
  const fp = 'tag=button|text=same';
  const base = withSteps([n('', 'button', 1, { fp }), n('', 'button', 2, { fp })]);
  const cur = withSteps([
    n('', 'button', 1, { fp, step: 1 }),
    n('', 'button', 2, { fp, step: 2 })
  ]);
  const d = computeBaselineDiff(base, cur);
  assert.strictEqual(d.summary.methodCounts.path, 2);
  assert.strictEqual(d.summary.matchedHigh, 2);
  assert.strictEqual(d.summary.ambiguous, 0);
});

test('无 id 尾部追加同指纹兄弟：与头部插入不可区分 → 全部标记歧义，不误判新增+移位', () => {
  const fp = 'tag=button|text=same';
  const base = withSteps([n('', 'button', 1, { fp }), n('', 'button', 2, { fp })]);
  const cur = withSteps([
    n('', 'button', 1, { fp, step: 1 }),
    n('', 'button', 2, { fp, step: 2 }),
    n('', 'button', 3, { fp, step: 3 })
  ]);
  const d = computeBaselineDiff(base, cur);
  assert.strictEqual(d.summary.matchedHigh, 0);
  assert.strictEqual(d.summary.matchedLow, 2);
  assert.strictEqual(d.summary.added, 0);
  assert.strictEqual(d.summary.removed, 0);
  assert.strictEqual(d.summary.moved, 0);
  assert.strictEqual(d.summary.ambiguous, 3); // 2 个存疑配对 + 1 个落单节点
  assert.ok(d.ambiguous.every(a => /无法|不可|区分|判定/.test(a.reason)));
});

test('无 id 头部插入同指纹兄弟（旧序号整体后移）→ 歧义', () => {
  const fp = 'tag=button|text=same';
  const base = [
    Object.assign({}, n('', 'button', 1, { fp }), { step: 1 }),
    Object.assign({}, n('', 'button', 2, { fp }), { step: 2 })
  ];
  const cur = [
    Object.assign({}, n('', 'button', 1, { fp }), { step: 1 }), // 新节点占据 :1
    Object.assign({}, n('', 'button', 2, { fp }), { step: 2 }),
    Object.assign({}, n('', 'button', 3, { fp }), { step: 3 })
  ];
  const d = computeBaselineDiff(base, cur);
  assert.strictEqual(d.summary.matchedHigh, 0);
  assert.strictEqual(d.summary.added, 0);
  assert.strictEqual(d.summary.removed, 0);
  assert.strictEqual(d.summary.moved, 0);
  assert.strictEqual(d.summary.ambiguous, 3);
});

test('中间删除同指纹兄弟：无法确定删了谁 → 歧义，绝不误报移除+移位', () => {
  const fp = 'tag=button|text=same';
  const base = withSteps([
    n('', 'button', 1, { fp }), n('', 'button', 2, { fp }), n('', 'button', 3, { fp })
  ]);
  const cur = withSteps([
    n('', 'button', 1, { fp, step: 1 }), n('', 'button', 2, { fp, step: 2 })
  ]);
  const d = computeBaselineDiff(base, cur);
  assert.strictEqual(d.summary.matchedHigh, 0);
  assert.strictEqual(d.summary.added, 0);
  assert.strictEqual(d.summary.removed, 0);
  assert.strictEqual(d.summary.moved, 0);
  assert.strictEqual(d.summary.ambiguous, 3);
});

test('不同指纹的新节点：头部插入也能高置信判定新增，旧节点按路径匹配并识别移位', () => {
  const base = withSteps([
    n('', 'a', 1, { fp: 'tag=a|text=old' }),
    n('', 'a', 2, { fp: 'tag=a|text=old2' })
  ]);
  const cur = withSteps([
    n('', 'button', 1, { fp: 'tag=button|text=new', step: 1 }),
    n('', 'a', 1, { fp: 'tag=a|text=old', step: 2 }),
    n('', 'a', 2, { fp: 'tag=a|text=old2', step: 3 })
  ]);
  const d = computeBaselineDiff(base, cur);
  assert.strictEqual(d.summary.added, 1);
  assert.strictEqual(d.summary.removed, 0);
  assert.strictEqual(d.summary.ambiguous, 0);
  assert.strictEqual(d.summary.matchedHigh, 2);
  assert.deepStrictEqual(d.moved.map(m => m.to).sort((a, b) => a - b), [2, 3]);
});

test('指纹唯一的节点跨 scope 移动：保守标记歧义', () => {
  const base = [Object.assign({}, n('', 'button', 1, { scope: 's1', fp: 'fpx' }), { step: 1 })];
  const cur = [Object.assign({}, n('', 'button', 1, { scope: 's2', fp: 'fpx' }), { step: 1 })];
  const d = computeBaselineDiff(base, cur);
  assert.strictEqual(d.summary.matchedHigh, 0);
  assert.strictEqual(d.summary.ambiguous, 2); // 一对存疑配对
});

console.log('包裹层增删（suffix）');
test('有 id 节点被额外包裹：id 直接匹配', () => {
  const base = withSteps([n('a', 'button', 1)]);
  const cur = withSteps([
    n('a', 'button', 1, { parent: 'html/body/div:1/section:1', step: 1 })
  ]);
  const d = computeBaselineDiff(base, cur);
  assert.strictEqual(d.summary.methodCounts.id, 1);
  assert.strictEqual(d.summary.matchedHigh, 1);
});

test('整段容器被包裹：公共尾部 ≥2 段，后缀匹配命中', () => {
  const fp = 'tag=button|text=x';
  const base = withSteps([
    n('', 'button', 1, { fp, parent: 'html/body/section:1' })
  ]);
  const cur = withSteps([
    n('', 'button', 1, { fp, parent: 'html/body/div:1/section:1', step: 1 })
  ]);
  const d = computeBaselineDiff(base, cur);
  assert.strictEqual(d.summary.methodCounts.suffix, 1);
  assert.strictEqual(d.summary.matchedHigh, 1);
  assert.strictEqual(d.summary.ambiguous, 0);
});

test('叶子被直接包裹（仅 1 段相同）：退回指纹 1:1 匹配', () => {
  const fp = 'tag=button|text=x';
  const base = withSteps([n('', 'button', 1, { fp })]);
  const cur = withSteps([
    n('', 'button', 1, { fp, parent: 'html/body/div:1', step: 1 })
  ]);
  const d = computeBaselineDiff(base, cur);
  assert.strictEqual(d.summary.methodCounts.suffix, 0);
  assert.strictEqual(d.summary.methodCounts.fingerprint, 1);
  assert.strictEqual(d.summary.matchedHigh, 1);
});

console.log('状态变化');
test('同一节点从「进入顺序」变为「被排除」', () => {
  const base = [Object.assign({}, n('x', 'input', 1), { status: 'ordered', step: 3 })];
  const cur = [Object.assign({}, n('x', 'input', 1), { status: 'excluded', step: null })];
  const d = computeBaselineDiff(base, cur);
  assert.strictEqual(d.summary.statusChanged, 1);
  assert.strictEqual(d.statusChanged[0].fromStatus, 'ordered');
  assert.strictEqual(d.statusChanged[0].toStatus, 'excluded');
  assert.strictEqual(d.statusChanged[0].fromStep, 3);
  assert.strictEqual(d.statusChanged[0].toStep, null);
  assert.strictEqual(d.summary.moved, 0);
});

test('被排除 → 进入顺序（启用 disabled 按钮）', () => {
  const base = [Object.assign({}, n('x', 'button', 1), { status: 'excluded', step: null })];
  const cur = [Object.assign({}, n('x', 'button', 1), { status: 'ordered', step: 2 })];
  const d = computeBaselineDiff(base, cur);
  assert.strictEqual(d.summary.statusChanged, 1);
  assert.strictEqual(d.statusChanged[0].fromStatusLabel, '被排除');
  assert.strictEqual(d.statusChanged[0].toStatusLabel, '进入顺序');
});

test('被排除 → 仍被排除（原因变化）不算状态变化', () => {
  const base = [Object.assign({}, n('x', 'button', 1), { status: 'excluded', step: null })];
  const cur = [Object.assign({}, n('x', 'button', 1), { status: 'excluded', step: null })];
  const d = computeBaselineDiff(base, cur);
  assert.strictEqual(d.summary.statusChanged, 0);
  assert.strictEqual(d.summary.unchanged, 1);
});

console.log('移除 / 无变化 / 汇总');
test('高置信匹配的节点消失：移除', () => {
  const base = withSteps([n('a', 'button'), n('b', 'a')]);
  const cur = withSteps([n('a', 'button')]);
  const d = computeBaselineDiff(base, cur);
  assert.deepStrictEqual(ids(d.removed), ['#b']);
  assert.strictEqual(d.summary.removed, 1);
  assert.strictEqual(d.summary.unchanged, 1);
});

test('完全一致：无新增/移除/移位/歧义', () => {
  const base = withSteps([n('a', 'button'), n('b', 'a')]);
  const cur = withSteps([n('a', 'button'), n('b', 'a')]);
  const d = computeBaselineDiff(base, cur);
  assert.strictEqual(d.summary.changes, 0);
  assert.strictEqual(d.summary.ambiguous, 0);
  assert.strictEqual(d.summary.unchanged, 2);
});

test('空基线 / 空当前', () => {
  const onlyCur = computeBaselineDiff([], withSteps([n('a', 'button')]));
  assert.strictEqual(onlyCur.summary.added, 1);
  const onlyBase = computeBaselineDiff(withSteps([n('a', 'button')]), []);
  assert.strictEqual(onlyBase.summary.removed, 1);
  const bothEmpty = computeBaselineDiff([], []);
  assert.strictEqual(bothEmpty.summary.changes, 0);
});

test('methodCounts 与置信计数自洽', () => {
  const base = withSteps([n('a', 'button')]);
  const cur = withSteps([n('a', 'button')]);
  const d = computeBaselineDiff(base, cur);
  const s = d.summary;
  assert.strictEqual(s.matchedHigh + s.matchedLow, s.matched);
  const totalMethods = s.methodCounts.id + s.methodCounts.fingerprint +
    s.methodCounts.path + s.methodCounts.suffix + s.methodCounts.rank;
  assert.strictEqual(totalMethods, s.matched);
});

console.log('\n' + passed + ' 个断言组通过' + (process.exitCode ? '（存在失败）' : ''));
