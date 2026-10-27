"""Checks of hooks/activity.py that need real processes: `python3 tests/test_activity.py` (or pytest)."""
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'hooks'))
import activity  # noqa: E402

NOW = time.clock_gettime(time.CLOCK_BOOTTIME)
WRAPPER = "source /dev/null && eval 'sleep 5' && pwd -P >| /dev/null"


def test_a_vanished_pid_is_skipped():
    p = subprocess.Popen(['true'])
    p.wait()
    assert activity.look(p.pid, NOW, '', {}) == (None, [], 0)
    assert activity.task(p.pid, NOW, '/x/tasks/t.output', {}) is None


def test_a_sandboxed_bash_call_reads_as_its_shell():
    assert activity.command_of(['bwrap', '--new-session', '--die-with-parent', '--', '/usr/bin/bash', '-c', WRAPPER]) == 'sleep 5'
    assert activity.command_of(['/bin/zsh', '-c', '-l', WRAPPER]) == 'sleep 5'
    if not shutil.which('bwrap'):
        return
    p = subprocess.Popen(['bwrap', '--die-with-parent', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--',
                          '/usr/bin/bash', '-c', WRAPPER], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(50):
            t = activity.task(p.pid, NOW, '/x/tasks/t.output', {})
            if t and any(x['args'] == 'sleep 5' for x in t['procs']):
                break
            time.sleep(0.1)
        if p.poll() is not None:
            return
        assert t['cmd'] == 'sleep 5'
        assert [x['args'] for x in t['procs']] == ['bash', 'sleep 5']
    finally:
        p.kill()
        p.wait()


def test_a_file_on_a_mount_of_another_namespace_is_not_statted():
    with tempfile.NamedTemporaryFile() as f:
        f.write(b'x' * 100)
        f.flush()
        fd = f.fileno()
        mnt = re.search(r'^mnt_id:\s*(\d+)', open(f'/proc/self/fdinfo/{fd}').read(), re.M).group(1)
        own, activity.mount_table = activity.mount_table, lambda pid: {mnt: True}
        try:
            files, _ = activity.files_of(os.getpid(), None, {})
        finally:
            activity.mount_table = own
        held = [x for x in files if x['path'] == f.name]
        assert held and held[0]['size'] is None, held


if __name__ == '__main__':
    for name, check in list(globals().items()):
        if name.startswith('test_'):
            check()
    print('ok')
