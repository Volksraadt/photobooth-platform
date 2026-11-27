// Stops the booth stack started by `pnpm booth` (agent, kiosk, worker and the turbo runner).
// Ctrl+C in the booth terminal is the normal way; on Windows it can leave node processes running,
// so this ends: the `pnpm booth` / turbo process trees, whatever still listens on the kiosk and
// agent ports, and this repo's `tsx watch src/main.ts` processes (agent, worker).
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORTS = [5173, 47810, 47811]; // kiosk (Vite), agent local API, agent LAN (camera)

if (process.platform === 'win32') {
  const ps = `
$root = '${root.replace(/'/g, "''")}'
$self = ${process.pid}
$n = 0
$node = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -and $_.ProcessId -ne $self })
# 1. The booth launcher and turbo, with their whole process trees.
foreach ($p in $node | Where-Object { $_.CommandLine -match 'scripts[\\\\/]booth\\.mjs' -or ($_.CommandLine.Contains($root) -and $_.CommandLine -match 'turbo.*run dev') }) {
  taskkill /T /F /PID $p.ProcessId 2>$null | Out-Null; $n++
}
# 2. Leftovers: listeners on the booth ports.
foreach ($port in @(${PORTS.join(',')})) {
  foreach ($c in @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)) {
    Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue; $n++
  }
}
# 3. Leftovers: this repo's tsx watchers of src/main.ts (agent, worker).
foreach ($p in @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.Contains($root) -and $_.CommandLine -match 'tsx.*watch src[\\\\/]main\\.ts' })) {
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; $n++
}
"booth dihentikan ($n proses)"`;
  console.log(
    execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim(),
  );
} else {
  const out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  const pids = out
    .split('\n')
    .map((l) => l.trim())
    .filter(
      (l) =>
        /scripts\/booth\.mjs/.test(l) ||
        (l.includes(root) && (/turbo.*run dev/.test(l) || /tsx.*watch src\/main\.ts/.test(l))) ||
        /vite\/bin\/vite\.js/.test(l),
    )
    .map((l) => Number(l.split(/\s+/)[0]))
    .filter((pid) => pid && pid !== process.pid);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
  console.log(`booth dihentikan (${pids.length} proses)`);
}
