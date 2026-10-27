#!/usr/bin/env python3
"""agent-grid's activity probe: what the session's shells are doing, once a second.

A Claude Code task shell is a child of the session's process that holds `.../tasks/<id>.output` open (on its stdout or
stderr, or parked on a higher fd while a redirect of its own runs): every Bash call, foreground or background, and every
Monitor. For each one, one JSON line a second on stdout: its task id, the command it runs, its output's newest lines,
and the processes under it with their state, their CPU over the last second, the bytes they have read and written (and
per second), and the files they hold open (how, where in them, their size). It reads /proc only, starts nothing, and
ends with its parent (the session) or the pipe.

`activity.py [pid]` watches that pid's shells instead of its parent's (a check by hand).
"""
import json
import os
import re
import stat
import sys
import time

HOST = int(sys.argv[1]) if len(sys.argv) > 1 else os.getppid()
HZ = os.sysconf('SC_CLK_TCK')
TASK = re.compile(r'/tasks/([^/]+)\.output$')
EVAL = re.compile(r"&& eval '(.*)'(?: < /dev/null)? && pwd -P >\| \S+$", re.S)
NOT_FILES = ('/dev/', '/proc/', '/sys/', '/memfd:', '/dmabuf:', '/SYSV')
REMOTE = {'nfs', 'nfs4', 'cifs', 'smb3', 'smbfs', '9p', 'ceph', 'glusterfs', 'afs', 'davfs', 'sshfs'}
TAIL_BYTES = 4096
TAIL_LINES = 6
MAX_FILES = 8
MAX_PROCS = 24

seen = {}


def read(path):
    try:
        with open(path, 'rb') as f:
            return f.read().decode('utf-8', 'replace')
    except OSError:
        return None


def shown(path):
    """A path as text that is surely UTF-8: a name in another encoding gets U+FFFD where it isn't."""
    return os.fsencode(path).decode('utf-8', 'replace')


def mount_table(pid):
    """A process's mounts: mount id -> whether a stat on it can hang (network, FUSE)."""
    table = {}
    for row in (read(f'/proc/{pid}/mountinfo') or '').splitlines():
        head, _, tail = row.partition(' - ')
        fstype = tail.split(' ', 1)[0]
        table[head.split(' ', 1)[0]] = fstype in REMOTE or fstype.startswith('fuse')
    return table


def children(pid):
    kids = []
    try:
        threads = os.listdir(f'/proc/{pid}/task')
    except OSError:
        return kids
    for t in threads:
        kids.extend(int(k) for k in (read(f'/proc/{pid}/task/{t}/children') or '').split())
    return kids


def output_of(pid):
    """The task output file this process holds: on stdout, else stderr, else where a shell parks them (fd 10 and up)
    while a redirect of its own runs (`{ ...; } > log 2>&1`). A reader of the file (agent-grid's own `tail`, Grep's rg)
    holds it on a low fd: not a task. None when it holds none."""
    try:
        fds = os.listdir(f'/proc/{pid}/fd')
    except OSError:
        return None
    for fd in ['1', '2'] + sorted((f for f in fds if f.isdigit() and int(f) >= 10), key=int):
        try:
            target = os.readlink(f'/proc/{pid}/fd/{fd}')
        except OSError:
            continue
        if TASK.search(target):
            return target
    return None


def shell_of(argv):
    """The shell and the script of a `<shell> -c [-l] <script>` argv, or of the one the Bash tool's sandbox ends bwrap's
    own argv with (`bwrap ... -- <shell> -c <script>`); (None, None) for any other."""
    c = [k for k, a in enumerate(argv[:-1]) if a == '-c']
    return (argv[c[-1] - 1], argv[-1]) if c and c[-1] else (None, None)


def command_of(argv):
    """The command a Bash call runs, out of its shell's argv; None for any other shell (a Monitor's)."""
    m = EVAL.search(shell_of(argv)[1] or '')
    return m.group(1).replace("'\"'\"'", "'") if m else None


def tail(path):
    try:
        with open(path, 'rb') as f:
            size = f.seek(0, os.SEEK_END)
            start = max(0, size - TAIL_BYTES - 1)
            f.seek(start)
            data = f.read().decode('utf-8', 'replace')
    except OSError:
        return []
    lines = data.split('\n')
    if start > 0:
        part, lines = lines[0], lines[1:]
        if not any(line.strip() for line in lines) and part.strip():
            lines = ['…' + part.rpartition('\r')[2][-300:]]
    out = []
    for line in lines:
        parts = [p for p in line.split('\r') if p.strip()]
        if parts:
            out.append(parts[-1].rstrip())
    return out[-TAIL_LINES:]


def files_of(pid, out, mounts):
    """The regular files and directories it holds open, the first MAX_FILES of them, and how many it holds."""
    files = []
    count = 0
    try:
        fds = sorted(os.listdir(f'/proc/{pid}/fd'), key=int)
    except OSError:
        return files, count
    for fd in fds:
        try:
            target = os.readlink(f'/proc/{pid}/fd/{fd}')
        except OSError:
            continue
        if not target.startswith('/') or target.startswith(NOT_FILES) or target == out:
            continue
        if fd == '0' and target.endswith(' (deleted)'):
            continue
        info = read(f'/proc/{pid}/fdinfo/{fd}') or ''
        mnt = re.search(r'^mnt_id:\s*(\d+)', info, re.M)
        mnt = mnt and mnt.group(1)
        if mnt and mnt not in mounts:
            mounts.update(mount_table(pid))
        flags = re.search(r'^flags:\s*([0-7]+)', info, re.M)
        flags = int(flags.group(1), 8) if flags else 0
        size = None
        mode = 'dir' if flags & 0o200000 else None
        if not mounts.get(mnt, True):
            try:
                st = os.stat(f'/proc/{pid}/fd/{fd}')
            except OSError:
                st = None
            if st and stat.S_ISDIR(st.st_mode):
                mode = 'dir'
            elif st and stat.S_ISREG(st.st_mode):
                size = st.st_size
            elif st:
                continue
        count += 1
        if len(files) >= MAX_FILES:
            continue
        pos = re.search(r'^pos:\s*(\d+)', info, re.M)
        access = flags & 3
        mode = mode or ('w' if access == 1 else 'rw' if access == 2 else 'r')
        files.append({'path': shown(target), 'mode': mode, 'pos': int(pos.group(1)) if pos else 0, 'size': size})
    return files, count


def look(pid, now, out, mounts):
    raw = read(f'/proc/{pid}/stat')
    raw_argv = read(f'/proc/{pid}/cmdline')
    if not raw or raw_argv is None:
        return None, [], 0
    rest = raw[raw.rfind(')') + 2:].split()
    state, ticks, born = rest[0], int(rest[11]) + int(rest[12]), int(rest[19]) / HZ
    io = {}
    for row in (read(f'/proc/{pid}/io') or '').splitlines():
        key, _, value = row.partition(':')
        io[key] = int(value) if value.strip().isdigit() else 0
    rd, wr = io.get('rchar', 0), io.get('wchar', 0)
    was = seen.get(pid) or (born, 0, 0, 0)
    seen[pid] = (now, ticks, rd, wr)
    dt = now - was[0]
    argv = raw_argv.rstrip('\0').split('\0')
    comm = raw[raw.find('(') + 1:raw.rfind(')')]
    files, nfiles = files_of(pid, out, mounts)
    proc = {
        'pid': pid,
        'args': ' '.join(argv)[:400] or f'[{comm}]',
        'state': state,
        'cpu': round((ticks - was[1]) / HZ / dt * 100) if dt > 0 else 0,
        'rd': rd,
        'wr': wr,
        'rdps': round((rd - was[2]) / dt) if dt > 0 else 0,
        'wrps': round((wr - was[3]) / dt) if dt > 0 else 0,
        'files': files,
        'nfiles': nfiles,
    }
    return proc, argv, born


def task(root, now, out, mounts):
    procs = []
    top, argv, born = look(root, now, out, mounts)
    if not top:
        return None
    shell, script = shell_of(argv)
    name = os.path.basename(shell or argv[0]) or 'sh'

    def wrapper(its_argv):
        """The wrapper again: a subshell of it, or in the sandbox bwrap's own fork and the shell it runs (same script)."""
        return its_argv == argv or (script is not None and shell_of(its_argv)[1] == script)

    top['args'] = name
    top['root'] = True
    procs.append(top)
    more = 0
    stack = children(root)
    while stack:
        pid = stack.pop(0)
        kids = children(pid)
        stack[0:0] = kids
        if len(procs) > MAX_PROCS:
            if not kids or not wrapper((read(f'/proc/{pid}/cmdline') or '').rstrip('\0').split('\0')):
                more += 1
            continue
        proc, its_argv, _ = look(pid, now, out, mounts)
        if not proc:
            continue
        if wrapper(its_argv):
            if kids:
                continue
            proc['args'] = f'{name} (subshell)'
        procs.append(proc)
    m = TASK.search(out)
    return {'id': m.group(1), 'cmd': command_of(argv), 'age': round(now - born, 1), 'tail': tail(out), 'procs': procs, 'more': more}


def main():
    me = os.getpid()
    while True:
        if len(sys.argv) == 1 and os.getppid() != HOST:
            return
        now = time.clock_gettime(time.CLOCK_BOOTTIME)
        mounts = mount_table('self')
        tasks = []
        for kid in children(HOST):
            out = output_of(kid) if kid != me else None
            t = task(kid, now, out, mounts) if out else None
            if t:
                tasks.append(t)
        alive = {p['pid'] for t in tasks for p in t['procs']}
        for pid in [p for p in seen if p not in alive]:
            del seen[pid]
        sys.stdout.write(json.dumps({'tasks': tasks}, separators=(',', ':')) + '\n')
        sys.stdout.flush()
        time.sleep(1)


if __name__ == '__main__':
    try:
        main()
    except (BrokenPipeError, KeyboardInterrupt):
        os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
