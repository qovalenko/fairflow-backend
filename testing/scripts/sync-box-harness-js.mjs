#!/usr/bin/env node
/**
 * Copy compiled domain JS from dist/ into src/ for box integration harness bootstrap.
 *
 * Jest + ts-jest breaks Nest ClientGrpcProxy outbound metadata when the harness
 * loads TypeScript sources; extensionless require() of colocated src/*.js (mirrored
 * from dist/) matches the stable jest-run-4 bootstrap path.
 *
 * Run after `npm run build -w fairflow-control-service` / `fairflow-gateway` when
 * dist/ changes. Never commit the generated src/*.js — they stay untracked.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function syncDomain(domain) {
  const domainRoot = join(root, domain);
  const distRoot = join(domainRoot, "dist");
  if (!existsSync(join(distRoot, "application.js"))) {
    throw new Error(
      `${domain}: missing dist/application.js — run npm run build -w fairflow-${domain === "control" ? "control-service" : domain} first`,
    );
  }

  for (const rel of listFiles(distRoot)) {
    if (rel.startsWith("generated/")) continue;
    const from = join(distRoot, rel);
    const to = join(domainRoot, "src", rel);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to);
  }

  console.log(`sync-box-harness-js: ${domain} dist → src`);
}

function listFiles(dir, base = "") {
  const out = [];
  for (const name of readdirSync(dir)) {
    const rel = base ? `${base}/${name}` : name;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...listFiles(abs, rel));
    else if (name.endsWith(".js")) out.push(rel);
  }
  return out;
}

for (const domain of ["control", "gateway"]) {
  syncDomain(domain);
}
