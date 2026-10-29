import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runNativeScanner } from "../../src/library/protocol.js";

async function waitForPidFile(file: string): Promise<number> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const pid = Number(await fs.readFile(file, "utf8"));
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch { /* helper has not written yet */ }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`PID file not created: ${file}`);
}

async function assertExited(pid: number): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Process still alive: ${pid}`);
}

async function withFixture<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "narada-protocol-"));
  try { return await run(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test("test helper malformed output is rejected by scanner parser", async () => {
  await withFixture(async (root) => {
    const result = await runNativeScanner({ root, exclusions: new Set(), extensionSet: new Set([".mp3"]), helper: path.resolve("dist/native/narada-scan-test"), helperArguments: ["--test-malformed"] });
    assert.deepEqual(result.files, []);
    assert.ok(result.warnings.some((item) => /malformed/i.test(item.message)));
  });
});

test("test helper oversized output is rejected by scanner parser", async () => {
  await withFixture(async (root) => {
    const result = await runNativeScanner({ root, exclusions: new Set(), extensionSet: new Set([".mp3"]), helper: path.resolve("dist/native/narada-scan-test"), helperArguments: ["--test-oversized"] });
    assert.deepEqual(result.files, []);
    assert.ok(result.warnings.some((item) => /safety limit/i.test(item.message)));
  });
});

test("helper ignoring SIGTERM is escalated to SIGKILL", async () => {
  await withFixture(async (root) => {
    const helper = path.join(root, "ignore-term.mjs");
    const pidFile = path.join(root, "pid");
    await fs.writeFile(helper, `await import('node:fs/promises').then((fs) => fs.writeFile(${JSON.stringify(pidFile)}, String(process.pid))); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n`);
    const pidPromise = waitForPidFile(pidFile);
    const started = Date.now();
    const result = await runNativeScanner({ root, exclusions: new Set(), extensionSet: new Set(), helper: process.execPath, helperArguments: [helper], helperArgumentsBeforeRoot: true });
    assert.ok(Date.now() - started < 7000);
    assert.ok(result.warnings.some((item) => /timed out/i.test(item.message)));
    await assertExited(await pidPromise);
  });
});

test("silent helper is terminated by scanner timeout", async () => {
  await withFixture(async (root) => {
    const helper = path.join(root, "silent-helper.mjs");
    const pidFile = path.join(root, "pid");
    await fs.writeFile(helper, `await import('node:fs/promises').then((fs) => fs.writeFile(${JSON.stringify(pidFile)}, String(process.pid))); setInterval(() => {}, 1000);\n`);
    const pidPromise = waitForPidFile(pidFile);
    const started = Date.now();
    const result = await runNativeScanner({ root, exclusions: new Set(), extensionSet: new Set(), helper: process.execPath, helperArguments: [helper], helperArgumentsBeforeRoot: true });
    assert.ok(Date.now() - started < 7000);
    assert.ok(result.warnings.some((item) => /timed out/i.test(item.message)));
    await assertExited(await pidPromise);
  });
});
