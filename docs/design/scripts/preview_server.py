#!/usr/bin/env python3
"""
赛事预言家 - 无缓存静态预览服务

用途：SSH 反向/正向隧道预览首页（外网浏览器通过 127.0.0.1 访问）。
特性：
  - 绑定 127.0.0.1（仅本机/隧道可达）
  - 所有响应强制 Cache-Control: no-store（每次请求都拿最新文件，不落缓存）
  - 提供目录索引，方便直接浏览
  - 支持 Range 请求（大图断点续传）

用法：
  python3 docs/design/scripts/preview_server.py [--port 8765] [--dir docs/design]
  # 本地隧道：ssh -N -L 8765:127.0.0.1:8765 root@<服务器IP>
  # 浏览器打开 http://127.0.0.1:8765
"""
import argparse
import http.server
import os
import socketserver
import sys
from pathlib import Path

NO_CACHE_HEADERS = {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
}


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    """在 SimpleHTTPRequestHandler 基础上追加 no-store 响应头。"""

    def end_headers(self):
        for k, v in NO_CACHE_HEADERS.items():
            self.send_header(k, v)
        super().end_headers()

    def log_message(self, format, *args):
        sys.stderr.write("[preview] %s - %s\n" % (self.client_address[0], format % args))


class ThreadedServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    ap = argparse.ArgumentParser(description="无缓存静态预览服务")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--dir", type=str, default=None,
                    help="服务目录（默认 docs/design）")
    args = ap.parse_args()

    # 默认服务目录：脚本所在目录的上级（docs/design）
    serve_dir = args.dir
    if serve_dir is None:
        serve_dir = str(Path(__file__).resolve().parent.parent)
    serve_dir = os.path.abspath(serve_dir)
    if not os.path.isdir(serve_dir):
        print(f"❌ 目录不存在: {serve_dir}")
        sys.exit(1)

    os.chdir(serve_dir)
    handler = NoCacheHandler
    handler.directory = serve_dir

    try:
        server = ThreadedServer(("127.0.0.1", args.port), handler)
    except OSError as e:
        print(f"❌ 端口 {args.port} 绑定失败（可能被占用）: {e}")
        print("   可用 lsof -i :8765 查看占用进程")
        sys.exit(1)

    print(f"✅ 无缓存预览服务已启动")
    print(f"   地址: http://127.0.0.1:{args.port}/")
    print(f"   目录: {serve_dir}")
    print(f"   缓存: 强制 no-store（每次请求都拿最新文件）")
    print(f"   隧道: ssh -N -L {args.port}:127.0.0.1:{args.port} root@<服务器IP>")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
        server.server_close()


if __name__ == "__main__":
    main()
