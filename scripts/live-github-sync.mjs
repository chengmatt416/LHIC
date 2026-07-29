import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const rootDir = process.cwd();
const lhicDir = join(rootDir, ".lhic");
const artifactsDir = join(lhicDir, "training-artifacts");
const SSH_KEY = process.env.HOME + "/.ssh/oracle.key";
const VM_HOST = "opc@92.5.142.29";
const SYNC_INTERVAL_MS = 30000;
const SELF_HEAL_INTERVAL = 12;

mkdirSync(lhicDir, { recursive: true });

function ts() {
  return new Date().toISOString();
}

function run(cmd, opts = {}) {
  try {
    return { ok: true, out: execSync(cmd, { cwd: rootDir, encoding: "utf8", timeout: 60000, ...opts }) };
  } catch (e) {
    return { ok: false, out: e.stdout || e.message };
  }
}

function sshRun(cmd) {
  return run(`ssh -i "${SSH_KEY}" -o ConnectTimeout=10 -o StrictHostKeyChecking=no ${VM_HOST} '${cmd}'`);
}

function selfCheck() {
  const status = sshRun("sudo systemctl is-active lhic-training");
  if (status.out.trim() !== "active") {
    console.log(`[${ts()}] [SELF-HEAL] lhic-training not active, restarting...`);
    sshRun("sudo systemctl restart lhic-training");
  }
  const serverStatus = sshRun("sudo systemctl is-active lhic-live-server");
  if (serverStatus.out.trim() !== "active") {
    console.log(`[${ts()}] [SELF-HEAL] lhic-live-server not active, restarting...`);
    sshRun("sudo systemctl restart lhic-live-server");
  }
}

async function syncLoop() {
  let cycle = 0;
  while (true) {
    cycle++;
    try {
      const vmArtifactsPath = "~/computerintent/.lhic/training-artifacts/";
      const vmStatusPath = "~/computerintent/.lhic/continuous-training-status.json";
      const vmLogPath = "~/computerintent/.lhic/continuous-training.log";

      const syncResult = run(
        `rsync -az --mkpath -e "ssh -i ${SSH_KEY} -o ConnectTimeout=10 -o StrictHostKeyChecking=no" \
          ${VM_HOST}:${vmArtifactsPath} \
          ${artifactsDir}/`
      );

      run(
        `rsync -az -e "ssh -i ${SSH_KEY} -o ConnectTimeout=10 -o StrictHostKeyChecking=no" \
          ${VM_HOST}:${vmStatusPath} \
          ${VM_HOST}:${vmLogPath} \
          ${lhicDir}/`
      );

      if (!syncResult.ok) {
        console.error(`[${ts()}] [SYNC-ERR] rsync failed: ${syncResult.out.slice(0, 120)}`);
      } else {
        run("git checkout -B training-results");
        run("git add -f .lhic/training-artifacts/ .lhic/continuous-training-status.json .lhic/continuous-training.log");
        const diff = run("git diff --cached --stat");
        if (diff.out.trim()) {
          run(`git commit -m "chore(live-sync): structured training artifacts at ${ts()} [cycle ${cycle}]"`);
          const push = run("git push origin training-results");
          if (push.ok) {
            console.log(`[${ts()}] [SYNC-OK] cycle #${cycle} pushed structured artifacts to GitHub`);
          } else {
            console.error(`[${ts()}] [PUSH-ERR] ${push.out.slice(0, 120)}`);
          }
        } else {
          console.log(`[${ts()}] [SYNC-OK] cycle #${cycle} no changes`);
        }
      }

      if (cycle % SELF_HEAL_INTERVAL === 0) {
        console.log(`[${ts()}] [SELF-CHECK] Running VM health check...`);
        selfCheck();
      }
    } catch (e) {
      console.error(`[${ts()}] [ERR] ${e.message}`);
    }

    await new Promise((r) => setTimeout(r, SYNC_INTERVAL_MS));
  }
}

console.log(`[${ts()}] LHIC Structured Artifact Sync Daemon starting (${SYNC_INTERVAL_MS / 1000}s interval + VM self-heal)...`);
syncLoop();
