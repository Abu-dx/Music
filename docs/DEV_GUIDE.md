# Stem Monitor Desktop — 开发者可执行说明

> 本文档为开发团队提供从零启动到最小验收的完整操作指南。

## 1. 本地开发环境要求

| 依赖 | 最低版本 | 说明 |
|------|---------|------|
| Node.js | 18.0.0+ | package.json engines 字段已锁定 |
| npm | 9.0.0+ | 随 Node.js 18+ 自带（或使用 pnpm 8+） |
| Python | 3.10+ | Worker 进程（音频分离引擎）运行时 |
| Electron | 30.0.0+ | 已在 devDependencies 中声明，npm install 时自动安装 |
| OS | Windows 10+, macOS 12+, Linux (Ubuntu 22.04+) | Electron 30 支持范围 |
| 编辑器 | VS Code 推荐 | 配合 ESLint + TypeScript 插件 |

### Python 额外依赖（Worker 侧）

Worker 进程需要以下 Python 包（需手动准备，见第 6 节）：

```
torch >= 2.0
torchaudio >= 2.0
demucs >= 4.0       # 或 htdemucs / 其他分离引擎
librosa >= 0.10
soundfile >= 0.12
numpy >= 1.24
```

> **注意**：Python Worker 的 `requirements.txt` **尚未创建**，属于待验证项。

## 2. 首次安装依赖

```bash
cd D:\STMPrj\Music

# 安装 Node.js 依赖
npm install

# 验证 TypeScript 编译
npx tsc --noEmit
```

## 3. 开发模式启动

### 当前状态说明

**项目尚未完成可运行状态。** 目前的代码产出为：

- ✅ renderer 侧完整的类型系统、Store、Controller、Pages、Services
- ✅ shared 层的 DTO、枚举、合约
- ✅ domain 层的实体、状态机、策略
- ✅ infrastructure 层的 DB schema、文件系统管理、Worker 桥接
- ✅ application 层的 Service 骨架
- ❌ **main 进程入口 (`src/app/main/`) 为空**（仅有 .gitkeep）
- ❌ **preload bridge 未编写**
- ❌ **IPC handler 未编写**
- ❌ **HTML 入口文件未创建**
- ❌ **composition root（DI 组装）未编写**
- ❌ **Python Worker 脚本未编写**

### 预期启动流程（main 进程实现后）

```bash
# 终端 1：TypeScript 编译监听
npm run dev          # tsc --watch

# 终端 2：启动 Electron
npm start            # electron dist/app/main/index.js

# 终端 3（如需要）：Python Worker
python worker/main.py
```

## 4. 数据库初始化/迁移

- **技术**：better-sqlite3（SQLite3 嵌入式）
- **Schema 定义**：`src/infrastructure/db/schema.ts`
- **初始化时机**：main 进程启动时，由 composition root 调用 schema 初始化
- **迁移策略**：当前为 v1 schema，暂无迁移需求；后续版本升级时需编写迁移脚本
- **数据库文件位置**：`{app.getPath('userData')}/stem-monitor.db`

> **状态**：schema.ts 已定义表结构，但初始化调用代码尚未在 main 进程中编写。

## 5. Python Worker 启动方式

Worker 通过 Node.js child_process 启动，由 `workerManager.ts` 管理生命周期。

- **启动**：main 进程在收到分离请求时自动启动 Worker
- **通信**：stdout/stdin JSON 消息协议（见 `workerIpcBridge.ts`）
- **健康检查**：`workerHealthChecker.ts` 定期 ping
- **关闭**：分离完成后自动关闭（或超时强制 kill）

> **状态**：TypeScript 侧的 Worker 管理代码已编写，但 Python 端的 `main.py` 脚本尚未创建。

## 6. 日志文件位置

- **应用日志**：`{app.getPath('userData')}/logs/` 目录
- **日志框架**：`src/shared/logger.ts`（已定义接口，实际输出需 main 进程对接）
- **Worker 日志**：通过 stderr 管道回传到 main 进程，统一写入日志文件

## 7. 缓存目录位置

- **缓存根目录**：`{app.getPath('userData')}/cache/`
- **项目缓存**：`cache/{projectId}/` — 含波形、轨道文件、导出文件
- **Manifest 文件**：`cache/manifest.json`
- **管理入口**：CacheManagementPage（renderer 侧已完成 UI + contract）

## 8. 最小化手工验收流程

> ⚠️ 以下流程在 main 进程实现后方可执行。当前仅为预期路径。

1. **上传音频**：首页 → "新建项目" → 选择 .wav/.mp3/.flac/.m4a 文件
2. **分离处理**：自动跳转到 ProgressPage，显示阶段进度
3. **查看结果**：完成后跳转到 ResultPage，展示分轨列表 + 和弦摘要
4. **播放试听**：点击"进入播放器" → PlayerPage，测试单轨 mute/solo/音量
5. **导出轨道**：ResultPage → "全部导出" → 选择目录 → 等待完成
6. **缓存管理**：首页 → "缓存管理" → 查看统计、删除项目缓存

## 9. 已完成 / 未验证 / Placeholder 分类

### ✅ 已完成代码（未运行验证）

| 层级 | 文件 | 状态 |
|------|------|------|
| shared | enums.ts, contracts.ts, errors.ts, logger.ts, adr.ts, stageMapping.ts | 类型定义完成 |
| domain | entities.ts, stateMachines.ts, policies.ts, repositories.ts | 领域模型完成 |
| infrastructure | schema.ts, projectDirManager.ts, manifestManager.ts, fingerprintCalculator.ts | 基础设施完成 |
| infrastructure | workerIpcBridge.ts, workerSchemaValidator.ts, workerHealthChecker.ts, workerManager.ts | Worker 管理完成 |
| infrastructure | separationResultAdapter.ts | 结果适配完成 |
| application | projectService.ts, parseJobService.ts, cacheService.ts | Application Service 完成 |
| renderer/stores | projectStore.ts, jobStore.ts, playbackStore.ts, analysisStore.ts | Store 层完成 |
| renderer/audio | audioEngine.ts (接口), webAudioEngineAdapter.ts | 音频引擎完成 |
| renderer/controllers | playerViewController.ts | Controller 完成 |
| renderer/services | playerDataService.ts, exportService.ts | Service 合约完成 |
| renderer/pages | HomePage, UploadPage, ProgressPage, ResultPage, PlayerPage, CacheManagementPage | UI 页面完成 |

### ❌ 未编写（阻塞运行）

| 缺失项 | 说明 |
|--------|------|
| `src/app/main/index.ts` | Electron main 进程入口 |
| `src/app/main/preload.ts` | preload bridge（contextBridge） |
| `src/app/main/ipc/*` | IPC handler（projectStore API / exportService API / cacheService API） |
| `src/app/main/composition/*` | DI composition root |
| `src/app/main/window.ts` | BrowserWindow 创建 + 窗口管理 |
| `public/index.html` | HTML 入口文件 |
| `python/worker/main.py` | Python Worker 主脚本 |
| `python/requirements.txt` | Python 依赖清单 |
| webpack/vite 配置 | renderer 打包配置（当前只有 tsc） |

### ⚠️ 高风险待验证项

1. **Web Audio API 多轨同步**：webAudioEngineAdapter 的 drift 检测 + 修正逻辑未经真实音频文件验证
2. **better-sqlite3 在 Electron 中的原生模块重建**：需 electron-rebuild 或 node-gyp
3. **Python Worker 生命周期**：workerManager 的 spawn/kill 逻辑未经跨平台验证
4. **useSyncExternalStore 性能**：多 store 高频更新（如播放时间 60fps）的 React re-render 成本
5. **Canvas ResizeObserver + DPR**：HiDPI 屏幕下的实际渲染效果
6. **文件路径编码**：Windows 路径中包含中文/空格时的 file:// URL 转换
