#!/usr/bin/env node
/*
 * 跑前端（TypeScript）的单元测试：`node scripts/test-web.mjs`
 *
 * 为什么需要这一层包装：测试文件里的导入是本仓库通行的**不带扩展名**写法
 * （`from "./pinyin"`，Vite 负责解析）；而 Node 的 ESM 解析器要求显式扩展名，
 * 直接 `node --test` 会 `ERR_MODULE_NOT_FOUND`。
 *
 * 与其为了跑测试把仓库里所有导入都改成 `.ts`（Vite 侧没必要，且和现有写法不一致），
 * 不如用**仓库里已经有的 esbuild**（Vite 的依赖）把测试连同它的导入打成一个文件再交给
 * `node --test`。这样解析交给 esbuild、断言交给 Node 内置测试运行器，两边都不新增依赖。
 *
 * 覆盖范围：只跑 `src/**\/*.test.ts`。跑的是真代码 —— 引擎、解析器，不是替身。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

/** 递归找出所有 `*.test.ts`。 */
function findTests(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) findTests(full, out);
    else if (name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const tests = findTests(join(ROOT, "src")).sort();
if (tests.length === 0) {
  process.stdout.write("没有找到 *.test.ts，跳过。\n");
  process.exit(0);
}

const outDir = mkdtempSync(join(tmpdir(), "fh-web-test-"));
let bundled = 0;
try {
  for (const source of tests) {
    const target = join(outDir, `${relative(join(ROOT, "src"), source).replace(/[/\\]/g, "_")}.mjs`);
    // `--bundle` 把相对导入（含 .ts）一并打进来；`--external:node:*` 保住 Node 内置模块
    execFileSync(
      require.resolve("esbuild/bin/esbuild"),
      [
        source,
        "--bundle",
        "--format=esm",
        "--platform=node",
        "--target=node20",
        "--log-level=warning",
        "--external:node:*",
        `--outfile=${target}`,
      ],
      { stdio: ["ignore", "ignore", "inherit"], cwd: ROOT },
    );
    bundled += 1;
  }

  const relativeTests = tests.map((t) => relative(ROOT, t));
  process.stdout.write(`跑 ${bundled} 个测试文件：${relativeTests.join("、")}\n`);
  execFileSync(process.execPath, ["--test", ...readdirSync(outDir).map((f) => join(outDir, f))], {
    stdio: "inherit",
    cwd: ROOT,
  });
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
