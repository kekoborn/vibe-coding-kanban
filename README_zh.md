[English](README.md) | [Русский](README_ru.md) | [Français](README_fr.md) | [Español](README_es.md) | **中文**

---

# Claude Kanban

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-required-blueviolet.svg)](https://claude.ai/code)

**Claude Code 的 Vibe Coding 看板** — 在单个浏览器标签中编排多个 AI 编程会话。

添加任务，点击开始，让 Claude Code 逐一完成。遇到速率限制？看板会自动检测，显示倒计时，并在限制重置后自动恢复。

> 📸 截图即将发布。**点击 Star** 以获取通知！

---

## 功能特性

**任务管理**
- 拖拽式看板：Backlog → In Progress → Review → Done
- 优先级：High、Medium、Low、Hold — 附可视化标识
- 按文本、优先级或项目路径搜索和筛选
- 支持附件：文件和链接
- 将任务以新提示词退回 In Progress（携带上下文重新执行）

**AI 编排**
- 自动队列：Backlog 中的任务自动在 Claude Code 中启动
- 速率限制检测，带倒计时和自动恢复（限制重置后自动发送"继续"）
- Claude Code 权限提示的自动批准模式
- 每 10 个任务执行一次 `/compact` 以节省上下文 token
- 速率限制期间任务保持 **In Progress** 状态 — 仅在 Claude 真正完成后才进入 Review

**终端管理**
- 基于 xterm.js 的实时终端，支持 WebGL 渲染
- 每个项目路径一个终端 — 多个项目并行运行
- 辅助终端用于起草任务提示词
- PTY 会话持久化，浏览器刷新后仍可恢复
- 通过 WebSocket 实时流式传输输出

**用户体验**
- 深色和浅色主题
- 可调整大小的看板/终端分割面板
- 可折叠列
- 实时日志面板

---

## 快速开始

```bash
git clone https://github.com/kekoborn/claude-kanban.git
cd claude-kanban
npm install
npm start
```

在浏览器中打开 **http://localhost:3000**。

---

## 前置要求

- **Node.js 18+**
- **Claude Code CLI** 已安装并认证（`claude` 命令可在 PATH 中访问）
- **macOS 或 Linux**（`node-pty` 的要求）

---

## 工作原理

1. **创建任务** — 在 Backlog 中添加标题和 Claude Code 提示词
2. **点击「▶ Start queue」** — 任务进入 In Progress，Claude Code 开始工作
3. **实时观看** — 终端面板实时流式展示 Claude Code 的输出
4. **自动完成** — 当 Claude 返回提示符（空闲检测），任务移至 Review
5. **速率限制？** — 看板显示计时器，等待重置，自动发送"继续"

---

## 架构

```
claude-kanban/
├── server.js       — Express + WebSocket 服务器，PTY 管理，速率限制与自动批准逻辑
├── db.js           — SQLite 数据层（better-sqlite3，WAL 模式）
└── public/
    ├── index.html  — 单页应用外壳
    ├── app.js      — 看板逻辑、拖拽、模态框、WS 客户端
    ├── terminal.js — 终端管理器（xterm.js、标签页、PTY 生命周期）
    ├── styles.css  — 完整深色/浅色主题样式
    └── favicon.svg — 看板图标
```

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 服务端 | Node.js、Express、ws（WebSocket） |
| 数据库 | SQLite via better-sqlite3（WAL 模式） |
| 终端 | @lydell/node-pty、xterm.js v5 + WebGL |
| 前端 | Vanilla JS、SortableJS、CSS custom properties |
| 文件上传 | Multer |

---

## 配置

| 变量 / 常量 | 默认值 | 说明 |
|-------------|--------|------|
| `PORT`（环境变量） | `3000` | HTTP 服务器端口 |
| `IDLE_COMPLETE_DELAY` | `10000` ms | 无输出多久后完成任务 |
| `PROMPT_COMPLETE_DELAY` | `3000` ms | 检测到 Claude 提示符后的等待时间 |
| `COMPACT_EVERY_N_TASKS` | `10` | 每 N 个任务发送一次 `/compact` |

---

## 贡献

欢迎提交 Issue 和 Pull Request！重大更改请先开 Issue 讨论。

---

## 许可证

MIT — 详见 [LICENSE](LICENSE)
