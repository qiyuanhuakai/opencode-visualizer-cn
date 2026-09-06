# 桌面集成

Electron 中打开「设置 → 桌面」。Web 版不显示这些原生功能。

## 更新

- 应用与本机 `vis_bridge` 分别检查、下载和展示状态。
- Windows NSIS、Linux AppImage / DEB 安装版支持应用内下载安装；解压目录预览版不支持自动替换。
- macOS 保留 ad-hoc 签名：应用内检查与下载 DMG，确认后打开安装器，手动完成安装。
- `vis_bridge` 使用独立的 DEB / PKG / EXE 安装器。安装前会提示：安装器将停止守护进程，可能中断所有已连接客户端的任务。不会自动重启 bridge。
- 「安装器已打开」不是「安装成功」。本地版本无法读取时显示「未知」，不使用所连接的远程 bridge 版本冒充本地安装版本。新版本支持 `vis_bridge --version`。
- 自动检查、自动下载默认关闭；启用后可在启动时检查并下载，安装始终需要确认。普通退出不会安装更新。
- 更新仅来自项目的正式 GitHub Release。手动安装包必须具有 SHA-256 摘要，下载后和打开前分别校验；错误会显示在更新卡片中。Node 下载请求支持 `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` 环境代理。
- Windows 发布流程上传更新清单与独立 blockmap；Linux 上传更新清单，AppImage 的 blockmap 内嵌在安装包中，DEB 无独立 blockmap。只有正式发布、包含对应元数据的新版本才能提供应用自动更新；草稿不会被选中。

## 托盘与菜单

- 「最小化到托盘」和「关闭到托盘」独立设置，默认关闭。
- 托盘点击恢复窗口，托盘菜单可退出；真正退出仍执行本地编辑会话清理。
- 无可用托盘时不会隐藏唯一窗口。Linux 无桌面会话及未识别的托盘环境会保守禁用该能力。
- 原生菜单跟随应用语言，保留应用退出和编辑快捷键，去除默认 File / View / Window 等无关菜单。支持英语、简体中文、繁体中文、日语、世界语。

## 完成通知

- OpenCode 使用现有 SSE idle 通知；Codex 使用真实 `turn/completed`；ACP 使用实时 prompt 完成事件。
- Codex / ACP 的历史加载、取消、失败、断线及旧连接事件不会伪装成成功完成。
- 窗口可见且聚焦时不弹出桌面完成通知。点击通知可恢复窗口；切换后端后，旧通知不会选择错误后端的会话。
- 通知声音默认关闭。原生通知保持静音，由可选系统提示音提供单一声音源，避免双响。
- macOS 当前 ad-hoc 构建仍不支持原生通知，但可使用声音回退。系统免打扰、静音及通知权限可能阻止实际声音或通知展示。

## 本地验证

```sh
pnpm electron:preview
VIS_ELECTRON_EXECUTABLE=dist-electron/linux-unpacked/vis xvfb-run -a node scripts/qa/electron-desktop.mjs
```

可设置 `VIS_DESKTOP_QA_SERVER=http://127.0.0.1:4096`，驱动真实登录、设置交互与中英文截图；设置 `VIS_DESKTOP_QA_DOWNLOAD=1` 会实际下载并校验当前平台 bridge 安装包，但不会执行安装。用 `VIS_DESKTOP_QA_OUT` 指定证据目录。测试使用隔离用户目录并保持 Chromium 沙箱开启。
