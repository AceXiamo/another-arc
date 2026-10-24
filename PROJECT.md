# Personal Browser — 技术需求与开发说明

版本：v0.1  
平台：macOS（Apple Silicon 优先）  
定位：个人使用的 Chromium 浏览器，借鉴 Arc 的交互设计。

## 1. 项目目标

开发一个轻量、稳定、现代化的桌面浏览器。

核心目标：

- 提供 Arc 风格的多 Space 工作区。
- 用侧边栏代替传统顶部标签栏。
- 保留 Chrome 常见操作与快捷键。
- 尽可能兼容 Chrome 扩展。
- 数据全部本地存储，支持恢复浏览状态。
- 以自用为主，不考虑账号系统、云同步和商业化。

不要求完全复刻 Arc。优先考虑功能、性能、稳定性和使用体验。

## 2. 技术选型

初始推荐：

| 层级 | 技术 |
|---|---|
| 桌面框架 | Electron |
| 网页引擎 | Electron 内置 Chromium |
| UI | React + TypeScript |
| 构建 | Vite |
| 样式 | Tailwind CSS |
| 状态管理 | Zustand |
| 本地数据 | SQLite |
| 网页容器 | WebContentsView |
| 包管理 | pnpm |
| 桌面打包 | electron-builder |

技术选型不是强制性的。Coding Agent 应以兼容性、维护成本和稳定性为依据调整。

### 关键架构原则

采用 Main Process + Renderer Process 架构。

Main Process 负责浏览器窗口、网页视图、导航、Session、扩展及持久化。

Renderer Process 负责 React UI，包括侧边栏、地址栏、弹窗、设置及命令面板。

通过类型化 IPC 通信，不允许普通网页直接访问 Electron 或 Node.js API。

每个活跃标签页对应一个独立 WebContentsView。React 只渲染浏览器外壳，不负责渲染第三方网页。

## 3. 功能需求

### 3.1 Space 工作区

支持创建、编辑、删除和切换 Space。

每个 Space 包含：

- 名称
- 图标或 Emoji
- 主题颜色
- 标签页集合
- 独立的标签排序与激活状态

切换 Space 时保留各自打开的 Tab。

默认不同 Space 共享浏览器 Session，即 Cookie、登录状态和扩展。

架构必须预留 Profile 概念，使未来可以实现不同 Profile 的 Cookie、缓存和扩展隔离。

### 3.2 侧边栏

侧边栏包含以下区域：

1. Space 切换入口
2. 收藏或固定标签区
3. 当前 Space 的普通标签区
4. 新建标签及侧边栏控制入口

功能：

- 显示网站图标和标题
- 当前 Tab 高亮
- Tab 拖拽排序
- Tab 跨 Space 移动
- 标签固定和取消固定
- 关闭、复制标签
- 右键上下文菜单
- 侧边栏展开、收起
- 侧边栏宽度可调整
- 标签过多时独立滚动

MVP 无须实现 Arc 完整的自动归档、嵌套文件夹或复杂动画。

### 3.3 Tab 管理

支持：

- 新建、关闭、切换、重新加载
- 前进、后退
- 复制当前标签
- 恢复最近关闭的标签
- 后台打开网页
- 显示加载状态
- 显示网页图标和标题
- 页面崩溃提示与重新加载
- 应用重启后恢复 Tab

必须区分普通标签和固定标签。

关闭 Tab 后释放相关 WebContents 资源。

Space 切换不应直接销毁所有后台标签；需要设计后台标签休眠与恢复策略，避免大量 Tab 持续消耗内存。

### 3.4 地址栏与搜索

支持：

- 输入网址直接导航
- 输入关键词使用默认搜索引擎
- 自动识别 URL 和搜索词
- 输入时显示浏览历史建议
- 显示当前页面 URL
- 复制 URL
- 安全连接状态提示

默认搜索引擎可配置。

地址栏应支持 Cmd+L 快速聚焦。

### 3.5 快捷键

| 快捷键 | 功能 |
|---|---|
| Cmd+T | 新建标签 |
| Cmd+W | 关闭当前标签 |
| Cmd+Shift+T | 恢复关闭的标签 |
| Cmd+L | 聚焦地址栏 |
| Cmd+R | 刷新 |
| Cmd+Shift+R | 强制刷新 |
| Cmd+[ / ] | 前进、后退 |
| Ctrl+Tab | 下一个标签 |
| Ctrl+Shift+Tab | 上一个标签 |
| Cmd+1～9 | 切换对应标签 |
| Cmd+Shift+[ / ] | 切换 Space |
| Cmd+F | 页面内查找 |
| Cmd++ / - / 0 | 页面缩放 |

快捷键统一由 Shortcut Manager 管理，避免 React 与网页视图分别注册导致冲突。

需要处理 macOS 系统快捷键、输入框焦点及网页自身快捷键之间的优先级。

### 3.6 Chrome 扩展系统

这是项目的重点模块，必须优先验证技术可行性。

目标能力：

- 从本地文件夹导入未打包扩展
- 查看已安装扩展
- 启用、禁用、卸载扩展
- 查看扩展名称、图标、版本和权限
- 支持扩展更新与替换
- 重启后自动恢复已启用扩展
- 为扩展提供可访问的弹出界面（Popup）
- 显示扩展操作按钮，并支持固定到工具栏
- 扩展与浏览器标签系统正确关联
- 尽量支持 Manifest V3

兼容性分为三个等级：

| 等级 | 定义 |
|---|---|
| A | 安装、核心功能及 UI 正常 |
| B | 部分功能可用，存在已知限制 |
| C | 不支持或无法稳定运行 |

必须实测扩展依赖的 API，包括 `chrome.tabs`、`chrome.scripting`、`chrome.storage`、`chrome.runtime`、`chrome.action`、`chrome.webNavigation` 等。

扩展的 Popup、Background Service Worker、Content Script 和权限管理应分别验证。

扩展数据应持久化到本地用户目录。

第一阶段无需实现 Chrome Web Store 一键安装；后续根据兼容性研究结果决定是否实现合法合规的安装与更新流程。

禁止为了实现扩展兼容而全局关闭浏览器安全机制。

### 3.7 其他浏览器基础能力

MVP 应覆盖：

- Cookie 和 LocalStorage 持久化
- 网站登录状态保持
- 文件下载及保存位置选择
- 新窗口请求处理
- 文件上传
- 剪贴板
- 麦克风、摄像头、通知等权限请求
- 页面内查找
- 基础浏览历史
- HTTPS 证书错误处理
- 页面缩放
- 开发者工具

网站权限必须按来源管理，不能默认向所有网页开放。

## 4. 本地数据设计

建议至少建立以下数据实体：

**Space**

`id, name, icon, color, sortOrder, profileId, createdAt`

**Tab**

`id, spaceId, url, title, favicon, isPinned, sortOrder, createdAt, lastActiveAt`

**Profile**

`id, name, sessionPartition`

**Extension**

`id, name, version, path, enabled, installedAt`

**History**

`id, url, title, visitedAt`

**Settings**

`key, value`

浏览器关闭前保存关键状态，启动时恢复最近一次会话。

数据库写入需要有防抖机制，避免标签状态频繁变化导致持续写盘。

## 5. 模块划分

建议代码结构：

```text
src/
  main/
    app/
    windows/
    tabs/
    spaces/
    profiles/
    extensions/
    navigation/
    downloads/
    permissions/
    shortcuts/
    persistence/
    ipc/
  renderer/
    components/
    features/
      sidebar/
      spaces/
      tabs/
      address-bar/
      extensions/
      settings/
    stores/
    hooks/
  preload/
  shared/
    types/
    constants/
    ipc/
```

业务逻辑需要尽量与 UI 解耦。

Tab Manager 应提供统一操作接口，供快捷键、侧边栏、扩展系统与 IPC 调用。

## 6. 开发阶段

### Phase 0 — 技术验证

优先完成：

- Electron WebContentsView 多标签页原型
- 网页视图与 React 侧边栏交互
- Session 数据持久化
- 本地 Chrome 扩展加载
- Manifest V3 扩展兼容性验证
- 扩展 Popup 与标签页交互验证

交付技术验证报告。

如果扩展兼容性不能满足日常使用，不应立即进入完整 UI 开发。需要重新评估底层浏览器方案。

### Phase 1 — 浏览器核心

完成：

- 窗口和标签管理
- 地址栏与导航
- 多 Space
- 侧边栏
- 快捷键
- Session 恢复

达到基本可浏览网页的水平。

### Phase 2 — 浏览器完整性

完成：

- 下载与文件上传
- 权限管理
- 历史记录
- 网页查找与缩放
- 异常恢复
- 扩展管理界面
- 基础设置

### Phase 3 — 优化

完成：

- 后台标签内存回收
- 扩展兼容性修复
- UI 交互优化
- 性能分析
- macOS 打包
- 长时间稳定性测试

## 7. 安全要求

- 网页禁用 Node Integration。
- 启用 Context Isolation。
- 启用 Sandboxing。
- 不允许关闭 Web Security。
- 所有 IPC 调用进行参数和来源校验。
- 使用系统安全存储机制处理敏感数据。
- 对第三方扩展显示权限信息。
- 扩展安装目录不得允许路径穿越。
- 处理恶意 URL、外部协议和不可信弹窗。
- 不绕过 TLS 证书验证。

## 8. MVP 验收标准

- 可创建至少 3 个 Space 并自由切换。
- 每个 Space 可独立管理至少 10 个 Tab。
- 不同 Space 默认共享网站登录状态。
- Tab 拖拽排序及跨 Space 移动正常。
- 常用快捷键工作正常。
- 关闭并重新打开应用后，Space、Tab 和设置正确恢复。
- 支持普通网页导航、下载、上传及网站权限。
- 扩展可以安装、卸载、启用、禁用，并在重启后正确恢复。
- 为经过验证的扩展提供可用的操作入口。
- 浏览器视图不因 Space 切换出现严重闪烁、尺寸错乱或白屏。
- 长时间使用无明显资源泄漏。

扩展兼容性必须基于测试报告验收，不得把「扩展成功加载」当成「扩展功能完整兼容」。

## 9. 暂不实现

首个版本不需要：

- 用户账号及云同步
- 多人协作
- 移动端
- AI 助手
- 广告拦截器内置实现
- 密码管理器
- 浏览器主题商店
- Arc Boosts
- 完整的 Chrome Web Store 集成
- Chrome Profile 自动迁移

## 10. Coding Agent 执行规范

1. 首先检查当前项目目录，不覆盖已有代码。
2. 完成 Phase 0 技术验证，并记录每个技术风险及对应解决方案。
3. 不要在扩展兼容性未经验证的情况下大量开发 UI。
4. 使用 TypeScript 严格模式，关键模块提供明确的接口定义。
5. 核心业务逻辑应具备单元测试，关键浏览流程需要集成测试。
6. 每个 Phase 结束后执行构建、类型检查和测试。
7. 不要用 Mock 数据冒充已实现功能。
8. 遇到 Chromium 或 Electron 能力限制时，记录原因和替代方案，不使用不安全的绕过手段。
9. 完成一个 Phase 后更新 README、开发记录和待解决问题。
10. 优先交付可运行、可验证的功能，不追求一次实现全部需求。

最终目标是得到一款真正能长期自用的 Arc 风格浏览器，而非 UI 演示程序。

