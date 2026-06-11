# GitHub Pages 部署指南

本文介绍如何把 vis (OpenCode Visualizer) 部署到 GitHub Pages，让浏览器作为 SPA 直连你本机运行的 OpenCode server。

> **架构概览**：GitHub Pages 提供 HTTPS 公网托管的静态前端；你的 OpenCode server 仍跑在 `127.0.0.1:4096`（loopback）。浏览器在两者之间通过 CORS + Private Network Access (PNA) 协商。本仓库的 CSP 已放行 loopback 地址，无需额外配置前端。

---

## 1. 前提条件

| 依赖 | 版本 / 备注 |
|---|---|
| GitHub 账号 | 公开仓库即可（Private 仓库的 Pages 仅付费计划可用） |
| Node.js | ≥ 20 |
| pnpm | 10.29.3（仓库 `packageManager` 字段已锁定） |
| [OpenCode CLI](https://github.com/sst/opencode) | 最新版，提供 `opencode serve` 命令 |

---

## 2. 准备仓库

### 2.1 Fork 或 push 代码

```bash
# 你已经在自己的 fork 上工作
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main

# 或者直接 fork qiyuanhuakai/opencode-visualizer-cn
```

### 2.2 启用 GitHub Pages

在 GitHub 仓库页面：

1. 进入 **Settings → Pages**
2. **Source** 选择 **GitHub Actions**（不要选 "Deploy from a branch"）
3. 保存。名为 `github-pages` 的 environment 会被自动创建。

### 2.3 自定义域名（可选）

如果你有自有域名 `vis.example.com`：

1. **Settings → Pages → Custom domain** 填入域名
2. DNS 服务商添加 CNAME 指向 `<user>.github.io.`
3. 勾选 **Enforce HTTPS**

---

## 3. 关键步骤：启动 OpenCode 时声明 CORS

> ⚠️ **这是最容易踩的坑。** GitHub Pages 是 HTTPS 公网 origin，Chrome 的 Private Network Access (PNA) 要求对 loopback 目标发起 CORS preflight。OpenCode 默认 `--cors` 为空，不会响应 preflight，必须显式放行。

```bash
# 单 origin（用户页 / 项目页二选一）
opencode serve --cors https://<user>.github.io
opencode serve --cors https://<user>.github.io/<仓库名>

# 同时支持两种（如果你后期改了 Pages 设置）
opencode serve \
  --cors https://<user>.github.io \
  --cors https://<user>.github.io/<仓库名>

# 自定义域名
opencode serve --cors https://vis.example.com

# 常用参数
# --port     4096    # 默认
# --hostname 127.0.0.1  # 默认（本次 CSP 修复后已放行）
# --mdns             # 可选，启用 mDNS 发现
```

如使用 OpenCode TUI 而非 `opencode serve`：

```bash
opencode --hostname 127.0.0.1 --port 4096
# TUI 模式下 CORS 同样通过命令行参数配置
```

启用 Basic Auth（推荐）：

```bash
OPENCODE_SERVER_PASSWORD=your-password opencode serve --cors https://<user>.github.io
# 用户名默认为 opencode；可通过 OPENCODE_SERVER_USERNAME 覆盖
```

---

## 4. 部署前端

### 方式 A：自动部署（推荐）

本仓库已经内置 `.github/workflows/deploy.yml`，push 到 `main` 自动构建并发布。

```bash
git add app/index.html .github/workflows/deploy.yml docs/deploy-github-pages.md
git commit -m "deploy: enable GitHub Pages + relax CSP for loopback"
git push origin main
```

然后在 GitHub **Actions** 页面查看 "Deploy to GitHub Pages" workflow 执行情况。完成后访问：

- 用户页：`https://<user>.github.io/`
- 项目页：`https://<user>.github.io/<仓库名>/`

### 方式 B：手动 build + 任意静态托管

```bash
git clone https://github.com/<user>/<仓库名>.git
cd <仓库名>
pnpm install
pnpm build
# 把 dist/ 内容上传到 Netlify / Vercel / Cloudflare Pages / 自建 nginx
```

---

## 5. 首次访问与登录

1. 浏览器打开你的 Pages URL
2. 进入登录页，OpenCode 地址填：
   - `http://localhost:4096`（OpenCode 绑定 localhost）
   - `http://127.0.0.1:4096`（OpenCode 绑定 127.0.0.1，默认）
   - `http://0.0.0.0:4096`（Docker `--network=host` 等特殊场景）
3. 填入 `OPENCODE_SERVER_PASSWORD` 配置的用户名/密码（未启用 auth 则留空）
4. 点击连接

---

## 6. 排错

打开浏览器 DevTools 的 **Console** 和 **Network** 面板。

| 现象 | 原因 | 解决 |
|---|---|---|
| `Refused to connect to 'http://127.0.0.1:4096' because it violates the following Content Security Policy directive: "connect-src 'self' http://localhost:* ..."` | 旧版 dist，未应用 CSP 修复 | `pnpm build` 重新构建 / 触发 Actions 重新部署 |
| `CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.` | OpenCode 未加 `--cors` | 重启 openode 加 `--cors https://<user>.github.io` |
| `Access to fetch at 'http://127.0.0.1:4096/...' from origin 'https://<user>.github.io' has been blocked by CORS policy: Response to preflight request doesn't pass access control check: It does not have HTTP ok status.` | OpenCode 进程没启动，或端口被防火墙拦截 | `curl http://127.0.0.1:4096/global/health` 本机验证 |
| `WebSocket connection to 'ws://127.0.0.1:4096/...' failed` | 同上 | 同上 |
| `Mixed Content: The page at 'https://...' was loaded over HTTPS, but requested an insecure resource 'http://127.0.0.1:4096/...'` | 罕见：浏览器把 loopback 当作 potentially trustworthy 通常自动放行 | 用 `localhost` 替代 `127.0.0.1` 重试 |
| 登录页能进，但点连接后立即弹出 "Failed to fetch" | 端口被占用或 OpenCode 用 `--hostname 0.0.0.0` 但 mDNS 没启用 | 用 `--hostname 127.0.0.1 --port 4096` 明确绑定 |

### 6.1 快速验证 OpenCode 在线

```bash
# 健康检查（不需要 CORS）
curl http://127.0.0.1:4096/global/health
# 预期：{"healthy":true,"version":"..."}

# OpenAPI 文档（可在浏览器打开）
open http://127.0.0.1:4096/doc
```

### 6.2 验证 CORS preflight

```bash
curl -i -X OPTIONS http://127.0.0.1:4096/global/health \
  -H "Origin: https://<user>.github.io" \
  -H "Access-Control-Request-Method: GET"
# 预期响应头包含：
# Access-Control-Allow-Origin: https://<user>.github.io
# Access-Control-Allow-Methods: GET
```

---

## 7. 关于 CSP 的设计说明

`app/index.html` 的 `connect-src` 已配置为：

```
'self' http://localhost:* http://127.0.0.1:* http://0.0.0.0:* https:
       ws://localhost:*  ws://127.0.0.1:*  ws://0.0.0.0:*  wss:
```

为什么这样配置：

- **`localhost` / `127.0.0.1` / `0.0.0.0`** 都是 loopback，浏览器发起的请求只能到达用户本机。即便 Pages 被劫持，攻击者也只能让用户本机的 OpenCode 收到恶意请求——而 OpenCode 本身有 basic auth / `--cors` 白名单两道防线。
- **`0.0.0.0`** 加入主要是给 Docker `--network=host` 容器场景兜底；浏览器本不能直接路由到 `0.0.0.0`，但部分代理/网关会改写 Host 头。
- **不开放 `*`**：避免被恶意页面利用去探测企业内网。
- **可选**：如果你/部分用户 OpenCode 默认绑定 IPv6，可在 CSP 中追加 `http://[::1]:* ws://[::1]:*`。

---

## 8. 常见问题

**Q：能不能不跑 `node server.js`，纯静态托管？**
A：可以，本部署方式就是纯静态的。`server.js` 是另一种本地托管模式（默认端口 23003），适合不愿意把前端放公网的用户。

**Q：Pages 部署后多久生效？**
A：Actions workflow 跑完通常 1-2 分钟。GitHub 还会再下发 CDN 边缘节点几分钟。

**Q：能否在自定义域名下启用 Basic Auth？**
A：GitHub Pages 不支持在公网域名上挂 basic auth。安全性靠：
1. OpenCode 的 `--cors` 白名单（防止被其他站点调用）
2. OpenCode 的 `OPENCODE_SERVER_PASSWORD`（即使被调用也需要密码）
3. OpenCode 的 `--hostname 127.0.0.1`（loopback，外网探测不到）

**Q：能否让多人共用同一个 Pages 部署？**
A：技术上可以，每个用户登录页填自己的 OpenCode URL 即可。但所有人都会看到你的 Pages URL，推荐每个用户自建 Pages。

**Q：如何回滚到旧版？**
A：在 GitHub Actions 页面找到历史 workflow run，点 **Re-run jobs** 即可重放旧 commit 的部署。

---

## 9. 相关文件

| 路径 | 作用 |
|---|---|
| `app/index.html` | CSP 配置（决定浏览器允许的目标） |
| `app/utils/constants.ts` | `DEFAULT_OPENCODE_URL = 'http://localhost:4096'` |
| `app/utils/opencode.ts` | `setBaseUrl()` / `getBaseUrl()` API base URL 管理 |
| `app/composables/useCredentials.ts` | URL 持久化与恢复 |
| `vite.config.ts` | `base: './'` 已配置为 GitHub Pages 兼容的相对路径 |
| `.github/workflows/deploy.yml` | 自动部署到 GitHub Pages |
| `.github/workflows/build-electron.yml` | Electron 桌面端打包（互不影响） |