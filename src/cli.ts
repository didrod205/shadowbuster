#!/usr/bin/env node
// ShadowBuster CLI — point it at a file or a folder and it tells you which
// documents are still carrying content that was supposed to be gone. Built for
// the batch case: "I scanned 500 published 'redacted' PDFs — 41 leaked the text
// underneath." Zero runtime dependencies; Node built-ins only.

import { readFile, readdir, stat } from "node:fs/promises";
import { join, extname, basename } from "node:path";
import { scanBytes } from "./scan.js";
import type { ScanResult, Severity } from "./types.js";

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
};
const useColor = process.stdout.isTTY && !process.env["NO_COLOR"];
const paint = (s: string, c: string) => (useColor ? c + s + C.reset : s);

const SUPPORTED = new Set([".pdf", ".xlsx", ".docx", ".pptx", ".png", ".jpg", ".jpeg"]);
const sevColor: Record<Severity, string> = { critical: C.red, warning: C.yellow, info: C.cyan };
const sevIcon: Record<Severity, string> = { critical: "■", warning: "▲", info: "•" };

async function collect(target: string): Promise<string[]> {
  const st = await stat(target);
  if (st.isFile()) return SUPPORTED.has(extname(target).toLowerCase()) ? [target] : [];
  const out: string[] = [];
  for (const name of await readdir(target)) {
    if (name.startsWith(".")) continue;
    const p = join(target, name);
    try {
      const cst = await stat(p);
      if (cst.isDirectory()) out.push(...(await collect(p)));
      else if (SUPPORTED.has(extname(name).toLowerCase())) out.push(p);
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

function printResult(r: ScanResult): void {
  const crit = r.findings.filter((f) => f.severity === "critical").length;
  const head = crit
    ? paint(`■ ${basename(r.fileName)}`, C.red)
    : r.findings.length
      ? paint(`▲ ${basename(r.fileName)}`, C.yellow)
      : paint(`✓ ${basename(r.fileName)}`, C.green);
  console.log(`\n${head}  ${paint(`(${r.kind}, ${(r.size / 1024).toFixed(0)} KB)`, C.dim)}`);
  for (const f of r.findings) {
    console.log(`  ${paint(sevIcon[f.severity] + " " + f.title, sevColor[f.severity])}${f.location ? paint(` — ${f.location}`, C.dim) : ""}`);
    console.log(`    ${paint(f.summary, C.dim)}`);
    if (f.recovered?.type === "text") {
      const preview = f.recovered.text.split("\n").slice(0, 6).join("\n    ").slice(0, 600);
      console.log(`    ${paint("┌ recovered:", C.dim)}\n    ${preview.replace(/\n/g, "\n    ")}`);
    } else if (f.recovered?.type === "image") {
      console.log(`    ${paint(`┌ recovered image (${f.recovered.mime}, ${f.recovered.bytes.length.toLocaleString()} bytes${f.recovered.cropped ? ", full uncropped original" : ""})`, C.dim)}`);
    }
  }
  for (const n of r.notes) console.log(`  ${paint("· " + n, C.dim)}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const targets = args.filter((a) => !a.startsWith("--"));
  if (!targets.length) {
    console.error("usage: shadowbuster <file-or-folder> [...]  [--json]");
    console.error("  reads PDF, xlsx, docx, pptx, png, jpeg — entirely locally, nothing is uploaded.");
    process.exit(2);
  }

  const files: string[] = [];
  for (const t of targets) {
    try {
      files.push(...(await collect(t)));
    } catch (e) {
      console.error(`cannot read ${t}: ${(e as Error).message}`);
    }
  }

  const results: ScanResult[] = [];
  for (const f of files) {
    try {
      results.push(await scanBytes(f, new Uint8Array(await readFile(f))));
    } catch (e) {
      console.error(`error scanning ${f}: ${(e as Error).message}`);
    }
  }

  if (json) {
    console.log(
      JSON.stringify(
        results.map((r) => ({
          ...r,
          findings: r.findings.map((f) => ({
            ...f,
            recovered:
              f.recovered?.type === "image"
                ? { type: "image", mime: f.recovered.mime, bytes: f.recovered.bytes.length, cropped: f.recovered.cropped }
                : f.recovered,
          })),
        })),
        null,
        2,
      ),
    );
    return;
  }

  for (const r of results) printResult(r);

  const leaked = results.filter((r) => r.findings.some((f) => f.severity !== "info")).length;
  const critical = results.filter((r) => r.findings.some((f) => f.severity === "critical")).length;
  console.log(
    `\n${paint(C.bold + "—".repeat(48), C.dim)}\n` +
      `Scanned ${paint(String(results.length), C.bold)} file(s) — ` +
      `${paint(String(leaked), leaked ? C.yellow : C.green)} still carr${leaked === 1 ? "ies" : "y"} hidden content` +
      (critical ? `, ${paint(String(critical), C.red)} with text/data behind a redaction` : "") +
      ".",
  );
  process.exit(critical ? 1 : 0);
}

void main();
