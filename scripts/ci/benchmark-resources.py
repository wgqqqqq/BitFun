"""Resource observations for causal release-build experiments; no system mutation."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time


def vm_stat_fields(text):
    result = {}
    for line in text.splitlines():
        if 'page size of ' in line:
            result['page_size_bytes'] = int(line.split('page size of ', 1)[1].split()[0])
        elif ':' in line:
            key, value = line.split(':', 1)
            value = value.strip().rstrip('.')
            if value.isdigit():
                result[key.strip().strip(chr(34))] = int(value)
    return result


def read_command(args):
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=3)
        return {'exit_code': r.returncode, 'stdout': r.stdout.strip(), 'stderr': r.stderr.strip()}
    except (OSError, subprocess.TimeoutExpired) as error:
        return {'error': str(error)}


def sample_system(psutil):
    value = {'epoch': time.time(), 'cpu_times': psutil.cpu_times()._asdict(),
             'virtual_memory': psutil.virtual_memory()._asdict(),
             'swap_memory': psutil.swap_memory()._asdict(),
             'load_average': list(os.getloadavg())}
    disk = psutil.disk_io_counters()
    value['disk_io'] = disk._asdict() if disk else None
    if sys.platform == 'darwin':
        vm = read_command(['vm_stat'])
        value['vm_stat'] = vm
        if vm.get('exit_code') == 0:
            value['vm_stat_fields'] = vm_stat_fields(vm['stdout'])
        value['memory_pressure'] = read_command(['sysctl', '-n', 'kern.memorystatus_vm_pressure_level'])
        value['swap_usage'] = read_command(['sysctl', 'vm.swapusage'])
    elif sys.platform == 'linux':
        value['pressure'] = {name: Path('/proc/pressure', name).read_text() for name in ['cpu', 'memory', 'io'] if Path('/proc/pressure', name).exists()}
    return value


def monitor_resources(psutil, pid, output, stopped, started, peaks):
    """Process samples at 500ms; system counters at 5s; never invent missing data."""
    errors = []
    next_system = 0
    with (output / 'memory.jsonl').open('w') as memory, (output / 'processes.jsonl').open('w') as processes, (output / 'system.jsonl').open('w') as system:
        while not stopped.is_set():
            elapsed = time.perf_counter() - started
            rss, snapshots = [], []
            try:
                parent = psutil.Process(pid)
                for child in [parent] + parent.children(recursive=True):
                    try:
                        with child.oneshot():
                            mem = child.memory_info()
                            cpu = child.cpu_times()
                            cmd = child.cmdline()
                            crate = cmd[cmd.index('--crate-name') + 1] if '--crate-name' in cmd else None
                            snapshots.append({'pid': child.pid, 'create_time': child.create_time(), 'name': child.name(),
                                              'crate': crate, 'rss': mem.rss, 'vms': mem.vms,
                                              'cpu_user': cpu.user, 'cpu_system': cpu.system,
                                              'threads': child.num_threads(), 'status': child.status()})
                            rss.append(mem.rss)
                    except (psutil.NoSuchProcess, psutil.AccessDenied):
                        pass
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
            except Exception as error:
                errors.append(str(error))
            peaks['sampled_peak_tree_rss_bytes'] = max(peaks['sampled_peak_tree_rss_bytes'], sum(rss))
            peaks['sampled_peak_process_rss_bytes'] = max([peaks['sampled_peak_process_rss_bytes'], *rss])
            memory.write(json.dumps({'elapsed_s': elapsed, 'tree_rss_bytes': sum(rss)}) + chr(10))
            processes.write(json.dumps({'elapsed_s': elapsed, 'epoch': time.time(), 'processes': snapshots}) + chr(10))
            if elapsed >= next_system:
                try:
                    system.write(json.dumps(dict(elapsed_s=elapsed, **sample_system(psutil))) + chr(10))
                    system.flush()
                except Exception as error:
                    errors.append(str(error))
                next_system = elapsed + 5
            stopped.wait(0.5)
        try:
            system.write(json.dumps(dict(elapsed_s=time.perf_counter()-started, **sample_system(psutil))) + chr(10))
        except Exception as error:
            errors.append(str(error))
    (output / 'sampler-status.json').write_text(json.dumps({'errors': errors, 'complete': not errors}, indent=2))
