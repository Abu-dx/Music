# Stem Monitor Desktop — Python Worker 占位文件
#
# 本文件为最小可运行闭环的占位文件，不包含实际业务逻辑。
# 真正的 Worker 实现需在后续联调阶段补充：
# - stdin/stdout JSON 消息协议
# - Demucs / HTDemucs 分离引擎调用
# - 和弦分析引擎调用
# - 健康检查 ping/pong 响应
#
# 由 main 进程的 WorkerManager 通过 child_process.spawn 启动。

if __name__ == '__main__':
    print('[Worker] Stem Monitor Python Worker stub - not implemented yet')
