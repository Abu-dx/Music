# Stem Monitor Desktop — 打包与安装包生成说明

> 本文档覆盖生产打包、Python Worker 分发、平台安装包生成的完整方案。

## 1. 生产打包方案

### 技术选型

| 工具 | 用途 |
|------|------|
| electron-builder | Electron 应用打包 + 安装包生成 |
| webpack / vite | renderer 进程代码打包（当前未配置，需补充） |
| tsc | main 进程 TypeScript 编译 |
| PyInstaller | Python Worker 打包为独立可执行文件 |

### 安装 electron-builder

```bash
npm install --save-dev electron-builder
```

### package.json 补充配置

```jsonc
{
  "build": {
    "appId": "com.stemmonitor.desktop",
    "productName": "Stem Monitor",
    "directories": {
      "output": "release"
    },
    "files": [
      "dist/**/*",
      "public/**/*",
      "!node_modules/.cache"
    ],
    "extraResources": [
      {
        "from": "python-dist/",
        "to": "python-worker",
        "filter": ["**/*"]
      }
    ],
    "win": {
      "target": ["nsis", "portable"],
      "icon": "public/icon.ico"
    },
    "mac": {
      "target": ["dmg", "zip"],
      "icon": "public/icon.icns",
      "category": "public.app-category.music"
    },
    "nsis": {
      "oneClick": false,
      "allowToChangeInstallationDirectory": true,
      "createDesktopShortcut": true
    }
  },
  "scripts": {
    "build:renderer": "webpack --mode production",
    "build:main": "tsc -p tsconfig.main.json",
    "build:all": "npm run build:renderer && npm run build:main",
    "pack": "electron-builder --dir",
    "dist": "electron-builder",
    "dist:win": "electron-builder --win",
    "dist:mac": "electron-builder --mac"
  }
}
```

## 2. Python Worker 打包/分发方案

### 方案：PyInstaller 打包为单目录可执行文件

```bash
# 安装 PyInstaller
pip install pyinstaller

# 打包（Windows）
pyinstaller --onedir --name stem-worker \
  --add-data "models;models" \
  python/worker/main.py

# 打包（macOS/Linux）
pyinstaller --onedir --name stem-worker \
  --add-data "models:models" \
  python/worker/main.py

# 输出位置：dist/stem-worker/
```

### 打包后集成

1. 将 `dist/stem-worker/` 复制到项目根目录的 `python-dist/` 文件夹
2. electron-builder 通过 `extraResources` 配置将其打入安装包
3. main 进程通过 `process.resourcesPath + '/python-worker/stem-worker'` 定位可执行文件

### Worker 运行时路径

```typescript
// main 进程中获取 Worker 路径
const workerPath = app.isPackaged
  ? path.join(process.resourcesPath, 'python-worker', 'stem-worker')
  : 'python'; // 开发模式直接用系统 Python
```

## 3. Windows 安装包生成

```bash
# 生成 NSIS 安装包（.exe）
npm run dist:win

# 输出位置：release/Stem Monitor Setup x.x.x.exe
```

### 前置条件

- Windows 10+ 开发环境
- 已安装 Visual C++ Build Tools（better-sqlite3 原生模块重建需要）
- `npm run build:all` 已成功执行
- `python-dist/` 目录已准备好 PyInstaller 打包输出

### 原生模块重建

```bash
# 安装 electron-rebuild
npm install --save-dev @electron/rebuild

# 重建 better-sqlite3 for Electron
npx electron-rebuild -f -w better-sqlite3
```

## 4. macOS 应用打包

```bash
# 生成 DMG 安装包
npm run dist:mac

# 输出位置：release/Stem Monitor-x.x.x.dmg
```

### 前置条件

- macOS 12+ 开发环境
- Xcode Command Line Tools 已安装
- `python-dist/` 目录已准备好

## 5. 资源、模型、Python 运行时打入安装包

### 目录结构

```
安装后目录结构（Windows）：
C:\Users\{user}\AppData\Local\Programs\Stem Monitor\
  ├── Stem Monitor.exe          # Electron 主进程
  ├── resources/
  │   ├── app.asar              # renderer + main 打包
  │   └── python-worker/        # PyInstaller 输出
  │       ├── stem-worker.exe   # Worker 可执行文件
  │       ├── models/           # ML 模型文件
  │       └── _internal/        # PyInstaller 运行时依赖
  └── ...                       # Electron 框架文件

数据目录：
C:\Users\{user}\AppData\Roaming\Stem Monitor\
  ├── stem-monitor.db           # SQLite 数据库
  ├── logs/                     # 日志文件
  └── cache/                    # 缓存目录
      ├── manifest.json
      └── {projectId}/
          ├── waveform.json
          ├── stems/
          └── exports/
```

### 模型文件说明

- Demucs 模型文件约 80-300MB（视模型选择）
- 首次运行时可从网络下载，或打入安装包
- 打入安装包时通过 `extraResources` 配置 models 目录

## 6. 常见打包失败点与排查

| 问题 | 排查方法 |
|------|---------|
| better-sqlite3 原生模块加载失败 | 执行 `npx electron-rebuild -f -w better-sqlite3`，确保编译目标匹配 Electron 版本 |
| Python Worker 在打包后找不到 | 检查 `process.resourcesPath` 路径拼接，确认 `extraResources` 配置 |
| ASAR 包内路径错误 | 确认 `files` 配置包含 `dist/**/*`，排除不需要的文件 |
| Windows 安装后启动白屏 | 检查 renderer 打包输出（webpack/vite），确认 `index.html` 路径正确 |
| macOS 签名失败 | 需要 Apple Developer 证书，见第 8 节 |
| 模型文件过大导致安装包超限 | 考虑运行时下载策略，不打入安装包 |
| Electron 30 与 Node.js 18 不兼容 | 确认 Electron 30 使用 Node.js 20.x，升级 engines 要求 |

## 7. 打包验证清单

```bash
# 1. 清理旧构建
rm -rf dist/ release/

# 2. 编译全部代码
npm run build:all

# 3. 原生模块重建
npx electron-rebuild -f -w better-sqlite3

# 4. 准备 Python Worker
# （在 python/ 目录执行 PyInstaller，输出到 python-dist/）

# 5. 打包测试（不生成安装包，只打包到目录）
npm run pack

# 6. 验证打包目录
ls release/win-unpacked/   # Windows
ls release/mac/            # macOS

# 7. 生成安装包
npm run dist
```

## 8. 签名/证书说明

### Windows 代码签名

- **需要**：EV 代码签名证书（推荐）或标准代码签名证书
- **购买渠道**：DigiCert / Sectigo / GlobalSign
- **配置方式**：在 `package.json` 的 `build.win` 中配置 `certificateFile` + `certificatePassword`
- **不签名后果**：Windows SmartScreen 会拦截安装，用户需手动允许

```jsonc
{
  "build": {
    "win": {
      "signingHashAlgorithms": ["sha256"],
      "certificateFile": "./certs/win-cert.pfx",
      "certificatePassword": "${WIN_CSC_KEY_PASSWORD}"
    }
  }
}
```

### macOS 代码签名 + 公证

- **需要**：Apple Developer Program 会员资格（99 USD/年）
- **证书类型**：Developer ID Application
- **公证**：macOS 10.15+ 要求应用必须经过 Apple 公证
- **配置**：

```bash
# 环境变量
export CSC_NAME="Developer ID Application: Your Name (TEAM_ID)"
export APPLE_ID="your@email.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="YOUR_TEAM_ID"
```

- **不签名后果**：macOS 会完全阻止应用运行（"无法验证开发者"）

### 当前状态

> ⚠️ 签名证书需要用户自行购买/申请。当前项目未包含任何证书文件。
> 开发阶段可不签名运行（Windows 手动允许，macOS 右键打开）。

---

## BS-RoFormer-SW Experimental Engine (Phase 2.5)

This project keeps **Demucs as default**. BS-RoFormer-SW is optional and experimental.

### 1) Install experimental dependencies

```bash
pip install -r python/requirements.bs.txt
pip install git+https://github.com/openmirlab/bs-roformer-infer.git
```

### 2) Enable BS experimental engine

Set environment variable before starting the app:

```bash
# PowerShell
$env:SEPARATION_ENGINE = "bs_roformer_sw"

# Optional: override command template
# Use {input} and {output} placeholders.
$env:BS_ROFORMER_CMD = "python -m bs_roformer.inference --input \"{input}\" --output-dir \"{output}\" --model bs_roformer_sw"
```

### 3) Fallback behavior

- If `SEPARATION_ENGINE` is missing or invalid, worker uses `demucs`.
- If BS execution fails, worker logs warning and **automatically falls back to Demucs**.
- Existing renderer/IPC contract is unchanged.

### 4) Back to stable default

```bash
# PowerShell
Remove-Item Env:SEPARATION_ENGINE -ErrorAction SilentlyContinue
Remove-Item Env:BS_ROFORMER_CMD -ErrorAction SilentlyContinue
```

### 5) Known limitations

- BS-RoFormer-SW is experimental in this app and not default.
- Windows setup may require extra dependency troubleshooting.
- Runtime/VRAM usage can be significantly higher than Demucs.
