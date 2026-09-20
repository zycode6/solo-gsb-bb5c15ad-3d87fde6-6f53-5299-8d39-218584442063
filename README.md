# 键盘焦点路线实验室（Focus Route Lab）

粘贴 HTML 与 CSS，在**剥离用户脚本**、**禁止同源权限**的 sandbox iframe 中预览；
系统依据 `tabindex`、`disabled`、`hidden`、`inert`、计算样式（`display` / `visibility`）与
DOM 嵌套（`details`、`fieldset[disabled]` 等）推导 **Tab / Shift+Tab 焦点顺序**，
逐步高亮节点，并解释元素被排除或顺序异常的原因。编辑内容后按**稳定选择器**恢复当前位置并重算路线，
可把某次分析**钉为基线**，后续重算自动按**稳定节点身份**（唯一 id + 结构/属性指纹）对比路线，
展示新增 / 移除 / 移位（含前后序号）/ 状态切换与无法可靠匹配的歧义项；
还可一键导出「节点 / 顺序 / 诊断 / 基线对比」JSON 报告。

## 快速开始（Docker）

```bash
docker compose up --build
```

然后访问：**http://localhost:3000**

### 配置项

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 容器内服务监听端口（在 `docker-compose.yml` 的 `environment` 中修改，并同步调整 `ports` 映射） |
| `HOST` | `0.0.0.0` | 监听地址 |

修改宿主机端口映射示例：`ports: ["8080:3000"]` 后访问 http://localhost:8080 。

## 本地开发（不用 Docker）

```bash
npm install
npm start          # http://localhost:3000
npm test           # 焦点顺序核心算法 + 基线对比匹配引擎单元测试
npm run smoke      # 冒烟测试（需服务已启动）
```

## 功能说明

- **输入区**：粘贴 HTML / CSS；开启「自动重算」后编辑即防抖重算，也可点「应用并重算」。
- **预览区**：`sandbox="allow-scripts"`（不含 `allow-same-origin`）的 iframe。
  用户 HTML 先经 DOMParser 净化：移除 `<script>`、`<base>`、`<meta http-equiv>`、
  所有 `on*` 事件属性、`javascript:` / `data:text/html` 链接与 `srcdoc` 属性，
  再注入实验室自身的分析脚本（`public/analyzer.js`）。
- **焦点路线**：按 HTML 顺序聚焦导航模型计算——
  正值 `tabindex` 升序优先（平局按 DOM 序），其余按 DOM 序；
  `tabindex < 0` 仅可编程聚焦，不进入顺序。
- **逐步高亮**：「Tab ⇥ / ⇤ Shift+Tab」按钮，或聚焦「捕获 Tab」按钮后直接按
  `Tab` / `Shift+Tab` 步进；点击顺序列表中的节点亦可定位。
- **排除与诊断**：解释每个候选节点被排除的原因（`disabled`、`hidden`、`inert`、
  `display:none`、`visibility:hidden`、`input[type=hidden]`、闭合 `details`、
  `fieldset[disabled]` 等），并汇总顺序异常（正值 `tabindex`、撞号、
  非交互元素进入 Tab 顺序、`aria-hidden` 内可聚焦等）。
- **位置恢复**：编辑重算后，按当前节点的稳定选择器（唯一 `#id` 或
  `tag:nth-of-type` 路径）在新路线中定位并恢复高亮。
- **基线对比**：
  - 点击结果区右上角 **「📌 钉为基线」** 保存当前全部候选节点（含状态与 Tab 序号）；
    基线只保存在当前页面内存中，刷新页面即清除（可用「清除基线」手动移除）。
  - 此后每次「应用并重算」（或自动重算）都会自动与基线对比，右侧第三个标签页
    **「基线对比」** 展示结果，顺序 / 排除列表的每行也会带颜色徽标。
  - 差异类型：
    - **新增**（绿色）：当前侧出现、基线中没有的节点；
    - **已移除**（红色）：基线中有、当前侧消失的节点；
    - **移位**（蓝色）：同一节点仍在 Tab 顺序中，序号变化，徽标显示 `#旧序号 → #新序号`；
    - **状态变化**（黄色）：在「进入顺序 / 被排除 / 仅脚本可聚焦」之间切换，
      进入或离开顺序时同时给出序号 `#n → —` / `— → #n`；
    - **歧义**（紫色）：无法可靠判定对应关系的节点（见下节），明确标记「未匹配」，绝不臆断。
  - **点击任意差异项**（或带差异徽标的顺序 / 排除行）即在预览 iframe 中高亮对应节点；
    基线侧已删除的节点若当前文档中仍能用选择器定位也会高亮，找不到时给出提示。
    高亮支持被排除 / 仅编程聚焦等不在 Tab 顺序中的节点。
- **稳定身份如何避免误判**：匹配**不只看 `nth-of-type` 序号**——在一排无 id 的相同
  元素前插入一个兄弟，会让后续元素序号整体平移，若只按序号比对会把整排都误报成
  「新增 + 移位」。本工具按优先级匹配：
  1. 文档内**唯一 `#id`**（重复 id 视为不可靠，不参与）→ 最高置信；
  2. 同祖先 id 作用域（scope）内的**结构 / 属性指纹**（标签、`type`/`name`/`role`/
     `href`/`aria-label`/`placeholder` 等语义属性、排序后的 class、归一化文本）；
  3. 结构路径后缀一致（节点被包裹 / 解包，如多了一层 `<div>`）；
  4. 同指纹分组内路径完全一致；`nth-of-type` 仅在这些前提下作决胜。
  当「尾部追加」与「头部插入 + 平移」两种解释同样成立（无 id、指纹又相同）时，
  系统**不猜**：相关节点配对为低置信并列入「歧义」，等待用户为元素补充 `id` 后再判定。
  汇总条会给出各匹配方式（id / 指纹 / 路径 / 包裹）的命中数与高 / 低置信计数。
- **导出 JSON**：`POST /api/export` 返回 `Content-Disposition: attachment` 的报告文件；
  报告包含 `baseline`（基线摘要与快照）与 `baselineComparison`（匹配结果与各类差异）；
  接口不可用时退化为浏览器本地下载。

## 架构

```
server.js                 Express：静态托管 + /api/health + /api/export
public/index.html         应用外壳（编辑器 / 预览 / 结果三栏）
public/app.js             父页面：净化、srcdoc 装配、postMessage 通信、渲染、
                          基线快照、调用 diff 引擎、差异面板与导出
public/analyzer.js        注入 sandbox iframe：焦点模型计算、诊断、
                          稳定身份（uid/指纹/scope/路径）计算、高亮绘制
public/diff.js            基线对比匹配引擎（纯函数，可 Node 单测；浏览器挂为 FocusDiff）
test/analyzer.test.js     analyzer 纯函数单元测试（tabindex 解析 / 排序 / 诊断）
test/diff.test.js         匹配引擎单元测试（id / 指纹 / 路径 / 包裹 / 歧义 / 状态变化）
test/smoke.js             冒烟测试
Dockerfile                node:20-alpine，npm install --omit=dev
docker-compose.yml        单服务，ports 3000:3000
```

### 为什么计算放在 iframe 内？

焦点可聚焦性依赖**计算样式**（`display:none`、`visibility:hidden` 等），
只有真实浏览器引擎结合用户 CSS 才能给出准确结果。分析脚本随 srcdoc 注入
sandbox iframe，在文档加载后计算并通过 `postMessage` 把路线回传父页面；
父页面只接受来自该 iframe `contentWindow` 且带来源标记的消息。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/health` | 健康检查，返回 `{ ok: true, ... }` |
| `POST` | `/api/export` | 请求体为报告 JSON（含 `baseline` / `baselineComparison`），响应为同名 JSON 附件下载 |

## 基线对比操作示例

1. 在输入区粘贴表单 HTML / CSS，等待首次分析完成；
2. 点击右侧结果区 **「📌 钉为基线」**，顶部状态会提示基线节点数；
3. 修改 HTML / CSS，例如：
   - 在表单开头插入一个新链接 → 差异面板出现绿色「新增」，既有 id 节点显示蓝色移位徽标 `#1 → #2`；
   - 给某个按钮加 `disabled` → 该节点出现黄色「进入顺序 → 被排除」；
   - 在一排**没有 id 且内容相同**的按钮中插入新按钮 → 相关节点进入紫色「歧义 / 未匹配」，
     而不是被误报成一串新增和移位；给这些按钮补上唯一 `id` 后重算即可精确对应；
4. 点击任意差异行，预览中对应元素会出现高亮框（被排除节点同样可定位）；
5. 点击「导出 JSON」，报告中的 `baselineComparison.matches` 给出每对匹配的方式
   （`id` / `fingerprint` / `suffix` / `path` / `rank`）与置信度，
   `diff.added` / `removed` / `moved` / `statusChanged` / `ambiguous` 为分类后的差异。
