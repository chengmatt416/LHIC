#!/usr/bin/env node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export async function verifyTask({ category, task, workspace, statePath }) {
  try {
    if (category === "coding") {
      await verifyCoding(task, workspace);
    } else {
      const observed = JSON.parse(await readFile(statePath, "utf8"));
      assertSubset(observed, task.verification.state, "state");
    }
    return { passed: true, detail: "Independent verifier passed." };
  } catch (error) {
    return {
      passed: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function verifyCoding(task, workspace) {
  const modulePath = resolve(workspace, task.verification.module);
  const loaded = await import(
    `${pathToFileURL(modulePath).href}?verify=${Date.now()}`
  );
  const subject = loaded[task.verification.export];
  if (typeof subject !== "function")
    throw new Error(`Missing export ${task.verification.export}.`);
  switch (task.verification.cases) {
    case "sort-stability": {
      const source = [
        { name: "zeta", score: 4, marker: 1 },
        { name: "alpha", score: 9, marker: 2 },
        { name: "beta", score: 9, marker: 3 },
        { name: "gamma", score: 4, marker: 4 },
      ];
      const ranked = subject(source);
      equal(
        ranked.map((row) => row.marker),
        [2, 3, 1, 4],
      );
      equal(
        source.map((row) => row.marker),
        [1, 2, 3, 4],
      );
      break;
    }
    case "atomic-counter": {
      const directory = await mkdtemp(join(tmpdir(), "lhic-counter-"));
      const counterPath = join(directory, "counter.json");
      try {
        await writeFile(counterPath, '{"count":0}');
        await Promise.all(
          Array.from({ length: 20 }, () => subject(counterPath)),
        );
        const value = JSON.parse(await readFile(counterPath, "utf8"));
        if (value.count !== 20)
          throw new Error(`Expected atomic count 20, received ${value.count}.`);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
      break;
    }
    case "path-containment": {
      const root = resolve(workspace, "sandbox");
      const child = subject(root, "child/file.txt");
      if (!child.startsWith(`${root}${sep}`))
        throw new Error("Real descendant was rejected.");
      for (const escaped of [
        "../sandbox-sibling/file",
        "../../etc/passwd",
        "..\\sandbox-sibling\\file",
      ]) {
        let rejected = false;
        try {
          subject(root, escaped);
        } catch {
          rejected = true;
        }
        if (!rejected) throw new Error(`Traversal was accepted: ${escaped}`);
      }
      break;
    }
    case "stream-lines": {
      equal(subject(["alpha\r\nbe", "ta\ngamma"]), ["alpha", "beta", "gamma"]);
      equal(subject(["alpha\n"]), ["alpha"]);
      equal(subject([]), []);
      break;
    }
    default:
      throw new Error(`Unknown coding verifier ${task.verification.cases}.`);
  }
}

function assertSubset(actual, expected, path) {
  if (Array.isArray(expected)) {
    equal(actual, expected, path);
    return;
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object")
      throw new Error(`${path} is missing.`);
    for (const [key, value] of Object.entries(expected)) {
      assertSubset(actual[key], value, `${path}.${key}`);
    }
    return;
  }
  if (!Object.is(actual, expected)) {
    throw new Error(
      `${path}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`,
    );
  }
}

function equal(actual, expected, path = "value") {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${path}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`,
    );
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)
) {
  const [manifestPath, taskId, workspace, statePath] = process.argv.slice(2);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const task = manifest.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`Unknown task ${taskId}.`);
  const result = await verifyTask({
    category: manifest.category,
    task,
    workspace,
    statePath,
  });
  console.log(JSON.stringify(result));
  if (!result.passed) process.exitCode = 1;
}
