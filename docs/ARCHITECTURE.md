# 架构说明

Another Arc 是一个仅面向 macOS（Apple Silicon）的个人浏览器。核心目标是**极致性能**：能省的进程、内存、IPC 和渲染都省掉；需要付出的成本都在本文写明理由。

## 进程与视图拓扑

```
BaseWindow (hiddenInset 标题栏，红绿灯在侧边栏左上)
├── shell  WebContentsView  ← React 外壳：侧边栏、命令面板、内部页、占位页（全窗口，背景透明）
├── page   WebContentsView  ← 当前 Space 的当前标签页（只挂一个，位于圆角卡片区域）
└── surface WebContentsView ← 非模态浮层（查找栏）；由 shell 用 window.open 打开，与 shell 同进程
```

- **同一时刻只挂载一个页面视图**。切换标签/Space 只是替换这一个子视图。不在窗口里的视图（被移除的，和在后台打开、从没挂上去的）对 Chromium 而言是 hidden：`visibilityState` 为 `hidden`，不出帧、不跑 rAF，定时器对齐到每秒一次（实测 500ms 的 `setTimeout` 要等约 1 秒）。这就是后台标签的节流，不需要额外代码。
  - 测试注意：Playwright 给它连上的每个页面都开 `Emulation.setFocusEmulationEnabled`，Chromium 把这算作一个"可见的捕获者"，所以在 `_electron.launch` 下所有页面永远是 visible、每秒 60 帧，连整个窗口隐藏都一样。节流相关的断言放在 `tests/e2e/background-tabs.spec.ts`：它自己启动应用，经 Node inspector 驱动 main，不让 Playwright 连页面。
- **模态浮层不新增进程**：命令面板打开时把 shell 视图调到最上层（`setOverlay(true)`）。shell 的内容区是透明"镂空卡片"（`ContentArea` 用超大 `box-shadow` 画出卡片外的窗口底色，卡片内透明），所以页面在下方依然可见；关闭时页面视图回到上层。
- **非模态浮层共用 shell 进程**：查找栏需要在页面可交互时浮在上面。shell 调用 `window.open('about:blank', 'arc-surface:find')`，main 在 `setWindowOpenHandler` 的 `createWindow` 中把该 guest WebContents 包进一个透明 WebContentsView。opener 同源，Chromium 保证二者同进程（实测 pid 相同），React 直接 portal 渲染进子文档，状态共享 Zustand store，零 IPC。
- **下载的飞行动画**要从页面上的指针飞到侧边栏的下载按钮，跨过页面视图，又不能挡住点击，而视图做不到点击穿透。所以这一层是 shell 用 `window.open('about:blank', 'arc-flight')` 打开、main 包进一个透明子窗口（`setIgnoreMouseEvents(true)`、不可聚焦）的文档，同样与 shell 同进程。只在有东西在飞时显示、盖住窗口内容区。起点是下载开始时的光标位置（`screen.getCursorScreenPoint()`，不在窗口上或弹了保存框就不飞，只让按钮弹一下）；路径是匀速走的二次贝塞尔曲线，也就是抛物线，只动 transform 和 opacity。
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
- 密码（`src/main/passwords/`）：存在 `logins` 表（迁移 v4），密码字段是 Electron `safeStorage` 的密文，拿登录钥匙串加密，明文从不落库、不进日志、不走 IPC 到外壳。钥匙串拿不到密钥时直接不保存，绝不退化成明文。
- 自动填充的链路：网页侧多了一个 preload（`src/preload/page.ts`，沙箱 + 上下文隔离，页面自己的脚本够不着），只挂几个捕获阶段监听器，不轮询、加载时不遍历 DOM。下拉框**只在用户操作时**打开：点进登录字段、Tab 进去、在里面按 ↓。脚本调 `focus()`、窗口重新获得焦点、填充后我们自己聚焦密码框，都不打开——最初对每个 `focusin` 都响应，结果和下面那条焦点问题叠在一起转成了死循环。键盘事件只认 `isTrusted`，页面没法合成 ↓ + Enter 替用户选一个。main 的 `PasswordManager` 决定给什么、放在哪：**origin 一律从发消息的 WebContents 自己的 URL 读，不信消息里带的**，所以被攻陷的页面要不到别的站点的凭据。选中之后密码从 main 直接发回那个页面的 preload 写进字段，整条路径不经过外壳。
- 下拉框和「保存密码？」都是浮层（`SURFACES`），但和查找栏不同，它们 `takesFocus: false`：显示时不拿键盘、隐藏时不还焦点。下拉框要是拿了键盘，正在服务的那个输入框就会失焦——preload 报失焦 → 关下拉 → 焦点还给页面 → 输入框又 `focusin` → 再弹 → 再抢，就是"一直闪"。不拿焦点之后，↑↓/Enter/Esc 留在页面的输入框里，由 preload 转给 main，main 再把选中行推给外壳。点一下行仍会让浮层短暂拿到焦点，所以页面"整个失焦"时 main 等 `BLUR_GRACE_MS`（150ms）再关，让那次点击的选择先到；点在行与行之间的空白上就保持打开、把焦点还给输入框。浮层隐藏时若它正拿着焦点，**先移除视图、再**把焦点还给页面——反过来的话，移除一个仍聚焦的视图会把刚给页面的焦点又清掉（二分出来的）。
- 下拉框的位置由 `PasswordManager.place()` 按字段矩形乘页面缩放算出，卡片左边缘对齐字段，底部放不下就翻到上方，并夹在页面卡片内。浮层比卡片大出阴影的空间，但**面向字段的那一边不留**——那里的透明边会吞掉本该点在字段上的点击；翻到上方时由外壳把卡片贴到浮层底边。几何常量在 `@shared/passwords`，main 按它算浮层尺寸、外壳按它画，两边必须一致，否则差出来的高度就是卡片底下的空白。页面滚动时 preload 每帧上报一次新位置让下拉框跟着走，字段滚出视野才关；聚焦常常会触发 `scrollIntoView`，一滚就关的话下拉框刚弹出就没了。超过 4 条可滚动，键盘选中的行自动滚进视野。
- 设置页能看、能复制、能删。「显示」走 Touch ID（`systemPreferences.promptTouchID`），没有 Touch ID 就只能复制——复制是 main 直接写剪贴板，密码同样不经过外壳。
- 从其他浏览器导入密码（`chromium-passwords.ts`）：和 cookie 同一把钥匙串密钥。三类行跳过并分别计数：`android://` 的是从手机同步来的应用凭据、`blacklisted_by_user` 的「从不保存」条目没有密码、`keychain_identifier` 非空的老条目密码单独存在那个浏览器自己的钥匙串项里，文件里没有可解的东西。
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

## 网页对话框（alert / confirm / prompt）

- Electron 44 自己的处理方式：Chromium 把对话框交给 WebContents 上的私有事件 `-run-dialog`，Electron 在 JS 里（`lib/browser/api/web-contents.ts`）用 `dialog.showMessageBox(getOwnerBrowserWindow(), …)` 弹原生 sheet。放在我们的 `BaseWindow` 上就是整个窗口的 sheet：后台标签也能弹出来盖住当前页、不显示是哪个网站在问、按钮只有英文。`prompt()` 更彻底——Electron 的渲染进程初始化（`lib/renderer/window-setup.ts`）在每个页面主 world 里把它换成直接抛 "prompt() is not supported." 的函数，根本到不了浏览器进程。
- 所以 `PageDialogs`（`src/main/tabs/page-dialogs.ts`）在每个标签的 WebContents 创建时（`runtimeCreated`）换掉 Electron 的 `-run-dialog` 处理器；`prompt()` 由页面 preload（`src/preload/page-prompt.ts`）在主 world 换回一个用同步 IPC 问 main 的实现，进同一个队列（来源取自 `senderFrame`，不信消息内容）。没有 preload 的子 frame 保留原生 `prompt()`，照样走 `-run-dialog`。替换依赖私有事件名：哪天 Electron 不再发 `-run-dialog`，`attach` 打一条警告并保留 Electron 的默认行为，`tests/e2e/dialogs.spec.ts` 也会失败。
- **外壳绘制、标签级模态**：待回答的对话框放在 `pageDialogs` 状态里，外壳在当前标签的页面卡片顶部画一个 sheet（`PageDialogSheet`），标题是「<host:端口> 显示」，来源由 main 从发起的 frame 取。显示期间外壳升到页面之上（和命令面板同一个 overlay 机制，`effects.ts`）：页面压暗、可见但点不到，侧边栏照常能用。Enter 确定、Esc 取消，prompt 的默认文字预先全选；回答后 overlay 撤掉、焦点回到页面。
- **只有屏幕上的那个标签能弹**（和 Chrome 一样）：后台标签的对话框立即按「取消」返回；切换标签、开始新的文档导航（⌘R、输入网址）、关闭标签、渲染进程崩溃都会把正在显示的那个按「取消」结束。这样后台不会攒下没人看的对话框，休眠也不用顾及它们。
- **例外是 Agent 正在操作的标签**（`PageDialogHost.heldForAgent`）：它的对话框不论在不在屏幕上都留着，等 Agent 用 `handle_dialog` 回答（`PageDialogs.respond`，外壳里的 sheet 同步消失）；用户切到这个标签也会看到 sheet，可以自己答。Agent 停手（45 秒无调用）后重新按普通规则处理，还没答的后台对话框按「取消」结束，页面不会一直冻着。页面冻在对话框上时，Agent 的页面调用直接报出对话框内容而不是等到超时；会等页面的 CDP 命令（文件选择框拦截、唤醒）这时也不去等。
- **safeDialogs**：同一页面、同一来源从第二个对话框起提供「禁止此网页再显示对话框」，勾上后该来源之后的对话框直接返回取消。Chromium 在用户发起的导航或跨站导航时通过 `-cancel-dialogs` 的 `resetState` 要求清零，我们照做（Electron 自己的实现忽略了它）。`disableDialogs` 照旧生效。
- **不阻塞主进程**：main 只记下回调，页面在自己的渲染进程里等；没有原生模态循环，MCP 服务等照常运行。
- 测试注意：Playwright 通过 CDP 连着每个页面，没有 `dialog` 监听时会立刻替你把对话框关掉（confirm 返回 false、什么都看不到），所以测网页对话框要先 `app.context().on('dialog', () => {})`，交给应用处理。同理，CDP 的 `Page.handleJavaScriptDialog` 会绕过我们直接回答页面，外壳里的 sheet 要等下一次导航或切换标签才消失。

## 持久化

- 使用 Electron 自带 Node 的 **`node:sqlite`**（无需原生模块编译），WAL + `synchronous=NORMAL`，所有语句预编译缓存。
- `Persister`：标签/Space/设置的脏集合按 800 ms 防抖、最长 4 s 合并为一个事务写入。退出时（`before-quit`，此时 WebContents 仍存活）先快照所有导航历史再同步落盘；之后冻结 TabManager，避免窗口销毁时的 `destroyed` 事件误删标签。
- 历史记录：`history_urls`（聚合）+ `visits`（明细），FTS5 **trigram** 索引做子串匹配；按访问次数/输入次数/时间衰减计算 frecency。少于 3 个字符的查询只扫描最近 5000 条。
- Favicon：经标签自身的 session 拉取一次后存入 SQLite，通过 `favicon://` 协议给 shell 用；shell 自己从不访问网络，重启后图标立即可见。

## 快捷键

两条互不重叠的路径，避免重复触发：

1. **保留快捷键**（⌘T/⌘W/⌘⇧T/⌘L/⌘1–9/Ctrl+Tab/⌘⇧[ ]/⌘⌥←→/⌘⇧W）：在所有页面视图、shell、浮层的 `before-input-event` 中按物理键码匹配并 `preventDefault`，网页无法拦截。菜单里对应项 `registerAccelerator: false`，仅显示快捷键。
2. **普通快捷键**（⌘F、⌘R、⌘±/0、⌘S、⌘D、⌘Z、⌘P、⌘N、⌘←/→…）：注册为原生菜单加速键，网页先拿到按键，未处理时才由菜单执行（例如 Google Docs 可以接管 ⌘F）。

编辑类快捷键（复制/粘贴…）使用菜单 role，保证在网页和 shell 输入框中都可用。**⌘Z 例外**（`shortcuts/undo.ts`）：和 Arc 一样，正在编辑文字时是撤销文字，否则是撤销关闭——窗口被关了就重新显示，否则重开最近关闭的标签。判断顺序：网页自己处理 ⌘Z 的（编辑器）菜单根本收不到；关闭标签之后还没打过字（所有按键都经过 `handleReservedKeys`，那里记下最后打字的时间）就重开，哪怕接手的页面有聚焦的输入框；否则到获得焦点的视图里、在 context isolation 的隔离世界中问一句焦点是不是可编辑元素（页面脚本改不了它读到的东西），是就撤销文字。焦点在原生面板（比如另存为对话框）上时用 `Menu.sendActionToFirstResponder('undo:')` 交还给系统，不然那里的输入框会失去撤销。
单窗口，所以 ⌘N 也是新建标签；⌘P 打印；⌘←/→ 后退前进（输入框里它们先被输入框处理成行首/行尾，菜单收不到）。

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
  - `permissions.contains`：扩展库把申请的 origin 和 host_permissions 当字符串比较，`<all_urls>` 不"包含" `http://127.0.0.1:8080/`，Tampermonkey 因此去申请已有的权限、装脚本失败。改为按匹配模式判断（`match-pattern.ts`），已有的权限 `request` 直接返回 true，授予后派发 `permissions.onAdded`。
  - `chrome.commands`：库只列出命令，不绑定、也不派发 `onCommand`。`shortcuts.ts` 按 Chrome 的语法（`Command+Shift+Y`、`MacCtrl+…`）绑定 manifest 建议的快捷键和用户改过的（存在设置表），在每个页面和外壳的 `before-input-event` 里、浏览器保留快捷键之后匹配；`_execute_action` / `_execute_side_panel` 走工具栏点击 / 侧边面板，其余派发 `commands.onCommand`（先唤醒 SW）。`commands.getAll` 的结果同步写回库的列表。
- **`chrome.userScripts`**（`src/main/extensions/user-scripts.ts`、`src/shared/user-script-world.ts`、`src/preload/user-script-world.ts`）：Electron 没有这个 API，Tampermonkey 这类脚本管理器离不开它。
  - 「允许用户脚本」开关（扩展详情页，存在设置表）：关着时 `chrome.userScripts` 不存在——管理器正是靠这一点提示用户去打开。切换时整个扩展重新加载，加载前先等旧 SW 停下：旧 SW 还在时新加载的扩展，其 SW 永远不是 active 的那个，所有 API 调用报 "No SW"。
  - 页面里同步问 main 开关状态；SW 不能同步问（main 那边 handler 还没挂上时同步 IPC 会让 worker 卡死），所以 SW 里是 getter，异步拿到状态后才出现。
  - **注入走原生**：每个用户脚本注册成扩展自己的 `chrome.scripting` 动态 content script（id 带 `arc-us-` 前缀，从扩展自己的 `chrome.scripting` 里隐藏），Chromium 负责 document_start、所有 frame，每次页面加载不走 IPC。`{ code }` 写成安装副本里的 `arc_user_scripts/<hash>.js`（副本是我们的；代码另存一份在 `User Scripts/` 下，更新扩展后可以重写）；`includeGlobs` / `excludeGlobs` 由文件开头的 URL 判断实现。没有 `scripting` 权限的扩展，安装时给副本的 manifest 补上。
  - **USER_SCRIPT world**：Chrome 里它有自己的 CSP（`configureWorld`），Tampermonkey 默认模式会打开 `unsafe-eval` / `unsafe-inline`，用 eval 和内联 `<script>` 跑脚本；Electron 只能注册到扩展的 isolated world，MV3 的 CSP 两样都禁。所以原生 content script 只负责时机和 frame：文件里是一座桥，document_start 时（页面脚本还没运行）在 DOM 上用随机频道名向页面 preload 打招呼，之后把代码交给 preload，preload 在自己创建的 world 里**同步**执行（创建 world 前先设好 CSP，Blink 按文档缓存 world 的 CSP，事后改无效）。这个 world 的 `chrome.runtime.sendMessage / connect` 经桥用 isolated world 的原生 `chrome.runtime` 发出，sender 信息都是对的。world 的 origin 是页面的，所以伪造的桥拿不到任何额外能力。页面 preload 只在主 frame 运行：子 frame 里桥无人应答，脚本退回在 isolated world 里执行（除 eval 和内联脚本外都能用）。
  - 消息路由：从 isolated world 发出的消息原生到 `onMessage` / `onConnect`；兼容层把网页来的消息同时交给 `onUserScriptMessage` / `onUserScriptConnect` 的监听者，同一个函数只调一次（Tampermonkey 把同一个监听同时挂在两边）。
  - Electron 退出后不保留动态 content script：扩展每次启动都把 main 记录的注册表同步回去（按描述比较增删改）；启动时第一个页面最多等 1.5 秒，直到这些扩展的 SW 同步完，和 content script 一样在页面加载前就位。
- **扩展页**：列表（一行一个，点进详情；需要处理的事——等着开启用户脚本、有错误——在列表上方提示）和详情 `browser://extensions?id=<id>`（访问权限、快捷键录制、可读的权限说明、SW 报的错误、来源与占用空间）。录快捷键时 main 暂停浏览器和扩展快捷键，⌘ 组合键才能录进来。SW 的错误来自 `serviceWorkers` 的 `console-message`；被重载淘汰的 worker（报 "No SW" 的）打出的错误不算。
- **扩展窗口**（`src/main/extensions/extension-window.ts`）：在扩展库创建 PopupView 之前接管工具栏点击（运行时替换 `BrowserActionAPI.activateClick`），Popup 和侧边面板都在一个带标准标题栏的子窗口里打开：可拖动、失焦不关闭、每个扩展一个、记住位置。再点一次按钮关闭。没有 Popup 也没有面板时仍派发 `action.onClicked`（必要时先唤醒 SW）。
- **Popup 尺寸**（`src/main/extensions/popup-fit.ts`）：Electron 44 不触发 `preferred-size-changed`。改为按 Chrome 的规则自行测量：内容最小不溢出宽度，以及该宽度下的高度；窗口在测量完之后才显示，之后只增大不缩小，用户手动调整过就不再跟随。
- 详细的兼容性数据见 `docs/PHASE0-REPORT.md`。

## Agent（MCP）

让 Claude Code、Codex 这类 Agent 以用户的身份使用浏览器：读网页、点击、输入、跑脚本、看控制台和网络。代码在 `src/main/agent/`，页面那一半在 `src/preload/agent-runtime.ts`。

- **默认关闭，关着时零成本**：设置里打开后，`Browser.syncAgent` 才动态导入 `agent-service`。开关和端口改动串行执行，快速来回切也不会乱。
- **传输**：主进程内置 MCP Streamable HTTP（`mcp-server.ts`，不依赖 Electron，有单测）。只回 JSON，不开 SSE（浏览器从不主动推消息，GET 回 405），没用官方 SDK，主进程不多一个依赖。只监听 `127.0.0.1`；`Host` 必须是回环地址，挡掉把自己域名重绑到 127.0.0.1 的网页；带 `Origin` 的请求一律拒绝（MCP 客户端不是网页）；每个请求都要 `Authorization: Bearer <token>`。令牌存在设置表里，可以在设置页换新。`initialize` 会发会话 id，只用来认出客户端名字（光标上显示的 "Claude Code"）；不认识的会话 id 照常服务，不强迫客户端重新握手。
- **页面在 Agent 眼里的样子**（`agent-runtime.ts`，在独立的 isolated world 1001 里运行，页面脚本看不到也改不了）：
  - `read_page`：正文转成 Markdown。先找主体（占比够大的 article / main，否则 body），去掉导航、页头页脚、cookie 横幅、分享栏这类样板内容。代码块保留语言，表格转成 Markdown 表格（布局表格退化成文本，全空的行丢掉）。为了省 token：同站链接只写路径（头部注明一次），去掉 utm_* 这类跟踪参数；图片默认不出（链接里的图片用 alt 当链接文字，正文里够大的图写成 `[image: alt]`，小图标直接丢），`images: true` 才写 `![alt](src)`；`links: false` 连链接地址也不要。`query` 只返回和问题相关的段落：按块（段落、列表、表格、代码）给关键词打分，挑分最高的塞满预算，按原文顺序带上所在的标题输出，命中标题时带上该节开头几块。内容按偏移量分页，默认 2 万字符；截断时列出后面各节标题和偏移量，可以直接跳过去。用户选中的文字会放在开头。
  - `snapshot`：类似无障碍树的精简文本。一行一个元素，写角色、可访问名称和状态（`checked`、`expanded=false`、`value=…`）。可操作的元素带 ref（`[e12]`）。不带语义的 div/span 化掉；只包着一个子元素的 listitem/row/cell 折叠；名称取自内容的元素不再重复文字；纯文字的表格行压成 `row: a | b`。没有语义但光标变成手形、或者有 `tabindex` 的元素标成 `clickable`（div 按钮）。打开着的模态框排在最前面。会穿透 open shadow DOM、slot 和同源 iframe。
  - snapshot 的压缩：重复父元素名字的图片（"@name" 链接里的头像）丢掉，带名字的控件里的图标并进同一行（`link "35,846" [e29] img "star"`）；连续三个以上没有状态的链接或按钮合成一行（`- links: "Docs" [e3], "Blog" [e4], …`）；标题里只有一个同名链接时写成 `heading level=2 > link "…" [e28]`；链接地址默认不写（没名字的链接除外），`urls: true` 才写。
  - snapshot 有大小预算（默认 1.2 万字符，约 3k token；`ref=` 时翻倍）：超了就把视口外的部分折叠成一行摘要（在视口上方/下方、约多少行、里面有多少链接按钮、有哪些标题），先折叠视口外的导航/页脚/侧栏，再选「刚好够」的那一段，都不够就折最大的。折叠的是连续的同级节点，单个元素的折叠行带 ref，`snapshot ref=` 就能展开；`find` 照样能搜到折叠掉的部分。实测（1012×804 窗口）：Wikipedia 条目 3.5 万 → 6.4K 字符，MDN Array 8.8 万 → 3.5K，GitHub Trending 1.56 万 → 9K（没超预算，靠逐行压缩）。
  - ref 按标签跨文档递增编号：新文档的运行时从上一个文档用到的编号往后接，所以旧页面的 ref 不会悄悄指到新页面的元素上，而是明确报"这个 ref 属于已离开的页面"。
- **操作走真实输入**：点击、悬停、拖动用 `sendInputEvent`，输入用 `insertText`。页面收到的事件都是 `isTrusted`。坐标是 CSS px 乘以页面缩放。点击前先滚动到视野内，再在顶层做命中测试（穿透 shadow root 和同源 iframe）。被遮住时拒绝点击，并说明被什么遮住（`covered by <div#veil>`）。macOS 的编辑快捷键（⌘A/C/X/V/Z）不经过渲染进程的按键处理，合成出来的 ⌘A 什么都选不中，所以改为直接调用 `selectAll()` 这类编辑命令。动作执行完会汇报引起的导航、新开的标签和打开的对话框；页面冻在 alert / confirm / prompt 上时由 `handle_dialog` 回答（见「网页对话框」）。
- **后台标签也能用**：从没显示过的视图是 0×0，页面不排版，所以 Agent 第一次碰它时给它卡片大小（不挂到窗口上）。光有大小还不够：后台标签是 hidden 的（见上文），不跑 rAF、IntersectionObserver 和 CSS 过渡，定时器被节流；从没画过一帧的页面还会丢掉输入（点击、按键都没反应，只有 `insertText` 能进去），`capturePage` 直接报错。所以 Agent 用一个标签时先把它叫醒（`TabDriver.wake`）：用 CDP 打开 `Emulation.setFocusEmulationEnabled`，Chromium 把它算作可见的捕获者，页面不挂到窗口上也照常渲染，一帧之内（实测约 15ms）就能点、能截图，页面也认为自己有焦点，和用户在里面打字时一样。每次工具调用、每次调用页面运行时都续期，Agent 停手 3 秒后关掉，标签回到 hidden，重新节流。`open_tab` 默认在后台打开，用户切过去就能看。
- **DevTools 协议只用在别的办法做不到的地方**：叫醒后台标签、网络记录、文件输入（`DOM.setFileInputFiles`）、拦截文件选择框。拦截只在 Agent 点击的那一下前后开启，不影响用户自己点。`open_tab` 在页面开始加载之前就挂上 Network，连主文档请求也能记到。控制台日志不走 CDP，直接用 `console-message` 事件，开启 Agent 后每个标签都记最近 300 条。
- 页面原生右键菜单会跑一个嵌套的事件循环，卡住整个主进程（包括 MCP 服务），所以 Agent 右键时把它压下去。
- **把 Agent 的操作画出来**：
  - 标签显示在屏幕上、Agent 在干活时，页面四周有一圈旋转的彩虹光：边缘一道细亮边，内侧一层会呼吸的柔光，两层转速不同，颜色会流动（`presence`）。每次工具调用都续一次；Agent 停手 45 秒时主进程把它关掉，万一这条消息没送到，页面自己 50 秒后也会关。关的时候只对已经注入了运行时的页面发消息，不会为了关灯去注入。
  - 彩虹只用在这圈光上，其余一律天空蓝、从简。光标是一个短而宽的圆角箭头：天空蓝实心填充、粗白描边、淡淡的投影，背后一圈呼吸的天空蓝光晕，滑向目标时会顺着方向倾斜一下。旁边的天空蓝标签带一个呼吸的白色状态点，写着客户端名字和正在做的事（「点击 “Sign in”」「输入到 “Email”」，按用户语言由主进程生成），靠近窗口边缘时翻到另一侧。要操作的元素外出现一个天空蓝细框；点击处扩散一圈天空蓝波纹；`snapshot` / `read_page` / `find` 时一道天空蓝扫描线从上往下扫过（最多 2.5 秒一次）。
  - 都画在 closed shadow root 里；样式全部通过 CSSOM 设置，页面的 CSP 管不到；动画用 WAAPI，只动 transform 和 opacity，页面主线程忙也不卡。彩虹是一张 96px 的 canvas 锥形渐变，由合成器放大、旋转，从不重绘，也不会生成页面大小的纹理。`prefers-reduced-motion` 时不转、不扫。
  - 后台标签不画，也不为动画等待。截图前先隐藏整个叠加层，等两帧再截。光标空闲 4 秒淡出（它的循环动画随之暂停）；光圈也没了之后 2 秒从 DOM 里移除。
  - 外壳这边：`TabState.agent`（不持久化）为真时，侧边栏标签的图标角上有个呼吸的天空蓝小点，显示中的页面卡片外有一圈同样的彩虹细边，外面一层柔光在间隙里往窗口边缘淡出（同一个 canvas 做法；柔光的遮罩把中间挖空，页面透明或还没画出来时也不会透出彩虹）。和页面里那圈光拼起来，像是光从页面边缘发出来。Agent 停手 45 秒后撤掉标记；带标记的标签不会被休眠。
- 实测：GitHub 仓库页的完整 snapshot 约 3.7 万字符（压缩前），耗时约 20 ms；正文提取约 10 ms。

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
