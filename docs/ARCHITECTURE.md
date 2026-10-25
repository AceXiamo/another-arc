# 架构说明

Another Arc 是一个仅面向 macOS（Apple Silicon）的个人浏览器。核心目标是**极致性能**：能省的进程、内存、IPC 和渲染都省掉；需要付出的成本都在本文写明理由。

## 进程与视图拓扑

```
BaseWindow (hiddenInset 标题栏，红绿灯在侧边栏左上)
├── shell  WebContentsView  ← React 外壳：侧边栏、命令面板、内部页、占位页（全窗口，背景透明）
├── page   WebContentsView  ← 当前 Space 的当前标签页（只挂一个，位于圆角卡片区域）
└── surface WebContentsView ← 非模态浮层（查找栏）；由 shell 用 window.open 打开，与 shell 同进程
```

- **同一时刻只挂载一个页面视图**。切换标签/Space 只是替换这一个子视图；被移除的视图对 Chromium 而言变为 hidden，自动进入定时器节流。
- **模态浮层不新增进程**：命令面板打开时把 shell 视图调到最上层（`setOverlay(true)`）。shell 的内容区是透明"镂空卡片"（`ContentArea` 用超大 `box-shadow` 画出卡片外的窗口底色，卡片内透明），所以页面在下方依然可见；关闭时页面视图回到上层。
- **非模态浮层共用 shell 进程**：查找栏需要在页面可交互时浮在上面。shell 调用 `window.open('about:blank', 'arc-surface:find')`，main 在 `setWindowOpenHandler` 的 `createWindow` 中把该 guest WebContents 包进一个透明 WebContentsView。opener 同源，Chromium 保证二者同进程（实测 pid 相同），React 直接 portal 渲染进子文档，状态共享 Zustand store，零 IPC。
- **布局在 main 里算**：卡片位置由 `src/shared/layout.ts` 的纯函数从窗口尺寸 + 侧边栏宽度算出。窗口 resize 时 main 同步设置页面视图 bounds，不等待 renderer 测量回传，侧边栏与页面始终同帧对齐。

## 状态与数据流

```
            ┌──────────── main（唯一真相源）────────────┐
 IPC 调用 → │ RpcRouter → TabManager / 各 Service        │
            │      │ 变更                                │
            │      ▼                                     │
            │ BrowserModel（纯逻辑）──► ModelListener ──┬─► ShellSync（按 macrotask 合并补丁）──► shell
            │                                          ├─► Persister（防抖事务写 SQLite）
            │                                          └─► present()（挂载正确的页面视图）
            └───────────────────────────────────────────┘
```

- **BrowserModel**（`src/main/tabs/model.ts`）：Space、文件夹、标签排序、激活规则、跨 Space 移动、关闭后选择下一个。没有 Electron 依赖，单元测试覆盖。
- **TabManager**：统一的标签操作接口（快捷键、侧边栏、扩展、IPC 都调用它），把模型变化映射到 `TabRuntime`（每个活跃标签一个 WebContentsView）。
- **ShellSync**：同一 macrotask 内的所有变化合成一个 `StatePatch` 发送（一次页面加载的 start/navigate/title/favicon/stop 只产生一两条 IPC）。renderer 侧 `applyPatch` 对未变化实体保持对象引用不变，配合按 id 订阅的 selector，只有变化的行重渲染。
- **快照启动**：preload 在页面脚本解析前就发起 `shell.snapshot` 请求，并缓冲期间到达的补丁。

## 侧边栏结构与文件夹

每个 Space 从上到下分三块，和 Arc 一一对应：

| 区域（Arc 叫法） | 模型字段 | 行为 |
|---|---|---|
| 收藏（Favorites） | `space.pinnedTabIds` | 普通标签，只是显示成图块 |
| 置顶标签与文件夹（Pinned） | `space.savedIds` → `folder.childIds`（顶层和文件夹里都是标签与子文件夹混排，可嵌套） | 这里的标签是书签：关闭（⌘W、×、中键）只卸载，并回到 `savedUrl`；要从右键菜单"从侧边栏删除"才会移除 |
| 标签列表（Today） | `space.tabIds` | 普通标签 |

- 书签判定：`isSavedTab(tab)`，即 `folderId !== null || savedUrl !== ''`（`src/shared/tabs.ts`）。顶层书签的 `folderId` 为 null。标签进入书签区时记下 `savedUrl`/`savedTitle`，在书签区内移动时保留，离开时清空。⌘D 在书签区顶层和标签列表之间切换（Arc 的 Pin Tab）。
- 书签关闭后，激活权交给最近使用的活跃标签，而不是相邻的书签，避免意外唤醒一个书签。普通标签仍然按相邻规则选下一个；关掉最后一个普通标签时也不会唤醒书签。
- 标签循环（⌃Tab）和 ⌘1–9 按屏幕上看到的顺序：图块 → 展开的文件夹里的书签 → 标签列表。
- 存储：`folders` 表（`parent_id`、`sort_order`、`collapsed`），`tabs` 增加 `folder_id`、`saved_url`、`saved_title`（迁移 v2）。混排列表里的 `sort_order` 就是在父级列表里的位置；加载时检查悬空引用（文件夹丢失的书签留在顶层）和父子环。
- Arc 的侧边栏格式（`arc-sidebar.ts`）：`StorableSidebar.json` 把集合存成扁平的 `[id, 对象, …]` 列表，`childrenIds` 组成树。书签以未加载状态加入，不会被自动选中。图标先从那个浏览器的 Chromium `Favicons` 库（复制到临时目录后只读打开）按页面网址取，剩下的在后台抓 `<origin>/favicon.ico`。
- 从其他浏览器导入（`src/main/import/`）：`browsers.ts` 是唯一的浏览器目录表（产品名、配置目录、钥匙串条目名、书签放在哪），加一个 Chromium 系浏览器就是加一行。现在覆盖 Arc、Dia、Chrome（含 Beta/Canary）、Edge、Brave、Vivaldi、Opera、Chromium、Comet。macOS 上 Chromium 系把配置直接放在 Application Support 下，Browser Company 的两个放在 `User Data` 里，`resolveRoot` 两个都试，所以表里猜错也还能找到。配置列表优先读 `Local State` 的 `info_cache`，读不到就扫像配置的目录（Opera 这类）。
- 书签：Arc 读它自己的 `StorableSidebar.json`，其余读 Chromium 的 `Bookmarks`（书签栏放顶层，"其他书签" 和 "移动书签" 非空时各成一个文件夹，名字用文件里那份，已经是那个浏览器创建时的语言）。两边都产出同一个结构，由 `applySidebar` 落地，所以同名空间合并、同层同名文件夹合并、同位置同网址去重这些规则对两边都生效，重复导入是安全的。
- 登录态 cookie（`chromium-cookies.ts`）：`Cookies` 库复制到临时目录后只读打开，值用该浏览器的钥匙串条目解密（`chromium-crypt.ts`：PBKDF2-HMAC-SHA1(1003 轮, "saltysalt") 出 16 字节密钥，AES-128-CBC，IV 是 16 个空格；Chromium 130 起明文前 32 字节是 `SHA-256(host_key)`，核对一致才剥掉，顺带验证密钥没错）。再逐条 `session.cookies.set()`，由 Chromium 用我们自己的密钥重新加密入库——跨浏览器复制 cookie 文件是不可能的，密钥不同。`host_key` 带前导点才传 `domain`，否则 host-only cookie 会被放宽到子域。CHIPS 分区 cookie（没有对应 API）、会话 cookie 和过期的跳过并计数。
- 登录态的网站存储（`chromium-storage.ts`）：localStorage 和 IndexedDB 都是 Chromium 开着就一直持有的 LevelDB，没有 API 能写，所以导入时复制到 `<分区>/import-staged/` 并记下 `import-pending.json`，下次启动在 `startBrowser` 里、任何 session 创建之前移入（唯一没被锁住的时刻），完事清掉暂存目录和标记。两者的合并方式不同：
  - localStorage 是整个分区一个库，没有合并两个库的办法，所以是替换，原库改名 `leveldb.before-import` 留作备份。这一步会替换掉本地已有的网站数据，确认框里说明了。
  - IndexedDB 是一个网站一个目录，所以是真合并：本地没有这个网站的就移进来，已经有的一律不动（移入前再查一次，暂存之后到重启之间这个网站可能刚存了东西）。一个网站的 `.indexeddb.leveldb` 和 `.indexeddb.blob` 一起走。`chrome-extension_…` 跳过——确认框里说了扩展数据不复制，悄悄搬钱包 vault 是另一回事。存储键被顶层站点分区的那些在 `WebStorage/<bucket id>/` 下、还要配额库里的一行，和 CHIPS cookie 一样带不过来。
- 只读一个配置：浏览器每个配置一套 cookie，合在一起同一个站点会互相覆盖。设置页按浏览器列出可导入的内容，配置多于一个时给个下拉选；默认是该浏览器最近使用的那个。
- 右键菜单（侧边栏空白处、文件夹、标签）都是 main 里的原生菜单；新建文件夹后 main 发 `folder.rename` 命令，外壳显示内联重命名框。

## 标签生命周期与内存

| 状态 | 含义 | 成本 |
|---|---|---|
| unloaded | 只有模型数据（URL、标题、favicon、前进/后退记录） | 几 KB |
| live | 有 WebContentsView；不可见时被 Chromium 节流 | 一个渲染进程份额 |
| shown | 当前挂载的那一个 | — |

- **懒恢复**：启动时只为当前 Space 的当前标签创建视图，其余标签保持 unloaded。
- **休眠（discard）**：`TabDiscarder` 每分钟检查一次，闲置超过设置时长的后台标签被释放；设置了内存预算时，超出预算按 LRU 释放。释放前用 `navigationHistory.getAllEntries()` 保存完整前进/后退栈（含 `pageState`，即滚动位置/表单状态），激活时 `navigationHistory.restore()` 还原。正在播放音频、打开了 DevTools、或 `beforeunload` 拒绝卸载的页面不会被释放。
- 关闭标签时立即从模型移除（UI 即时响应），后台以 `waitForBeforeUnload` 关闭 WebContents；页面拒绝卸载时弹窗确认，用户选择留下则把标签原位恢复。

## 持久化

- 使用 Electron 自带 Node 的 **`node:sqlite`**（无需原生模块编译），WAL + `synchronous=NORMAL`，所有语句预编译缓存。
- `Persister`：标签/Space/设置的脏集合按 800 ms 防抖、最长 4 s 合并为一个事务写入。退出时（`before-quit`，此时 WebContents 仍存活）先快照所有导航历史再同步落盘；之后冻结 TabManager，避免窗口销毁时的 `destroyed` 事件误删标签。
- 历史记录：`history_urls`（聚合）+ `visits`（明细），FTS5 **trigram** 索引做子串匹配；按访问次数/输入次数/时间衰减计算 frecency。少于 3 个字符的查询只扫描最近 5000 条。
- Favicon：经标签自身的 session 拉取一次后存入 SQLite，通过 `favicon://` 协议给 shell 用；shell 自己从不访问网络，重启后图标立即可见。

## 快捷键

两条互不重叠的路径，避免重复触发：

1. **保留快捷键**（⌘T/⌘W/⌘⇧T/⌘L/⌘1–9/Ctrl+Tab/⌘⇧[ ]/⌘⌥←→/⌘⇧W）：在所有页面视图、shell、浮层的 `before-input-event` 中按物理键码匹配并 `preventDefault`，网页无法拦截。菜单里对应项 `registerAccelerator: false`，仅显示快捷键。
2. **普通快捷键**（⌘F、⌘R、⌘±/0、⌘S、⌘D…）：注册为原生菜单加速键，网页先拿到按键，未处理时才由菜单执行（例如 Google Docs 可以接管 ⌘F）。

编辑类快捷键（复制/粘贴/撤销…）使用菜单 role，保证在网页和 shell 输入框中都可用。

## 安全

- 页面视图：`sandbox`、`contextIsolation`、无 Node、`webSecurity`、禁止 `<webview>`、`safeDialogs`；我们不向网页注入任何 preload。
- shell 通过 `app://shell` 自定义协议加载（带 CSP 与 V8 code cache），IPC 只接受 shell 主 frame 发来的调用（校验 WebContents 身份 + 协议/主机），每个方法的参数在 main 侧运行时校验（`src/main/ipc/validate.ts`）。
- 外部协议、`window.open` 弹窗、证书错误、网站权限都有明确策略：权限按 origin 存储，默认不授予；证书错误默认拦截，用户显式"继续"只对当次运行该主机有效。
- 扩展安装复制到用户数据目录，跳过符号链接、校验每个目标路径不越界。

## 扩展

- Electron 提供核心扩展运行时；`electron-chrome-extensions`（GPL-3.0）补齐 tabs/windows/action/contextMenus 等 API。
- 该库会向 session 的**每个 frame** 注册 preload，因此**只在启用了至少一个扩展时才动态加载**，没有扩展时网页零额外开销（有测试守护）。
- 扩展工具栏按钮由 shell 自绘（调用库的 browserAction IPC），支持固定/取消固定。图标走 `crx:` 协议，处理器在 shell 加载前就注册好（frame 创建后才注册的协议对该 frame 无效），扩展库加载后再委托给它。
- **兼容层**（`src/preload/extension-compat.ts` + `src/main/extensions/compat.ts`）：在扩展的 SW 和页面里替换几个 Electron 有缺陷的 API。
  - `runtime.onInstalled` / `onStartup`：Electron 不触发。改由 main 在安装或更新后唤醒 SW 并派发；onStartup 只唤醒注册过监听的扩展，延迟 3 秒。
  - `storage.onChanged`：Service Worker 里收不到。SW 自己的写入在本地派发；扩展页面的写入经 main 转发给 SW。
  - `runtime.getContexts`：原生实现会撞上 Chromium 断言。改为 main 根据自己跟踪的标签、扩展窗口（POPUP / SIDE_PANEL）、SW、离屏文档构造结果。
  - `chrome.sidePanel`：Electron 没有。扩展库的 preload 最后会冻结 `chrome`，所以兼容层 preload 注册两次：库之前那一遍只加 `chrome.sidePanel`，库之后那一遍做其余垫片（同一个文件，用主 world 上的标记区分）。状态在 main（`side-panel.ts`），行为和全局选项会持久化。
  - `browser`：Chromium 152 的原生 `browser` 对象上没有扩展库补的 API；webextension-polyfill 会优先用它。兼容层把它指向完整的 `chrome`。
  - 离屏文档没有 context isolation，兼容层在这种情况下直接在同一个 world 里安装。
  - 扩展 SW 不用 session 的 UA；加载扩展时把 `app.userAgentFallback` 设为同一个 Chrome UA。
- **扩展窗口**（`src/main/extensions/extension-window.ts`）：在扩展库创建 PopupView 之前接管工具栏点击（运行时替换 `BrowserActionAPI.activateClick`），Popup 和侧边面板都在一个带标准标题栏的子窗口里打开：可拖动、失焦不关闭、每个扩展一个、记住位置。再点一次按钮关闭。没有 Popup 也没有面板时仍派发 `action.onClicked`（必要时先唤醒 SW）。
- **Popup 尺寸**（`src/main/extensions/popup-fit.ts`）：Electron 44 不触发 `preferred-size-changed`。改为按 Chrome 的规则自行测量：内容最小不溢出宽度，以及该宽度下的高度；窗口在测量完之后才显示，之后只增大不缩小，用户手动调整过就不再跟随。
- 详细的兼容性数据见 `docs/PHASE0-REPORT.md`。

## 启动路径

1. `out/main/index.js`（2.7 KB）：设置用户目录、启用 Node 编译缓存、注册协议、单实例锁，然后动态导入其余代码（编译缓存生效）。
2. 打开 SQLite、同步读出会话（几毫秒）。
3. 创建窗口和 shell 视图并开始加载 shell，**同时**并行加载扩展。
4. 扩展就绪后挂载当前标签（保证内容脚本生效）；shell 首帧绘制后才 `show()` 窗口，避免白屏。
5. 30 秒后做清理（历史剪枝、favicon 剪枝）；有 onStartup 监听的扩展在 3 秒后才被唤醒。

shell 首次渲染用 `flushSync` 同步提交，提交后立即通知 main 显示窗口。不能等 `requestAnimationFrame`：窗口此时还是隐藏的，而隐藏窗口不执行 rAF。

## 退出路径

1. `before-quit`：停止休眠器 → 结束扩展 SW 的保活任务并卸载扩展（否则 Chromium 关闭阶段会多等 2–15 秒）→ 快照所有标签的导航历史 → 冻结 TabManager（之后 WebContents 的销毁事件不再改动模型）→ 写盘 → 关闭所有页面（不等 beforeunload）。
2. `will-quit`：再写一次盘，然后关闭 SQLite（WAL checkpoint）。
3. main 进程装有全局 `uncaughtException` / `unhandledRejection` 处理器，异常只写入 `<userData>/logs/main.log`，绝不弹出 Electron 的异常对话框。

## 空间主题

- 数据：`SpaceState.color` 仍是主色（也是强调色），`SpaceState.theme` 存其余部分：`gradient`（主色之后 0–2 个渐变色）、`angle`、`intensity`（0–100，50 即原来的 17% / 15% 着色）、`noise`（颗粒，0 为关）、`appearance`（`system` / `light` / `dark`，只改外壳的明暗，网页仍跟随设置）。`spaces.theme` 列存 JSON（迁移 v3，NULL 即默认值）；读取、IPC 合并时都经 `sanitizeSpaceTheme` 夹紧数值、只收 `#rrggbb`。
- 渲染全靠 `<html>` 上的 CSS 变量（`lib/theme.ts`，不经 React）：切换 Space 只改几个变量。每个主题色按 `--tint` 混入底色，再把亮度夹在 ≥0.76（浅色）/ ≤0.36（深色），任何强度下正文对比度都 ≥6.5:1；着色超过默认值时侧边栏的次要文字（`.chrome-ink`）随之加深。`src/shared/theme.ts` 用同一套公式算出原生窗口背景色，单元测试校验两者一致及对比度。
- 窗口底色由 `ChromeBackdrop` 画：全窗口一个元素，用 `clip-path: shape(evenodd …)` 在页面卡片处挖出与 `ContentArea` 完全相同的圆角洞，所以外壳浮到页面上方时页面仍可见。路径裁剪直接画进外壳的根图层，没有额外的合成层或 render surface（实测图层数与改动前相同）。`ContentArea` 自己的大 box-shadow 在 `App` 里被设为透明。
- 颗粒是一张静态贴图：首次需要时在空闲回调里用 canvas 画一次（128 CSS px，按设备像素比，约 5 ms、150 KB 的 data URL），以样式规则注入，透明度由 `--grain-opacity` 控制，`noise = 0` 时 `display: none`。没有逐帧滤镜或动画：滚动标签列表不重绘它（合成滚动），拖动侧边栏宽度时它与原来的 box-shadow 一样随根图层重绘（实测每帧绘制加光栅化多约 0.1 ms，样式计算因变量增多多约 0.3 ms；120 Hz 下没有掉帧）。

## 多语言

- `src/shared/i18n`：`translate(locale, key, params)`，`{name}` 占位符；按模块拆分词典（`common`、`main`、`shell-*`），英文是基准，其他语言按英文的键做类型约束。
- 主进程：`Browser.t` 每次读取当前设置里的语言，菜单、右键菜单和对话框在弹出时再翻译。切换语言只需重建应用菜单。需要跨层传递的错误用 `LocalizedError(key, params)`，到显示时再用 `describeError` 翻译。
- 外壳：`useT()` 订阅 `settings.language`，只有用到文案的组件会重渲染；`<html lang>` 跟着变。
- 存储里的数据（Space 名、标签标题）不做翻译，唯一的例外是仍为默认值的 Space 名。
