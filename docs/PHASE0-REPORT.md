# Phase 0 技术验证报告

日期：2026-10-24　环境：macOS 15.0（Apple Silicon）、Electron 44.9.3（Chromium 152、Node 24.22）

## 结论

**Electron 方案可以进入 Phase 1/2。** 多标签 WebContentsView、React 外壳与网页视图协作、会话持久化、扩展加载与 Popup 都已实测可用，并有自动化测试守护。

扩展兼容性达到"日常可用"，但边界很清楚：

- 依赖 tabs、scripting、storage、action、webNavigation、contextMenus、cookies、offscreen、**declarativeNetRequest** 的 MV3 扩展基本可用。
- 依赖 **webRequest 事件**（uBlock Origin MV2、视频嗅探类）、**userScripts**（Tampermonkey）、**sidePanel**、**identity**、**tabCapture/desktopCapture**、**tts**、**tabs.captureVisibleTab** 的扩展，其核心功能不可用。原因是 Electron 没有实现这些 API，属于底层能力限制。
- 广告拦截建议改用 **uBlock Origin Lite**（MV3、基于 DNR）。DNR 的拦截已经实测生效。

这些限制没有动摇整体方案：替换底层引擎（CEF、自编 Chromium）的成本远高于收益。后续可以针对高价值 API 逐个补垫片，例如已经补上的 onInstalled 和 storage.onChanged。

## 技术选型与理由

| 层 | 选择 | 理由 |
|---|---|---|
| 框架 | Electron 44.9.3 | 扩展库上游实测的目标版本。45.0.0 发布才 3 天，暂不跟进 |
| 外壳 UI | React 19 + Zustand + Tailwind v4 | 与需求文档一致。性能瓶颈不在 UI 框架，在视图管理和 IPC |
| 构建 | electron-vite 6 + Vite 8 | main 拆成 2.7 KB 引导入口和懒加载 chunk |
| 数据库 | **`node:sqlite`**（Electron 内置） | 不需要编译原生模块（替代 better-sqlite3），自带 FTS5 |
| 扩展 API 补全 | electron-chrome-extensions 4.9.0 | 社区最完整的 tabs/action/popup 实现。**GPL-3.0**：自用没问题，对外分发须开源 |
| 类型检查 / 测试 | TypeScript 7（原生编译器）、Vitest 5、Playwright 1.64 | |

## 验证项

| 验证项 | 结果 | 证据（测试） |
|---|---|---|
| WebContentsView 多标签原型 | ✅ 3 个 Space × 10 个标签独立切换；同一时刻只挂载一个页面视图 | `tabs.spec.ts` |
| 网页视图与 React 侧边栏交互 | ✅ 布局在 main 同步计算；命令面板由 shell 置顶、透明镂空实现；查找栏是与 shell 同进程的浮层 | `visual.spec.ts`、`keyboard.spec.ts` |
| Session 持久化 | ✅ Space、标签、固定状态、前进/后退栈、设置、侧边栏宽度在重启后恢复；只恢复当前标签（懒加载） | `session.spec.ts` |
| 本地扩展加载 | ✅ 从文件夹导入、启用、禁用、卸载、从源目录更新、重启后恢复，扩展存储保留 | `extensions.spec.ts` |
| MV3 兼容性 | ✅ API 探针 **40/43** 项通过（见下文） | `extensions.spec.ts` + `tests/fixtures/extensions/api-probe` |
| Popup 与标签交互 | ✅ Popup 能正常显示并按内容定尺寸（需要自研修复，见风险 4）；Popup 内 `tabs.query` 能拿到当前标签 | `extensions.spec.ts` |

## MV3 API 探针结果（40/43）

探针扩展（`tests/fixtures/extensions/api-probe`）分别在 Service Worker、Content Script、Popup、Options 页中调用 API，结果自动上报给测试服务器。

| 命名空间 | 通过的检查 |
|---|---|
| runtime | getManifest、id/getURL、**onInstalled**¹、content→SW 消息、**getContexts**¹、getPlatformInfo |
| tabs | SW→content 消息、connect 端口、query、get、create、update（url / active）、remove，以及 onCreated、onUpdated、onActivated、onRemoved 事件 |
| scripting | executeScript、insertCSS、registerContentScripts |
| storage | local、session、sync²、**onChanged**¹ |
| action | setBadgeText/getBadgeText、setTitle/getTitle、setBadgeBackgroundColor |
| webNavigation | onCommitted、onCompleted、getAllFrames |
| 其他 | contextMenus、alarms、cookies、i18n、permissions、windows、notifications、management、SW 跨域 fetch、**declarativeNetRequest 实际拦截**、offscreen |
| ❌ 未通过 | webRequest.onBeforeRequest（事件不触发）、sidePanel、userScripts |

¹ 由本项目的兼容层修复（Electron 原生不支持或会致崩，见风险 2、3）。
² 扩展库把 sync 映射到了 local，数据不会跨设备同步（本项目本来就不做同步）。

## 真实扩展兼容性（你在 Arc 中安装的 24 个）

测试方法：把扩展**复制**到临时目录（不入库，不改动 Arc）→ 逐个装到全新的 profile → 检查后台是否运行、控制台错误、点击工具栏按钮后 Popup 能否渲染及其尺寸，并对部分扩展做功能验证。复现命令见 README。

**等级**：A = 已验证核心功能可用；B = 安装正常、UI 可用，核心功能未逐项验证或存在已知限制；C = 核心功能不可用，或会造成问题。

| 扩展 | 版本 | 等级 | 说明 |
|---|---|---|---|
| JSON Formatter | 0.10.2 | **A** | 功能验证通过（自动格式化 `application/json`） |
| Get QR Code | 1.0 | A | Popup 正常（300×295）；SW 中有一个扩展自身的 `window` 报错 |
| RSSHub Radar | 2.2.0 | A | Popup 正常（350×98） |
| Google Translate | 2.0.18 | B | Popup 正常（420×219）、右键菜单可用；"翻译整页"依赖 activeTab 授权，Electron 不在点击扩展按钮时授予，会报"Cannot access contents of the page" |
| Charset | 1.0.0 | B | 同上，受 activeTab 影响 |
| Tampermonkey | 5.5.1 | **C** | Popup 正常，但用户脚本依赖 `chrome.userScripts`，Electron 未实现，脚本不会运行 |
| React Developer Tools | 8.0.0 | B | Popup 正常；DevTools 面板未验证（Electron 对 DevTools 扩展本身有支持） |
| Wappalyzer | 6.12.7 | B | Popup 正常；依赖 webRequest 响应头的检测项会缺失 |
| uBlock Origin（MV2） | 1.72.2 | **C** | 能加载、Popup 正常（288×140），但**网络拦截和外观过滤都不生效**（webRequest 事件不触发）。替代：uBlock Origin Lite |
| video downloader - CocoCut（MV2） | 3.14 | C | 媒体嗅探依赖 webRequest |
| MetaMask | 13.53 | B | Popup 正常（400×600）、后台运行；有一个 API 缺失报错，转账/签名流程未验证 |
| Bitget Wallet | 2.21.10 | B | Popup 正常；sidePanel 不可用 |
| Suiet | 0.9.0 | B | Popup 正常（362×600） |
| Slush | 26.21.5 | B | Popup 正常 |
| Rainbow | 1.6.13 | B | Popup 正常；有两个扩展自身的报错 |
| OKX Wallet | 4.21.0 | C | 主界面走 sidePanel，Electron 未实现 |
| Phantom | 26.34.0 | C | Popup 空白：依赖 `chrome.identity` |
| ChatGPT | 1.26 | C | 后台启动失败（依赖 debugger、sidePanel 等） |
| DOM TTS Reader | 1.0.2.0 | C | 依赖 `chrome.tts` |
| Take Webpage Screenshots Entirely | 2.1.4.18 | B | Popup 正常；`tabs.captureVisibleTab` 不可用，截图功能大概率失败 |
| V2EX Polish | 2.5.2 | B | Popup 正常；内容脚本未逐项验证 |
| Advanced Font Settings | 0.71 | C | 依赖 `chrome.fontSettings` |
| Awesome Screen Recorder | 4.4.44 | **C（危险）** | 打开其 Popup 会触发 Chromium 断言，**导致整个浏览器崩溃**（录屏链路依赖 tabCapture/desktopCapture）。不要安装 |
| Infinity New Tab | 11.0.41 | — | 按你的要求不适配 |

## 技术风险与解决方案

| # | 风险 / 发现 | 影响 | 解决方案（已实施） |
|---|---|---|---|
| 1 | 扩展库会向 session 的**每个 frame** 注册 preload | 没有扩展时网页也要付出开销 | 只在至少启用一个扩展时才动态导入并实例化该库；有测试守护 |
| 2 | Electron 不触发 `runtime.onInstalled` / `onStartup`；SW 中收不到 `storage.onChanged` | 很多扩展在 onInstalled 里初始化默认值、创建右键菜单，在后台监听设置变化 | 自研兼容层（`src/preload/extension-compat.ts` + `src/main/extensions/compat.ts`）：在 SW 中用模拟事件替换原事件；main 在安装/更新后唤醒 SW 并派发事件；扩展页面的存储写入转发给 SW。onStartup 只唤醒确实注册了监听的扩展，并延迟 3 秒，避免拖慢启动 |
| 3 | `runtime.getContexts` 遇到 Electron 未设置 view type 的 Popup/标签页时触发 Chromium NOTREACHED | 结果漏掉 TAB/POPUP；最坏情况导致浏览器崩溃 | 兼容层接管 `getContexts`，由 main 根据自己跟踪的标签、Popup、SW、离屏文档构造结果 |
| 4 | Electron 44 的 `preferred-size-changed` 不触发，扩展库只在收到该事件后才显示 Popup | **点击扩展按钮没有任何反应** | `popup-fit.ts`：仿 Chrome 的规则，取内容的最小不溢出宽度和该宽度下的高度；流式布局回退到 max-content；显示后再轮询，以适应异步渲染 |
| 5 | 自定义协议在 frame 创建后才注册无效（`ERR_UNKNOWN_URL_SCHEME`） | 扩展按钮图标不显示 | 启动时就注册 `crx:` 处理器（standard + secure），扩展库加载后再委托给它 |
| 6 | 扩展运行时退出，Chromium 关闭阶段会等 2–15 秒 | Cmd+Q 后进程迟迟不退出 | 退出前先结束 SW 保活任务、关闭所有页面、卸载扩展；退出时间回到约 100 ms |
| 7 | 用带 PageState 的历史恢复标签后，在加载中途后退，渲染进程会 SIGSEGV | 休眠或重启后的标签偶发崩溃 | 恢复期间排队浏览器发起的导航，等加载完成再执行；如果仍然崩溃，自动重载一次，不展示崩溃页 |
| 8 | 隐藏窗口不执行 rAF，shell 的"首帧"信号要等兜底计时器 | 启动慢了约 1.5 秒 | 首次渲染用 `flushSync` 同步提交后立即通知 main；兜底计时器从 1.5 秒改为 0.5 秒 |
| 9 | Node 的 WHATWG `URL` 对 `app://` 返回的 origin 是 `"null"` | IPC 来源校验误判 | 改为比较协议和主机 |
| 10 | Web Store 安装的扩展带 `_metadata` 目录，Chromium 拒绝加载未打包扩展中以 `_` 开头的目录 | 直接导入会失败 | 导入时跳过该目录 |
| 11 | Electron 默认 UA 带 `Electron/x` | Google 登录等可能被拦 | 每个 profile session 使用纯 Chrome UA |

## 性能基线

直接启动（不经过 Playwright，热启动，1 个恢复的标签）：

| 指标 | 数值 |
|---|---|
| 进程启动 → 窗口显示且 shell 已绘制 | **0.32–0.39 s** |
| 进程启动 → 恢复的页面加载完成 | 0.37–0.43 s |
| 首次冷启动（编译缓存为空） | 0.86 s |
| 内存（1 个标签） | 约 495 MB（浏览器进程 196、GPU 83、工具进程 39、shell 渲染进程约 80、页面约 98） |

Playwright 测得（`perf.spec.ts`，带调试器，数值偏保守）：

| 指标 | 数值 |
|---|---|
| 一次页面加载产生的 shell IPC 消息数 | **3** |
| 10 个标签时的内存 | 1376 MB |
| 后台标签全部休眠后的内存 | **544 MB**（释放约 830 MB） |
| 激活一个已休眠标签（main 侧，含重建视图） | 约 4 ms |

## 未在 Phase 0 解决、移交后续阶段的事项

见 `docs/ISSUES.md`。
