/**
 * Isolation boundary (directive Phase 5 / GATE 5, R8).
 *
 * No file under `src/features/ore-lite/` may import application code:
 * nothing from `@orbit-jackpot/sdk`, nothing from the app's contexts,
 * `lib/`, or any path that escapes the feature directory. Allowed: node
 * builtins and generic third-party packages. The reverse direction is
 * guarded too: only `src/pages/OrePage.tsx` (the ORE tab) may import the
 * feature.
 *
 * Deliberately a grepping test rather than an eslint plugin — the repo has
 * no eslint config, and this has zero new dependencies. Import extraction
 * is a plain string parser (no regex) over one-import-per-line source,
 * which is the uniform style of this codebase.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testsDir = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(testsDir, "../src");
const featureRoot = resolve(srcRoot, "features/ore-lite");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** First quoted substring of `s`, e.g. `"./config"` → `./config`. */
function firstQuoted(s: string): string | null {
  const quote = s[0];
  if (quote !== '"' && quote !== "'") return null;
  const end = s.indexOf(quote, 1);
  return end > 0 ? s.slice(1, end) : null;
}

/** The module specifier of a static `… from "spec"` line. */
function specAfterFrom(line: string): string | null {
  const marker = " from ";
  const at = line.lastIndexOf(marker);
  if (at === -1) return null;
  return firstQuoted(line.slice(at + marker.length).trim());
}

/** All import specifiers on a line: static, re-export, side-effect, dynamic. */
function importSpecifiers(line: string): string[] {
  const trimmed = line.trim();
  if (trimmed.startsWith("import ") || trimmed.startsWith("export ")) {
    const fromSpec = specAfterFrom(trimmed);
    if (fromSpec !== null) return [fromSpec];
    if (trimmed.startsWith("import ")) {
      const sideEffect = firstQuoted(trimmed.slice("import ".length).trim());
      if (sideEffect !== null) return [sideEffect];
    }
    return [];
  }
  const dynamicAt = trimmed.indexOf("import(");
  if (dynamicAt !== -1) {
    const dynamic = firstQuoted(trimmed.slice(dynamicAt + "import(".length).trim());
    if (dynamic !== null) return [dynamic];
  }
  return [];
}

describe("ORE Lite isolation boundary", () => {
  const featureFiles = walk(featureRoot).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));

  it("actually found the feature (guards a vacuous pass)", () => {
    expect(featureFiles.length).toBeGreaterThanOrEqual(12);
    expect(featureFiles.map((f) => relative(featureRoot, f))).toContain("OreLiteRoot.tsx");
  });

  it("no feature file imports app code (sdk, contexts, lib, or anything outside the dir)", () => {
    const violations: string[] = [];
    for (const file of featureFiles) {
      const rel = relative(srcRoot, file);
      for (const line of readFileSync(file, "utf8").split("\n")) {
        for (const spec of importSpecifiers(line)) {
          if (spec.startsWith(".")) {
            const inside = relative(featureRoot, resolve(dirname(file), spec));
            if (inside.startsWith("..") || inside === "") {
              violations.push(`${rel} imports "${spec}" (escapes the feature dir)`);
            }
          } else if (!spec.startsWith("node:") && spec.startsWith("@orbit-jackpot/")) {
            violations.push(`${rel} imports "${spec}" (project package)`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("only the ORE tab page mounts the feature from outside it", () => {
    const importers: string[] = [];
    for (const file of walk(srcRoot).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))) {
      const rel = relative(srcRoot, file);
      if (rel.startsWith("features/ore-lite/") || rel === "features/ore-lite") continue;
      const specs = readFileSync(file, "utf8").split("\n").flatMap(importSpecifiers);
      if (specs.some((s) => s.includes("features/ore-lite"))) importers.push(rel);
    }
    expect(importers).toEqual(["pages/OrePage.tsx"]);
  });
});
