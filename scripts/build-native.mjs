import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const outputDirectory = path.join(root, "dist", "native");
const output = path.join(outputDirectory, "narada-scan");
const testOutput = path.join(outputDirectory, "narada-scan-test");
await mkdir(outputDirectory, { recursive: true });

if (process.platform !== "linux") {
  console.error("Narada scanner requires Linux native helper; unsupported platform:", process.platform);
  process.exit(1);
}

const source = path.join(root, "native", "narada-scan.c");
const compilerFlags = ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror"];
const compilerArguments = [...compilerFlags, source, "-o", output];
const child = spawn("cc", compilerArguments, { stdio: "inherit" });

child.on("error", (error) => {
  console.error(`Unable to compile native scanner with cc: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`Native scanner compiler terminated by ${signal}`);
    process.exit(1);
  }
  if (code !== 0) {
    console.error(`Native scanner compilation failed with exit code ${code ?? "unknown"}`);
    process.exit(code ?? 1);
  }
  const testChild = spawn("cc", [
    ...compilerFlags, "-DNARADA_TEST_HELPER", source, "-o", testOutput,
  ], { stdio: "inherit" });
  testChild.on("error", (error) => {
    console.error(`Unable to compile native scanner test helper with cc: ${error.message}`);
    process.exit(1);
  });
  testChild.on("exit", (testCode, testSignal) => {
    if (testSignal || testCode !== 0) {
      console.error(`Native scanner test-helper compilation failed: ${testSignal ?? testCode}`);
      process.exit(testCode ?? 1);
    }
  });
});
