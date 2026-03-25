# Pilot 环境约定（必读）

## 1) 不要提交虚拟环境目录
以下目录只允许本地存在，不允许进入 Git：

- `.venv/`
- `.venv_pilot/`
- `.venv-6s-pilot/`
- `.venv6s/`

仓库已在 `.gitignore` 中忽略这些目录。

## 2) 如何重建 pilot 环境
在仓库根目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup_pilot_env.ps1
```

可选：强制重建（先删除再创建）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup_pilot_env.ps1 -Recreate
```

## 3) 如何验证 demucs 可用
脚本会自动执行健康检查：

```powershell
.venv_pilot\Scripts\python.exe -c "import demucs; print(demucs.__version__)"
```

如果命令成功并输出版本号（或 `unknown`），说明 `import demucs` 可用。

## 4) 可选环境变量（手动指定时）
一般不需要手动设置；如需固定 profile 路径，可设置：

```powershell
$env:DEMUCS_6S_PILOT_ENV_ROOT="D:\STMPrj\Music\.venv_pilot"
$env:DEMUCS_6S_PILOT_PYTHON_EXE="D:\STMPrj\Music\.venv_pilot\Scripts\python.exe"
```
