# Class Assistant —— 基于 AI Agent 的班级助理

一个面向「班长」角色的 AI 助理系统：把转发通知、活动提醒、同学答疑、材料催收等机械化的班级事务，逐步交给 AI 与自动化流程完成。

目前状态：**Web 门户与安卓端、鸿蒙端已可用**（账号体系 / 通知与活动管理 / 移动端适配 / 系统日历订阅 / 安卓与鸿蒙的本地提醒、桌面小组件），并已完成一轮安全加固；Go 常驻调度进程已跑通封存自检骨架，Agent / 爬虫 / 知识库等模块在逐步建设中。

## 项目背景

班长的大量日常工作是结构化、可自动化的重复劳动。本项目通过「本地服务器 + Agent 编排 + RAG 知识库 + Web 门户」的组合，让 Agent 承担通知流转、日程提醒与常见问题答疑，既为同学提供更好的服务，也作为个人全栈与 Agent 开发的实践项目。

## 模块索引

每个一级目录都有自己的 README，讲这个目录里有什么、怎么构建、有哪些约定 —— **本文件只讲整体**。

| 目录 | 内容 | 状态 | 文档 |
| --- | --- | --- | --- |
| `web/` | Cloudflare Pages 门户（静态前端 + Functions 后端 + D1） | ✅ 已上线 `class.qxwkstudio.top` | [web/README.md](web/README.md) |
| `android/` | 安卓端（Kotlin + WebView 套壳：本地提醒 / 桌面小组件 / 离线缓存 / 后台常驻） | ✅ 已可用 | [android/README.md](android/README.md) |
| `HarmonyOS/` | 鸿蒙端（ArkTS + ArkWeb 套壳：系统提醒 / 服务卡片） | ✅ 已可用 | [HarmonyOS/README.md](HarmonyOS/README.md) |
| `internal/` | 与 Worker 对齐的 Go 规则（vault / identity / roles / ratelimit） | ✅ 已可用 | [internal/README.md](internal/README.md) |
| `cmd/` | Go 命令入口，当前只有 `cmd/scheduler` | 🚧 骨架已跑通 | [cmd/README.md](cmd/README.md) |
| `scheduler/` | 常驻调度进程的说明与现状 | 🚧 只做封存自检 | [scheduler/README.md](scheduler/README.md) |
| `agent/` | Agent 编排与提示词 | ⏳ 规划中 | [agent/README.md](agent/README.md) |
| `crawler/` | 通知抓取（将复用 `internal/`） | ⏳ 规划中 | [crawler/README.md](crawler/README.md) |
| `rag/` | 向量化与检索 | ⏳ 规划中 | [rag/README.md](rag/README.md) |

Go 模块声明在根目录 `go.mod`（go 1.22，模块路径 `github.com/AJiang233/Class-Assistant`）。

另有 `.github/`（CI 工作流 + Issue / PR 模板）与 `.claude/artifacts/plans/`（设计文档归档），是工具目录，不算项目模块。

## 功能规划

- 通知抓取与归档：轮询班级工作群，拉取新通知并结构化归档（规划中）
- 智能转发：根据通知内容判断是否需要转发到班级群，并支持人工复核（规划中）
- 知识库问答：爬取学生手册、教务处文件等归档进 RAG，群内 @ 助手即可答疑（规划中）
- 日程与提醒：✅ 已落地两条路径 —— 系统日历订阅（全平台通用）、安卓 / 鸿蒙本地到点提醒
- 个性化门户：✅ Cloudflare 网站 + 账号体系，按职位/角色展示内容与权限
- 教务数据同步：✅ 同步个人课表与学业达成（学分看板）；绑定支持 App 一键、学号密码代登录、手动粘贴 Cookie 三条路径
- 移动端：✅ 安卓原生套壳（WebView + 本地提醒 + 桌面小组件）、鸿蒙原生套壳（ArkWeb + 系统提醒 + 服务卡片）；iOS 通过 Web + 系统日历订阅覆盖

## 技术架构

| 模块 | 技术选型 |
| --- | --- |
| 门户网站（已完成） | Cloudflare Pages（静态前端 + Functions 后端 + D1 数据库） |
| 鉴权 / 权限 | JWT（HS256）+ PBKDF2 密码哈希；按职位 + 自定义职位分级权限 |
| 测试 | Web：Node 原生 `node --test`（`web/backend/test/`）；Go：标准库 `testing`（`internal/` 下各包单测）；安卓：JVM 单测 + CI 构建校验；鸿蒙：需用 DevEco 手动构建 |
| 移动端 — 安卓（已完成） | Kotlin + WebView 套壳，WorkManager 定期同步 + AlarmManager 到点提醒 + AppWidget 桌面小组件 |
| 移动端 — 鸿蒙（已完成） | ArkTS + ArkWeb 套壳，workScheduler 周期同步 + reminderAgentManager 到点提醒 + 服务卡片（Form） |
| 多端提醒（已完成） | 日历订阅 `.ics`（iOS / 鸿蒙 / Android / 桌面通用，无需安装 App） |
| 常驻调度（骨架已跑通） | Go 1.22 进程（`cmd/scheduler` + `internal/`）：与 Worker 共用 Cookie 封存 / 学号比对 / 职位白名单 / 限流规则 |
| Agent 编排 | OpenClaw（规划中） |
| 消息通道 | 微信本地 API（企业微信 / 个人微信方案待定） |
| 知识库 | 向量数据库 + RAG（规划中） |
| 本地模型 | 轻量模型（OCR / 上下文压缩 / 查询，规划中） |

## 协作分工

> 依据本仓库的提交记录整理（账号名）

| 贡献者 | 主要工作 |
| --- | --- |
| AJiang233 | 后端 API / 鉴权与权限体系 / 通知与活动数据模型、安卓端（WebView 套壳、下拉刷新、本地提醒、桌面小组件、日历订阅）、CAS 代登录的 Cookie 罐（按域 + Path 存取）与会话换取判定、课表页错误分支兜底、前端 API 超时兜底、文档 |
| TsoiTZF | Go 常驻调度（`cmd/scheduler` + `internal/`：Cookie 封存 / 学号比对 / 职位白名单 / 进程内限流，密文格式与 Worker 交叉验证）、安全审查与加固（教务越权、自定义职位提权、密码长度、MFA 次数上限） |
| TidalStarNan | 架构迁移到 Cloudflare Pages（`functions/` 接管 `/api/*`）、Web 前端主体开发与移动端布局适配修复（班级主页 / 通知 / 活动 / 账号 / 管理员页面 / 弹窗）、安卓端 GitHub Actions 打包（APK 构建与版本号注入） |
| juuuua | 鸿蒙端（ArkTS：ArkWeb 套壳与 `CAHost` JS 桥、workScheduler 后台同步、reminderAgentManager 到点提醒、服务卡片「今日活动」、教务绑定流程） |

## Roadmap

- [x] 日历 / 待办 + 网站 + 账号体系（Web 基础功能已完成）
- [x] 移动端：安卓 WebView 应用 + 本地提醒 + 桌面小组件
- [x] 移动端：鸿蒙 ArkWeb 应用 + 系统提醒 + 服务卡片
- [x] 多端提醒：系统日历订阅（iOS / 鸿蒙 / 桌面通用）
- [x] 安全加固：鉴权与提权防护 / 教务越权 / MFA 次数上限
- [x] Go 常驻调度骨架：封存自检 + 与 Worker 对齐的规则（`internal/`）
- [ ] 调度进程接入真实轮询抓取（`crawler/` 复用 `internal/`）
- [ ] 确定微信消息通道方案
- [ ] 通知抓取 + 归档 + 人工确认转发（MVP）
- [ ] RAG 知识库 + 群内答疑

## 说明

本项目用于个人学习与班级服务，请遵守各平台使用条款，并注意保护同学的个人隐私信息。教务绑定只允许本人学号，会话 Cookie 加密落库；生产环境的 `JWT_SECRET` / `COOKIE_SECRET` 必须配成 Secrets，不要写进仓库（Pages Secrets 配一次即可，Go 调度进程读同名环境变量）；本地开发复制 `web/.dev.vars.example` 为 `web/.dev.vars`。
