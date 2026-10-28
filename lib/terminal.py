"""Byte-only PTY transport for the official interactive CLI; never store output."""

import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time


class Terminated(Exception):
    pass


def terminate(_signal, _frame):
    raise Terminated()


def write_all(descriptor, data):
    while data:
        written = os.write(descriptor, data)
        data = data[written:]


def cleanup(child):
    # pty.fork() creates a NEW session. Killing the Python worker's process group
    # alone would orphan the CLI. Finish this inner group before the supervisor's
    # 250 ms escalation; do not reap its leader until after the final group kill.
    for termination_signal, delay in ((signal.SIGTERM, 0.05), (signal.SIGKILL, 0)):
        try:
            os.killpg(child, termination_signal)
        except ProcessLookupError:
            # A signal may arrive before the forked child completes setsid().
            try:
                os.kill(child, termination_signal)
            except ProcessLookupError:
                pass
        if delay:
            time.sleep(delay)
    try:
        os.waitpid(child, 0)
    except ChildProcessError:
        pass


def main():
    if len(sys.argv) != 2 or not sys.argv[1]:
        return 2

    # Block termination across fork so there is never an unowned inner session.
    termination_signals = {signal.SIGTERM, signal.SIGINT}
    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)
    previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, termination_signals)
    child, terminal = pty.fork()
    if child == 0:
        signal.signal(signal.SIGTERM, signal.SIG_DFL)
        signal.signal(signal.SIGINT, signal.SIG_DFL)
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        try:
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 160, 0, 0))
            environment = dict(os.environ, TERM='xterm-256color', COLUMNS='160', LINES='40')
            os.execvpe(sys.argv[1], [sys.argv[1], '--mode', 'ask'], environment)
        except (OSError, ValueError):
            os._exit(127)

    try:
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        while True:
            readable, _, _ = select.select([terminal, 0], [], [])
            if terminal in readable:
                try:
                    data = os.read(terminal, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        break  # Linux PTYs report EIO when their slave closes.
                    raise
                if not data:
                    break
                write_all(1, data)
            if 0 in readable:
                data = os.read(0, 65536)
                if not data:
                    break
                write_all(terminal, data)
    except (Terminated, OSError):
        return 1
    finally:
        # Repeated TERM/INT must not interrupt reaping or restart the grace time.
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        cleanup(child)
        os.close(terminal)
    return 0


if __name__ == '__main__':
    sys.exit(main())
