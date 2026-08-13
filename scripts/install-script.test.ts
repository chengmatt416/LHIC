import { execFile } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("install.sh", () => {
  it("installs CLI dependencies into the published package root and starts lhic", async () => {
    const directory = await temporaryDirectory();
    const prefix = join(directory, "prefix");
    const bin = join(directory, "bin");
    const npmRoot = join(prefix, "lib", "node_modules");
    const cliRoot = join(npmRoot, "@pinyencheng", "lhic");
    await mkdir(bin, { recursive: true });
    await executable(
      join(bin, "node"),
      '#!/bin/sh\n[ "$1" = "-p" ] && { echo 24; exit 0; }; exit 0\n',
    );
    await executable(
      join(bin, "npm"),
      `#!/bin/sh
if [ "\${NPM_CONFIG_PREFIX:-}" != '${prefix}' ]; then
  exit 9
fi
if [ "$1 $2" = "root --global" ]; then
  printf '%s\\n' '${npmRoot}'
  exit 0
fi
if [ "$1 $2" = "install --global" ]; then
  mkdir -p '${cliRoot}' '${prefix}/bin'
  cat > '${prefix}/bin/lhic' <<'LHIC'
#!/bin/sh
exit 0
LHIC
  chmod 755 '${prefix}/bin/lhic'
  exit 0
fi
case " $* " in
  *" --prefix ${cliRoot} "*)
    mkdir -p '${cliRoot}/node_modules/playwright'
    : > '${cliRoot}/node_modules/playwright/index.js'
    exit 0
    ;;
esac
exit 1
`,
    );

    const result = await runInstaller(bin, prefix, {
      LHIC_SKIP_DESKTOP: "1",
      LHIC_SKIP_BACKENDS: "1",
      NPM_CONFIG_PREFIX: "",
    });

    expect(result.stdout).toContain("CLI installed — run: lhic");
    await access(join(cliRoot, "node_modules", "playwright", "index.js"));
  });

  it("generates a deterministic glibc X11 launcher with actionable Termux guidance", async () => {
    const script = await readFile(
      resolve(root, "scripts", "install.sh"),
      "utf8",
    );
    const generated = script.match(
      /cat > "\$BIN_DIR\/lhicd" <<EOF\n([\s\S]*?)\nEOF/,
    );

    expect(generated?.[1]).toContain(
      'INNER="\\$EXTRACTED/squashfs-root/lhic-control-center"',
    );
    expect(generated?.[1]).toContain('exec "\\$INNER" --no-sandbox');
    expect(generated?.[1]).toContain("proot-distro login debian --shared-tmp");
    expect(generated?.[1]).toContain('DISPLAY="\\${DISPLAY:-:1}"');
    expect(generated?.[1]).not.toContain('find "\\$EXTRACTED"');
  });

  it("installs native Termux through Debian PRoot and forwards launcher arguments", async () => {
    const directory = await temporaryDirectory();
    const prefix = join(directory, "prefix");
    const prootPrefix = join(directory, "proot");
    const bin = join(directory, "bin");
    const log = join(directory, "commands.log");
    const installed = join(directory, "debian-installed");
    await mkdir(bin, { recursive: true });
    await executable(
      join(bin, "uname"),
      `#!/bin/sh
case "$1" in
  -s) echo Linux ;;
  -m) echo aarch64 ;;
  -o) echo Android ;;
  -r) echo android-termux ;;
esac
`,
    );
    await executable(
      join(bin, "pkg"),
      `#!/bin/sh
printf 'pkg %s\\n' "$*" >> '${log}'
exit 0
`,
    );
    await executable(
      join(bin, "proot-distro"),
      `#!/bin/sh
printf 'proot-distro %s\\n' "$*" >> '${log}'
if [ "$*" = "login debian --shared-tmp -- true" ]; then
  test -f '${installed}'
  exit
fi
if [ "$*" = "install debian" ]; then
  : > '${installed}'
  exit 0
fi
case "$*" in
  *"/bin/sh -c "*)
    mkdir -p '${prootPrefix}/bin'
    printf '#!/bin/sh\\nexit 0\\n' > '${prootPrefix}/bin/lhic'
    printf '#!/bin/sh\\nexit 0\\n' > '${prootPrefix}/bin/lhicd'
    chmod 755 '${prootPrefix}/bin/lhic' '${prootPrefix}/bin/lhicd'
    exit 0
    ;;
  *"test -x ${prootPrefix}/bin/lhicd"*)
    test -x '${prootPrefix}/bin/lhicd'
    exit
    ;;
  *"test -x ${prootPrefix}/bin/lhic"*)
    test -x '${prootPrefix}/bin/lhic'
    exit
    ;;
esac
exit 0
`,
    );

    const result = await runInstaller(bin, prefix, {
      TERMUX_VERSION: "0.119",
      LHIC_TERMUX_NATIVE: "1",
      LHIC_TERMUX_PROOT_PREFIX: prootPrefix,
      LHIC_SKIP_BACKENDS: "1",
      DISPLAY: ":7",
    });

    expect(result.stdout).toContain("Installing the Debian PRoot distribution");
    expect(result.stdout).toContain("Termux installation complete");
    await access(join(prefix, "bin", "lhic"));
    await access(join(prefix, "bin", "lhicd"));
    await execFileAsync(join(prefix, "bin", "lhic"), ["doctor", "--json"], {
      env: {
        ...process.env,
        DISPLAY: ":7",
        PATH: `${bin}:/usr/bin:/bin`,
      },
    });

    const commands = await readFile(log, "utf8");
    expect(commands).toContain("pkg install -y x11-repo");
    expect(commands).toContain("proot-distro install debian");
    expect(commands).toContain("LHIC_TERMUX_PROOT_BOOTSTRAP=1");
    expect(commands).toContain(
      `DISPLAY=:7 GDK_BACKEND=x11 ${prootPrefix}/bin/lhic doctor --json`,
    );
  });
});

async function runInstaller(
  bin: string,
  prefix: string,
  extraEnvironment: Record<string, string>,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("sh", [resolve(root, "scripts", "install.sh")], {
    cwd: root,
    env: {
      ...process.env,
      ...extraEnvironment,
      HOME: join(prefix, "home"),
      PATH: `${bin}:${join(prefix, "bin")}:/usr/bin:/bin`,
      LHIC_DESKTOP_PREFIX: prefix,
      LHIC_SKIP_NODE: "0",
    },
  });
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "lhic-installer-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function executable(path: string, content: string): Promise<void> {
  await writeFile(path, content);
  await chmod(path, 0o755);
}
