# 键盘焦点路线实验室（Focus Route Lab）

粘贴 HTML 与 CSS，在**剥离用户脚本**、**禁止同源权限**的 sandbox iframe 中预览；
系统依据 `tabindex`、`disabled`、`hidden`、`inert`、计算样式（`display` / `visibility`）与
DOM 嵌套（`details`、`fieldset[disabled]` 等）推导 **Tab / Shift+Tab 焦点顺序**，
逐步高亮节点，并解释元素被排除或顺序异常的原因。编辑内容后按**稳定选择器**恢复当前位置并重算路线，
可一键导出「节点 / 顺序 / 诊断」JSON 报告。

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
npm test           # 焦点顺序核心算法单元测试
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
- **导出 JSON**：`POST /api/export` 返回 `Content-Disposition: attachment` 的报告文件；
  接口不可用时退化为浏览器本地下载。

## 架构

```
server.js                 Express：静态托管 + /api/health + /api/export
public/index.html         应用外壳（编辑器 / 预览 / 结果三栏）
public/app.js             父页面：净化、srcdoc 装配、postMessage 通信、渲染、导出
public/analyzer.js        注入 sandbox iframe：焦点模型计算、诊断、高亮绘制
test/analyzer.test.js     纯函数单元测试（tabindex 解析 / 排序 / 诊断）
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
| `POST` | `/api/export` | 请求体为报告 JSON，响应为同名 JSON 附件下载 |
