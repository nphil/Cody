#!/usr/bin/env python3
"""The worker's only door: an sshd for each connection on a Unix socket, so it has no network port at all.

    listen.py SOCKET SSHD_ARGV...   serve (cody-worker runs this as root, under tini)
    listen.py --check SOCKET        exit 0 when the socket answers with an SSH banner (the container health check)

The socket lives in a folder shared with the Cody container, which is therefore the only thing that can connect.
Each connection gets its own `sshd -i` (inetd mode) with the connection as stdin/stdout.
"""
import os
import signal
import socket
import sys


def check(path: str) -> int:
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
            conn.settimeout(10)
            conn.connect(path)
            # Introduce ourselves first, so sshd sees a client that left early rather than a broken one.
            conn.sendall(b"SSH-2.0-cody-worker-health\r\n")
            return 0 if conn.recv(4) == b"SSH-" else 1
    except OSError:
        return 1


def serve(path: str, argv: list[str]) -> None:
    # The kernel reaps the sshd children; each one gets default signal handling back before it starts
    # (Python itself ignores SIGPIPE and SIGXFSZ, and ignored signals survive exec into every job).
    signal.signal(signal.SIGCHLD, signal.SIG_IGN)
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    old = os.umask(0o177)
    try:
        server.bind(path)
    finally:
        os.umask(old)
    server.listen(64)
    print(f"cody-worker: ready on {path}", flush=True)
    while True:
        conn, _ = server.accept()
        if os.fork() == 0:
            try:
                server.close()
                for sig in (signal.SIGCHLD, signal.SIGPIPE, signal.SIGXFSZ):
                    signal.signal(sig, signal.SIG_DFL)
                os.dup2(conn.fileno(), 0)
                os.dup2(conn.fileno(), 1)
                os.execv(argv[0], argv)
            finally:
                os._exit(127)
        conn.close()


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--check":
        sys.exit(check(sys.argv[2]))
    if len(sys.argv) < 3:
        sys.exit("usage: listen.py SOCKET SSHD_ARGV... | listen.py --check SOCKET")
    serve(sys.argv[1], sys.argv[2:])
