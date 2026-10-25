# 开发记录

## 2026-10-24 · Phase 0 + Phase 1 主体 + Phase 2 部分

### 完成

- **工程**：Electron 44.9.3 + electron-vite 6 + React 19 + Zustand + Tailwind v4 + TypeScript 7（strict）。数据库用 `node:sqlite`。单元测试用 Vitest，集成测试用 Playwright（`_electron`）。
- **核心**：纯逻辑的 `BrowserModel`；`TabManager` 提供统一的标签操作接口；`TabRuntime` 每个活跃标签对应一个 WebContentsView；按 macrotask 合并状态补丁；用防抖事务写盘。
- **标签**：新建、关闭（尊重 beforeunload，取消后原位恢复）、恢复最近关闭、复制、固定、静音、跨 Space 移动、拖拽排序、休眠与恢复（含前进/后退栈）、崩溃页、网络错误页、证书错误页、`window.open` 保留 opener。
- **Space**：创建、编辑、删除、排序、切换（快捷键或侧边栏横向滑动）。图标是生成的扁平字形，用 CSS mask 着色，跟随主题色。
- **地址栏 / 命令面板**：识别网址或搜索词（内置 IANA 顶级域名表）、已打开标签匹配、历史联想（FTS5 trigram）、内置命令。
- **快捷键**：保留快捷键由 `before-input-event` 抢先处理；普通快捷键交给原生菜单，网页可以先处理。
- **其他**：下载（指定目录或每次询问、暂停、继续、取消、Dock 进度）、网站权限（按 origin 记住，摄像头和麦克风会同时请求 macOS 授权）、页内查找（同进程浮层）、按站点记住缩放、历史页、设置页、深浅主题。
- **扩展**：导入、启用、禁用、卸载、从源目录更新、工具栏固定；兼容层补上 onInstalled、onStartup、SW 中的 storage.onChanged 和 getContexts；修复 Popup 不显示的问题。
- **打包**：electron-builder（arm64，ad-hoc 签名）+ Fuses 加固。

### 过程中发现并修复的问题（详见 PHASE0-REPORT 的"技术风险"）

- `app://` 的 origin 在 Node 里是 `"null"`，导致 IPC 来源校验失败。
- 历史页无限滚动用到了旧闭包，结果重复。
- 退出时排队的 `present()` 操作已经销毁的窗口，弹出主进程异常对话框。已加守卫，并装上全局异常处理器（只写日志，不弹窗）。
- 扩展运行时退出卡 2–15 秒；PageState 恢复期间后退会让渲染进程崩溃；隐藏窗口里 rAF 不执行导致启动慢约 1.5 秒；Popup 不显示；扩展图标协议注册太晚。
- 兼容层的存储 Proxy 用错了 receiver，触发 `Illegal invocation`（Rainbow 钱包暴露出来）。

### 测试

- 单元测试 53 个（URL 解析、模型规则、状态补丁）。
- 集成测试 23 个：标签与 Space、会话恢复、快捷键、下载、查找、历史、权限、崩溃、beforeunload、证书错误、缩放、扩展探针与生命周期、性能基线、视觉截图。
- 真实扩展调查：按需运行，见 README。

### 分工

UI 打磨（配色 token、半透明图标、各页面与弹层细节）由一个子 agent 在 `src/renderer/**` 内独立完成，使用独立的 `out-ui` 构建目录，不干扰主线测试。

## 2026-10-24 · 多语言

- 默认英文，设置 → 外观 → 语言可切换简体中文，即时生效：外壳 UI、内部页面、原生菜单、右键菜单、对话框和扩展安装错误都会跟着变，不需要重启。
- 词典在 `src/shared/i18n/locales/<locale>/` 下按模块拆文件，主进程和外壳共用。中文文件的类型是 `Record<keyof typeof en, string>`，漏翻译时 typecheck 直接报错。
- 主进程通过 `Browser.t` 读取当前语言；切换语言时重建应用菜单。安装器抛 `LocalizedError`（带 key 和参数），显示时再翻译。
- 名字还是默认值（"Personal"/"个人"、"New Space"/"新空间"）的 Space 会随语言改名；用户改过名字的不动。
- 分工：框架、主进程和公共词典由主线完成；侧边栏、命令面板/查找栏、设置/扩展页、历史/下载/状态页由 4 个子 agent 并行完成，各自只改自己的文件和词典，使用独立的 `out-<模块>` 构建目录。
- 测试：新增 i18n 单元测试（键一致、占位符一致、无重复键）和 `i18n.spec.ts`（默认英文、设置页切换、菜单重建、重启后保留）。旧的集成测试默认以中文运行；`visual.spec.ts` 改为用 `t()` 取文案，`ARC_TEST_LOCALE=en` 时也能通过。单元测试 58 个，集成测试 25 个（其中真实扩展调查按需运行）。

## 2026-10-24 · 文件夹（书签）与从 Arc 导入扩展

- **文件夹**：对应 Arc 的 Folder，放在固定图块和标签列表之间，可以嵌套、折叠。文件夹里的标签就是书签，关闭只是卸载，并回到保存的页面。详细规则见 ARCHITECTURE 的"侧边栏结构与文件夹"。
- **侧边栏**：去掉了"新建标签页"按钮（用 ⌘T）。空白处右键可以新建文件夹、编辑空间、新建空间。
- **顺带修复**：同一区域内拖动排序时，发给外壳的补丁是"取出后、插回前"的列表，外壳要等下一次更新才对。现在模型统一发送最终列表，并加了回归测试。
- **分工**：数据模型、持久化（迁移 v2）、IPC、原生菜单由主线完成；侧边栏 UI（树形渲染、内联重命名、拖放）和从 Arc 导入扩展各由一个子 agent 并行完成。
- **从 Arc 导入书签**（同日追加）：读取 Arc 的 `StorableSidebar.json`，把空间、置顶标签、嵌套文件夹和收藏导进来。你的数据：1 个空间、30 个文件夹、274 个书签、4 个收藏。导入只用了 15ms；图标 241/275 从 Arc 的 `Favicons` 库即时取到，剩下的走网络。为此书签区顶层也可以直接放书签（对应 Arc 的置顶标签），图块改叫"收藏"，⌘D 改成 Arc 的置顶语义。入口：设置页"从 Arc 导入"、⌘T 命令。
- **"从 Arc 导入"一次全导**（同日追加）：用户把打包产物放进 /Applications 后没找到导入入口（原来藏在设置页底部，且侧边栏和扩展是分开的两个按钮）。现在一个确认框同时导入侧边栏和扩展；新配置首次启动时主动询问一次（选择会持久化，不会重复问）；入口加到菜单栏"文件 → 从 Arc 导入…"、设置页和 ⌘T。用真实 Arc 数据在临时配置里完整跑过：7.7 秒，16/16 个扩展、271 个书签、30 个文件夹、4 个收藏。

## 2026-10-25 · 扩展窗口与 sidePanel

- **问题**：OKX Wallet 点按钮没反应；扩展的 Popup 不能移动。
- **扩展窗口**：Popup 和侧边面板改为在独立的小窗口里打开（标准标题栏显示扩展名，可拖动；浏览器窗口的子窗口；失焦不关闭；⌘W、关闭按钮、`window.close()` 或再点一次按钮关闭；每个扩展一个窗口，记住位置）。Popup 继续按内容定尺寸，侧边面板默认 380×640、可调大小。实现方式是运行时替换扩展库的 `activateClick`，在它创建 PopupView 之前接管点击；没有 Popup 也没有面板的扩展仍收到 `action.onClicked`，没运行过的 SW 会先被唤醒。
- **`chrome.sidePanel`**：兼容层在 SW 和扩展页面里提供完整的常用子集，经 IPC 交给 main。扩展库会冻结 `chrome`，所以兼容层 preload 注册两次，第一遍在库之前加 `chrome.sidePanel`。
- **OKX 真正的病因有三个**，排查时逐个确认：
  1. Chromium 152 暴露了一个原生 `browser` 对象，上面没有扩展库补的 API。webextension-polyfill 优先用它，于是 OKX 的 `browser.tabs.onUpdated` 在 SW 顶层抛错，`action.onClicked` 也注册到了永远不会触发的原生事件上。兼容层把 `browser` 指向完整的 `chrome`。这一条影响所有用 polyfill 的钱包。
  2. 扩展 SW 的 `navigator.userAgent` 不受 session UA 影响，仍带 `Electron/44`。OKX 看到 "electron" 就把自己的页面当成不可信来源，界面永远停在 Loading。加载扩展时设置 `app.userAgentFallback`。
  3. 缺 `chrome.sidePanel`。
  修完后 OKX 的引导页（标签页）和侧边面板（扩展窗口）都能正常显示 Create/Import wallet，等级从 C 升到 B。
- **顺带修复**：`chrome.windows.create` 的相对 URL 没有解析（钱包授权弹窗会是空白窗口）；`focused: false` 的窗口之前根本不显示；离屏文档没有 context isolation，兼容层之前在里面直接报错。
- **测试**：新增 `extension-windows.spec.ts`（移动、记住位置、切换、⌘W、`window.close()`、侧边面板 API、`windows.create`、重启后面板行为仍在）和 `side-panel` 测试扩展；API 探针增加 sidePanel、`browser` 命名空间和 SW UA 检查，46/48 通过；新增 `side-panel.test.ts` 单元测试。真实扩展调查脚本现在也会记录点按钮后打开的是窗口还是标签页。

## 2026-10-25 · 标题栏拖动

- 现象：窗口顶部拖不动。外壳是 BaseWindow 里的 WebContentsView，`app-region: drag` 在这里不可靠。
- 做法：标题栏区域（侧栏顶部、内容区上方的间隙、底部空间栏、收起侧栏后的整条顶部间隙）在按下时通知 main，main 以约 120Hz 读取光标位置并按"起始位置 + 光标位移"移动窗口，松开时停止。位置是绝对计算的，所以原生拖动若也生效，两者落点一致。窗口跟着光标走时页面收不到 pointermove，所以由 main 轮询光标而不是靠页面事件。
- 双击按系统设置"双击窗口标题栏时"（缩放 / 最小化 / 不执行）。
- 开启 `acceptFirstMouse`（同 Chrome）：后台窗口第一次点击就能拖动、点到侧栏。
- 测试：`title-bar.spec.ts` 用伪造的光标位置驱动 main，覆盖拖动、按钮不触发拖动、收起侧栏、双击三种系统设置。

