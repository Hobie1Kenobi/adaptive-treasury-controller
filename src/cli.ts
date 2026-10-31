import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadDotEnv } from "./env";
import { buildSession, describeRuntime } from "./runtime";
import type { DeskView } from "./treasury/session";
import { TreasurySession } from "./treasury/session";

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "serve") {
    await serve();
    return;
  }
  if (command === "demo") {
    await demo(rest.includes("--approve"));
    return;
  }
  console.log("Usage: tsx src/cli.ts demo [--approve] | tsx src/cli.ts serve");
  process.exitCode = 1;
}

async function demo(autoApprove: boolean): Promise<void> {
  const runtime = describeRuntime();
  console.log(`Adaptive Treasury Controller — ${runtime.mode} mode — ${runtime.planner}`);
  const session = buildSession();
  await runAct("Act 1 — Fund", () => session.setup());
  await runAct("Act 2 — Plan", () => session.plan());
  await runAct("Act 3 — Shock", () => session.shock());
  await runAct("Act 4 — Recalc", () => session.recalc());
  if (autoApprove) {
    await runAct("Approval", () => session.approve());
  } else {
    const answer = await ask("Approve the conversion over the autonomous cap? [y/N] ");
    if (!/^y(es)?$/i.test(answer.trim())) {
      await runAct("Decline", () => session.decline());
      console.log("Stopped before execution. No quote was booked.");
      return;
    }
    await runAct("Approval", () => session.approve());
  }
  const proof = await runAct("Act 5 — Execute", () => session.execute());
  const reserve = proof.execution?.reserveIntact ? "above the floor" : "UNDER the floor";
  console.log(
    `\nProof: conversion ${proof.execution?.conversionId ?? "-"} ${proof.execution?.conversionStatus ?? ""}; transfer ${proof.execution?.transferId ?? "-"} ${proof.execution?.transferStatus ?? ""}; USD ${proof.usdAvailable.toFixed(2)} is ${reserve}.`,
  );
  if (!proof.execution?.reserveIntact || proof.execution.transferStatus !== "PAID") {
    process.exitCode = 1;
  }
}

async function runAct(title: string, act: () => Promise<DeskView>): Promise<DeskView> {
  console.log(`\n=== ${title} ===`);
  const view = await act();
  console.log(view.narrative);
  console.log(
    `USD ${view.usdAvailable.toFixed(2)} | EUR ${amount(view, "EUR")} | GBP ${amount(view, "GBP")} | confidence ${view.confidence.toFixed(2)} | floor ${view.reserveFloorUsd.toFixed(2)}`,
  );
  for (const item of view.obligations) {
    if (!item.action) continue;
    const flag = item.affected ? " changed" : "";
    const approval = item.needsApproval ? " approval" : "";
    console.log(
      `  ${item.id} ${item.action.toUpperCase()}${approval}${flag}  ${item.currency} ${item.amount.toFixed(2)}  ${item.payee}`,
    );
  }
  if (view.warning) console.log(`Note: ${view.warning}`);
  return view;
}

function amount(view: DeskView, currency: string): string {
  return (view.balances.find((row) => row.currency === currency)?.available ?? 0).toFixed(2);
}

async function ask(question: string): Promise<string> {
  if (!input.isTTY) {
    throw new Error("No terminal is attached. Re-run with --approve to record the human approval and continue.");
  }
  const rl = readline.createInterface({ input, output });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

export async function serve(): Promise<void> {
  loadDotEnv();
  const session = buildSession();
  const port = Number(process.env.PORT ?? 4317);
  const publicDir = path.join(__dirname, "..", "public");
  const files: Record<string, { file: string; type: string }> = {
    "/": { file: "index.html", type: "text/html; charset=utf-8" },
    "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
    "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
    "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/api/state") {
        return sendJson(res, 200, session.view());
      }
      if (req.method === "GET" && url.pathname === "/api/health") {
        const runtime = describeRuntime();
        return sendJson(res, 200, { ok: true, ...runtime });
      }
      if (req.method === "POST" && url.pathname === "/api/reset") {
        return sendJson(res, 200, session.reset());
      }
      const act = url.pathname.match(/^\/api\/acts\/([a-z]+)$/);
      if (req.method === "POST" && act) {
        const name = act[1] as keyof Pick<
          TreasurySession,
          "setup" | "plan" | "shock" | "recalc" | "approve" | "decline" | "execute"
        >;
        if (typeof session[name] !== "function") {
          return sendJson(res, 404, { error: "Unknown act" });
        }
        const view = await session[name]();
        return sendJson(res, 200, view);
      }
      const asset = files[url.pathname];
      if (req.method === "GET" && asset) {
        const body = await readFile(path.join(publicDir, asset.file));
        res.writeHead(200, { "content-type": asset.type, "cache-control": "no-store" });
        res.end(body);
        return;
      }
      sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Request failed";
      sendJson(res, 400, { error: message });
    }
  });
  await new Promise<void>((resolve) => server.listen(port, "0.0.0.0", resolve));
  const runtime = describeRuntime();
  console.log(`Treasury desk at http://localhost:${port} (${runtime.mode}, ${runtime.planner})`);
}

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
