#!/usr/bin/env python3
"""trafilatura 基线引擎（bench 离线适配）。

用法：trafilatura-engine.py <url> < html_snapshot
从 stdin 读快照 HTML，主内容抽取后以 markdown 输出到 stdout；
错误写 stderr 并以非零码退出（bench 侧记 success:false）。

运行环境：packages/bench/.venv（uv venv + uv pip install trafilatura），
入口统一经 packages/bench/scripts/trafilatura（wrapper）调用。
"""
import sys

import trafilatura
from trafilatura.settings import use_config


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: trafilatura-engine.py <url> < html", file=sys.stderr)
        return 2
    url = sys.argv[1]
    html = sys.stdin.buffer.read()

    # 关闭每页防爬延迟（离线解析无请求，延迟只会拖慢基准）
    config = use_config()
    config.set("DEFAULT", "SLEEP_TIME", "0")

    try:
        downloaded = html.decode("utf-8", errors="replace")
        md = trafilatura.extract(
            downloaded,
            url=url,
            output_format="markdown",
            include_links=True,
            include_images=True,
            include_tables=True,
            include_formatting=True,
            config=config,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"trafilatura failed: {exc}", file=sys.stderr)
        return 1

    if not md:
        print("trafilatura.extract() 返回空（未识别出主内容）", file=sys.stderr)
        return 1
    sys.stdout.write(md)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
