# 待解决问题与已知限制

## 扩展（Electron 能力限制）

| 问题 | 影响的扩展 | 可能的方向 |
|---|---|---|
| `webRequest` 事件不派发给扩展 | uBlock Origin（MV2）、CocoCut、Wappalyzer 部分检测 | 改用 DNR 类扩展（uBlock Origin Lite）。自研 webRequest 桥接需要用 `session.webRequest` 代理，而它只允许一个监听者，还会和 DNR 冲突，暂不做 |
| `chrome.userScripts` 未实现 | Tampermonkey、Violentmonkey | 可以用兼容层 + `scripting.registerContentScripts` 实现子集；优先级视需求而定 |
| `chrome.sidePanel` 是模拟的（面板显示在扩展窗口里） | OKX Wallet、MetaMask、Bitget 等钱包 | 已可用。限制：只有一个浏览器窗口，`windowId` 被忽略；面板不随标签切换（按标签的选项只在打开时读取）；`open()` 不要求用户手势 |
| `chrome.identity` 未实现 | Phantom 等需要 OAuth 的扩展 | `getRedirectURL` / `launchWebAuthFlow` 可以用弹窗模拟 |
| `tabs.captureVisibleTab`、`tabCapture`、`desktopCapture` | 截图、录屏类 | `captureVisibleTab` 可以用 `webContents.capturePage` 补，成本低，建议下一步做 |
| `chrome.tts`、`chrome.fontSettings`、`chrome.debugger`、`history`、`bookmarks` | 朗读、字体、开发类 | 按需评估 |
| activeTab 不会因点击扩展按钮而授予 | Google Translate"翻译整页"、Charset | Electron 没有授权接口；可以评估在 popup 打开时临时为当前站点授予 host 权限 |
| 已休眠（discarded）的标签不在 `chrome.tabs.query` 结果中 | 依赖完整标签列表的扩展 | 扩展库只认识有 WebContents 的标签；需要上游支持虚拟标签 |
| Awesome Screen Recorder 会导致浏览器崩溃 | 该扩展 | 没有定位到具体的断言点（符号已剥离）。考虑加"崩溃保护"：异常退出后下次启动先禁用最近启用的扩展 |
| 内容脚本写入的 `chrome.storage` 不会转发到 SW 的 onChanged | 少量扩展 | 内容脚本运行在隔离 world，兼容层无法注入 |

## 浏览器功能

- **HTTP 基本认证**（`app.on('login')`）还没有 UI，目前会直接取消认证。
- **多窗口**：架构上预留了位置，但目前只有一个主窗口；`window.open` 带尺寸参数的弹窗（OAuth 等）是独立窗口。
- **触控板双指左右滑动前进/后退**还没做。侧边栏上的横向滑动目前用于切换 Space。
- **DevTools** 只能以独立窗口打开（WebContentsView 不支持停靠）。
- **Widevine / DRM**：Electron 不带 Widevine，Netflix 等无法播放（需要 castLabs ECS 构建）。
- **Profile 隔离**：数据模型和 session 管理已经按 profile 设计，但没有创建或切换 profile 的 UI。
- **收藏夹（全局 Favorites）**：目前只有每个 Space 内的固定标签。
- **页面内状态气泡**（悬停链接时显示 URL）还没做。

## 性能

- 浏览器进程常驻约 190 MB（工作集，包含共享的框架映射）。可以进一步分析 Node 侧的占用。
- 后台标签目前只靠"移出窗口时 Chromium 自动节流 + 定时休眠"。可以评估用 CDP 冻结（`Page.setWebLifecycleState frozen`），但它与 DevTools 共用 debugger，收益需要实测。
- 前进/后退缓存（bfcache）在 Electron 中默认关闭，可以评估开启的兼容性。

## 工程

- 应用目前只有 ad-hoc 签名，没有公证。首次打开需要在"系统设置 → 隐私与安全性"中允许。
- 只测过 macOS 15 / Apple Silicon。
