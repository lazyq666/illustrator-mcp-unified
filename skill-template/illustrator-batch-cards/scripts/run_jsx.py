#!/usr/bin/env python3
"""Retired CLI entry: all Illustrator operations must use the unified MCP."""
import sys


def main():
    print(
        "ILLUSTRATOR_MCP_ONLY: 本技能已停用本地脚本执行入口。"
        "请通过统一版 illustrator-mcp-server 操作 Illustrator，"
        "先调用 get_runtime_status 核对版本与后台状态，再使用 run_script。"
        "连接或核验失败时停止并提示用户；不得切换其他 MCP、电脑或直接执行器。"
        "本次未连接或操作 Illustrator。",
        file=sys.stderr,
    )
    return 2


if __name__ == '__main__':
    sys.exit(main())
