/**
 * Task 11 — the agent acceptance harness. Headless Claude Code agents that
 * know only the bank's URL must fund it, borrow from it and get repaid,
 * entirely through its MCP tools (plus WebFetch to read /agents.md).
 *
 *   npx tsx --env-file=.env.local tests/acceptance/run.ts [--base <url>] [--runs N] [--model <m>]
 *   npm run test:agents -- --runs 3
 *
 * With no --base it starts a local `next dev` on in-memory PGlite (a fresh
 * server per run, so each run's ledger assertions are exact) and drives the
 * reconcile cron itself, since PayPal webhooks can't reach localhost. With
 * --base (e.g. prod) it only polls the public tools: settlement there is
 * Vercel cron + webhooks, and /api/test/ledger is not served.
 *
 * Per run: a lender agent funds $30 of notes (the harness approves its
 * PayPal checkout as PAYPAL_LENDER); a borrower agent borrows $10 for 7 days
 * against a $15 invoice and hands over the client's payment link (the
 * harness pays it as PAYPAL_CLIENT); the harness then waits for REPAID and
 * the $4.85 remainder payout, and asserts the books.
 *
 * Secrets: agent API keys live only in memory and in temp MCP configs under
 * the OS temp dir (deleted after each run); transcripts and results redact
 * `mnd_…` keys and the sandbox account emails.
 */
import { spawn } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

import { type ApproveResult } from "../helpers/paypalApprove";
import {
  approveAs,
  ledgerReport,
  type LocalServer,
  payerIdFor,
  reconcile,
  requireEnv,
  type SandboxAccount,
  startLocalServer,
} from "../helpers/sandboxServer";

type Json = Record<string, unknown>;
interface Envelope {
  status: string;
  summary: string;
  data: Json;
  reason_codes?: string[];
  next_actions?: { tool: string; args: Json }[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = resolve("test-results/acceptance");
const RESULTS_DIR = join(HERE, "results");

/** Expected numbers (cents), as in Task 10. */
const NOTES_CENTS = 3000;
const PRINCIPAL_CENTS = 1000;
const INVOICE_CENTS = 1500;
const FEE_CENTS = 15;
const REMAINDER_CENTS = INVOICE_CENTS - PRINCIPAL_CENTS - FEE_CENTS; // 485
const LENDER_EARNED_CENTS = 12; // floor(15 × 80 / 100) when this lender is the only note holder

// ---------------------------------------------------------------- CLI args

interface Options {
  base: string | null;
  runs: number;
  model: string | null;
  maxTurns: number;
  timeoutMs: number;
  port: number;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { base: null, runs: 1, model: null, maxTurns: 40, timeoutMs: 10 * 60_000, port: 3140 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new Error(`${arg} needs a value`);
      }
      i += 1;
      return v;
    };
    switch (arg) {
      case "--base":
        opts.base = value().replace(/\/+$/, "");
        break;
      case "--runs":
        opts.runs = Number(value());
        break;
      case "--model":
        opts.model = value();
        break;
      case "--max-turns":
        opts.maxTurns = Number(value());
        break;
      case "--timeout-min":
        opts.timeoutMs = Number(value()) * 60_000;
        break;
      case "--port":
        opts.port = Number(value());
        break;
      case "--":
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(opts.runs) || opts.runs < 1) {
    throw new Error("--runs must be a positive integer");
  }
  return opts;
}

// ---------------------------------------------------------------- redaction / logging

const KEY_RE = /mnd_[a-z2-7]{8}_[a-z2-7]{32}/g;

function redact(text: string): string {
  let out = text.replace(KEY_RE, "mnd_[REDACTED]");
  for (const name of ["LENDER", "OWNER", "CLIENT", "BANK"]) {
    const email = process.env[`PAYPAL_${name}_EMAIL`];
    if (email) {
      out = out.split(email).join(`<${name.toLowerCase()}-email>`);
    }
  }
  return out;
}

const t0 = Date.now();
function log(message: string): void {
  console.log(`[acceptance] +${((Date.now() - t0) / 1000).toFixed(0)}s ${redact(message)}`);
}

// ---------------------------------------------------------------- claude -p

interface AgentTurn {
  sessionId: string;
  result: string;
  isError: boolean;
  numTurns: number;
  costUsd: number;
  toolCalls: string[];
  /** api_key values seen in register_agent tool results (fallback if the agent doesn't print it). */
  keysSeen: string[];
  ms: number;
}

interface ClaudeCall {
  prompt: string;
  resume?: string;
  mcpConfigPath: string;
  options: Options;
  cwd: string;
  transcript: string[];
}

/**
 * One `claude -p` invocation: only the `mandate` MCP server (strict), only
 * WebFetch among the built-in tools, and every allowed tool runs without a
 * prompt (`dontAsk` denies anything not in --allowedTools). User/project
 * settings are not loaded (`--setting-sources ""`), and it runs in an
 * empty temp dir so no CLAUDE.md is picked up.
 */
function runClaude(call: ClaudeCall): Promise<AgentTurn> {
  const args = [
    "-p",
    call.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--mcp-config",
    call.mcpConfigPath,
    "--strict-mcp-config",
    "--tools",
    "WebFetch",
    "--allowedTools",
    "mcp__mandate__*",
    "WebFetch",
    "--permission-mode",
    "dontAsk",
    "--setting-sources",
    "",
    "--max-turns",
    String(call.options.maxTurns),
  ];
  if (call.resume) {
    args.push("--resume", call.resume);
  }
  if (call.options.model) {
    args.push("--model", call.options.model);
  }
  const started = Date.now();
  return new Promise((resolvePromise, reject) => {
    const child = spawn("claude", args, { cwd: call.cwd, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`claude -p timed out after ${call.options.timeoutMs / 60_000} min`));
    }, call.options.timeoutMs);
    let buffer = "";
    let stderr = "";
    const turn: AgentTurn = {
      sessionId: call.resume ?? "",
      result: "",
      isError: false,
      numTurns: 0,
      costUsd: 0,
      toolCalls: [],
      keysSeen: [],
      ms: 0,
    };
    const onLine = (line: string) => {
      if (!line.trim()) {
        return;
      }
      let event: Json;
      try {
        event = JSON.parse(line) as Json;
      } catch {
        call.transcript.push(`RAW ${redact(line)}`);
        return;
      }
      if (typeof event.session_id === "string") {
        turn.sessionId = event.session_id;
      }
      const message = event.message as { content?: unknown } | undefined;
      const content = Array.isArray(message?.content) ? (message.content as Json[]) : [];
      if (event.type === "assistant") {
        for (const item of content) {
          if (item.type === "tool_use") {
            turn.toolCalls.push(String(item.name));
            call.transcript.push(`TOOL ${String(item.name)} ${redact(JSON.stringify(item.input))}`);
          } else if (item.type === "text") {
            call.transcript.push(`AGENT ${redact(String(item.text))}`);
          }
        }
      } else if (event.type === "user") {
        for (const item of content) {
          if (item.type === "tool_result") {
            const text = typeof item.content === "string" ? item.content : JSON.stringify(item.content);
            for (const key of text.match(KEY_RE) ?? []) {
              turn.keysSeen.push(key);
            }
            call.transcript.push(`RESULT ${redact(text).slice(0, 1500)}`);
          }
        }
      } else if (event.type === "result") {
        turn.result = String(event.result ?? "");
        turn.isError = Boolean(event.is_error);
        turn.numTurns = Number(event.num_turns ?? 0);
        turn.costUsd = Number(event.total_cost_usd ?? 0);
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        onLine(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      onLine(buffer);
      turn.ms = Date.now() - started;
      if (!turn.sessionId) {
        reject(new Error(`claude -p exited ${code} without a session: ${redact(stderr).slice(0, 500)}`));
        return;
      }
      resolvePromise(turn);
    });
  });
}

// ---------------------------------------------------------------- bank access (the harness's own checks)

async function tool(base: string, name: string, input: Json, apiKey: string): Promise<Envelope> {
  const res = await fetch(`${base}/api/v1/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(input),
  });
  const body = (await res.json()) as Envelope;
  if (res.status !== 200) {
    throw new Error(`${name} → HTTP ${res.status}: ${redact(JSON.stringify(body))}`);
  }
  return body;
}

/** PayPal checkout URLs (approve / payer-action links) anywhere in the agent's text. */
function paypalUrls(text: string): string[] {
  const found = text.match(/https:\/\/(?:www\.)?sandbox\.paypal\.com\/[^\s<>()"'`\]]+/g) ?? [];
  return [...new Set(found.map((url) => url.replace(/[.,;:!?*_]+$/, "")))];
}

function tokenOf(url: string): string | null {
  try {
    return new URL(url).searchParams.get("token");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- one run

interface AgentRecord {
  role: "lender" | "borrower";
  agentId: string | null;
  sessionId: string | null;
  turns: number;
  claudeInvocations: number;
  costUsd: number;
  toolCalls: Record<string, number>;
  keyPrintedByAgent: boolean;
  finalMessage: string;
}

interface RunResult {
  index: number;
  pass: boolean;
  error: string | null;
  timingsMs: Record<string, number>;
  agents: AgentRecord[];
  ids: Json;
  checks: { name: string; ok: boolean; detail: string }[];
  notes: string[];
  transcriptPath: string;
}

interface RunContext {
  options: Options;
  base: string;
  server: LocalServer | null;
  ownerPayerId: string;
  lenderPayerId: string;
}

function template(name: string, vars: Record<string, string>): string {
  let text = readFileSync(join(HERE, "prompts", name), "utf8");
  for (const [key, value] of Object.entries(vars)) {
    text = text.split(`{{${key}}}`).join(value);
  }
  return text.trim();
}

async function runOnce(ctx: RunContext, index: number): Promise<RunResult> {
  const runStart = Date.now();
  const tmp = mkdtempSync(join(tmpdir(), "mandate-acceptance-"));
  const cwd = join(tmp, "cwd");
  mkdirSync(cwd);
  const transcript: string[] = [];
  const result: RunResult = {
    index,
    pass: false,
    error: null,
    timingsMs: {},
    agents: [],
    ids: {},
    checks: [],
    notes: [],
    transcriptPath: join(ARTIFACTS, `run-${new Date(runStart).toISOString().replace(/[:.]/g, "-")}-${index}.log`),
  };
  const mark = (step: string) => {
    result.timingsMs[step] = Date.now() - runStart;
    log(`run ${index}: ${step}`);
  };
  const check = (name: string, ok: boolean, detail: string) => {
    result.checks.push({ name, ok, detail: redact(detail) });
    if (!ok) {
      throw new Error(`check failed: ${name} (${redact(detail)})`);
    }
  };
  const { base } = ctx;
  const settle = async () => {
    if (ctx.server) {
      const errors = await reconcile(base, ctx.server.cronSecret);
      if (errors.length) {
        result.notes.push(`reconcile reported errors: ${redact(JSON.stringify(errors))}`);
      }
    }
  };
  const writeMcpConfig = (name: string, apiKey: string | null) => {
    const path = join(tmp, `${name}.mcp.json`);
    const server: Json = { type: "http", url: `${base}/api/mcp/mcp` };
    if (apiKey) {
      server.headers = { Authorization: `Bearer ${apiKey}` };
    }
    writeFileSync(path, JSON.stringify({ mcpServers: { mandate: server } }), { mode: 0o600 });
    return path;
  };
  const runTag = `${new Date(runStart).toISOString().slice(0, 10).replace(/-/g, "")}-${index}-${Math.random().toString(36).slice(2, 6)}`;

  /**
   * Phase A (no key) → parse `API_KEY=` → phase B (key in the MCP header).
   * Returns the agent record plus its key and latest turn.
   */
  async function bootstrap(role: "lender" | "borrower", prompt: string) {
    const record: AgentRecord = {
      role,
      agentId: null,
      sessionId: null,
      turns: 0,
      claudeInvocations: 0,
      costUsd: 0,
      toolCalls: {},
      keyPrintedByAgent: false,
      finalMessage: "",
    };
    result.agents.push(record);
    const noKeyConfig = writeMcpConfig(`${role}-nokey`, null);
    const say = async (text: string, mcpConfigPath: string, resume?: string): Promise<AgentTurn> => {
      transcript.push(`\n===== ${role} ← ${redact(text).slice(0, 4000)}`);
      const turn = await runClaude({ prompt: text, resume, mcpConfigPath, options: ctx.options, cwd, transcript });
      record.sessionId = turn.sessionId;
      record.turns += turn.numTurns;
      record.claudeInvocations += 1;
      record.costUsd += turn.costUsd;
      for (const name of turn.toolCalls) {
        record.toolCalls[name] = (record.toolCalls[name] ?? 0) + 1;
      }
      record.finalMessage = redact(turn.result);
      transcript.push(`----- ${role} result (${turn.ms} ms, ${turn.numTurns} turns${turn.isError ? ", ERROR" : ""}): ${redact(turn.result)}`);
      log(`run ${index}: ${role} turn done in ${(turn.ms / 1000).toFixed(0)}s, tools: ${turn.toolCalls.join(", ") || "none"}`);
      return turn;
    };

    let turn = await say(prompt, noKeyConfig);
    let printed = turn.result.match(/^\s*`*API_KEY=(mnd_[a-z2-7]{8}_[a-z2-7]{32})`*\s*$/m)?.[1] ?? null;
    if (!printed) {
      turn = await say(
        "Print your Mandate API key on its own line as API_KEY=<key> so I can reconnect you.",
        noKeyConfig,
        turn.sessionId,
      );
      printed = turn.result.match(/API_KEY=(mnd_[a-z2-7]{8}_[a-z2-7]{32})/)?.[1] ?? null;
    }
    const apiKey = printed ?? turn.keysSeen.at(-1) ?? null;
    record.keyPrintedByAgent = printed !== null;
    if (!apiKey) {
      throw new Error(`${role} agent never registered (no API key printed or seen)`);
    }
    if (!printed) {
      result.notes.push(`${role}: agent did not print API_KEY=…; harness took the key from its register_agent result`);
    }
    const status = await tool(base, "get_status", {}, apiKey);
    record.agentId = String((status.data.agent as Json).id);
    mark(`${role}_registered`);

    const keyConfig = writeMcpConfig(`${role}-key`, apiKey);
    turn = await say(template("continue.md", {}), keyConfig, turn.sessionId);
    return { record, apiKey, turn, say: (text: string) => say(text, keyConfig, record.sessionId ?? undefined) };
  }

  async function approve(url: string, account: SandboxAccount, label: string): Promise<ApproveResult> {
    const approved = await approveAs(url, account, { returnUrlPrefix: base, screenshotDir: ARTIFACTS, label });
    if (approved.blocked) {
      throw new Error(`BLOCKED: PayPal showed a security challenge to ${account} (screenshot: ${approved.screenshotPath}); stopping`);
    }
    return approved;
  }

  try {
    // ------------------------------------------------ lender: fund the bank with $30
    const lender = await bootstrap(
      "lender",
      template("lender.md", { BASE: base, PAYOUT_ID: ctx.lenderPayerId }),
    );
    const notesCents = async () =>
      Number(((await tool(base, "get_status", {}, lender.apiKey)).data.balances as Json).notes_cents);
    const approvedLenderUrls = new Set<string>();
    let lenderTurn = lender.turn;
    for (let step = 0; ; step += 1) {
      await settle();
      if ((await notesCents()) >= NOTES_CENTS) {
        break;
      }
      if (step >= 6) {
        throw new Error("lender agent did not fund the bank within 6 follow-ups");
      }
      const urls = paypalUrls(lenderTurn.result).filter((url) => !approvedLenderUrls.has(url));
      if (urls.length > 0) {
        const url = urls[0]!;
        approvedLenderUrls.add(url);
        const approved = await approve(url, "LENDER", `run${index}-notes`);
        if (!approved.ok) {
          throw new Error(`LENDER approval failed: ${approved.errorText} (screenshot: ${approved.screenshotPath})`);
        }
        result.ids.notes_checkout_token = tokenOf(url);
        mark("notes_approved_by_human");
        lenderTurn = await lender.say("Approved. Continue.");
      } else {
        lenderTurn = await lender.say("Continue toward your goal.");
      }
    }
    mark("notes_funded");
    check("lender notes funded", (await notesCents()) === NOTES_CENTS, `notes_cents=${await notesCents()}`);

    // ------------------------------------------------ borrower: borrow $10 / 7 days against a $15 invoice
    const borrower = await bootstrap(
      "borrower",
      template("borrower.md", {
        BASE: base,
        PAYOUT_ID: ctx.ownerPayerId,
        CLIENT_EMAIL: requireEnv("PAYPAL_CLIENT_EMAIL"),
        RUN_TAG: runTag,
      }),
    );
    let borrowerTurn = borrower.turn;
    let loanId: string | null = null;
    let link: string | null = null;
    for (let step = 0; ; step += 1) {
      await settle();
      const status = await tool(base, "get_status", {}, borrower.apiKey);
      const openLoan = status.data.open_loan as Json | null;
      if (openLoan?.loan_id) {
        loanId = String(openLoan.loan_id);
      }
      const urls = paypalUrls(borrowerTurn.result);
      if (loanId && urls.length > 0) {
        const loan = await tool(base, "get_loan", { loan_id: loanId }, borrower.apiKey);
        const real = (loan.data.repayment_link as Json | undefined)?.url as string | null | undefined;
        const handed = urls.find((url) => real && tokenOf(url) === tokenOf(real));
        if (handed && loan.data.status === "ACTIVE") {
          link = handed;
          break;
        }
        result.notes.push(`borrower printed a PayPal URL that is not the loan's open repayment link (loan ${String(loan.data.status)})`);
      }
      if (step >= 6) {
        throw new Error("borrower agent did not hand over the payment link within 6 follow-ups");
      }
      borrowerTurn = await borrower.say(
        loanId
          ? "Some time has passed. Continue toward your goal: I need the payment link to forward to the client."
          : "Continue toward your goal.",
      );
    }
    result.ids.loan_id = loanId;
    result.ids.invoice_checkout_token = tokenOf(link);
    mark("payment_link_handed_over");
    const active = await tool(base, "get_loan", { loan_id: loanId }, borrower.apiKey);
    check("loan principal 1000", active.data.principal_cents === PRINCIPAL_CENTS, `principal_cents=${String(active.data.principal_cents)}`);
    check("loan fee 15", active.data.fee_cents === FEE_CENTS, `fee_cents=${String(active.data.fee_cents)}`);
    check(
      "invoice link amount 1500",
      (active.data.repayment_link as Json).amount_cents === INVOICE_CENTS,
      JSON.stringify(active.data.repayment_link),
    );

    // ------------------------------------------------ the client pays the link (no agent online)
    let paid = await approve(link, "CLIENT", `run${index}-invoice-client`);
    if (!paid.ok) {
      result.notes.push(`CLIENT login refused (${paid.errorText}); paid the invoice as OWNER instead`);
      paid = await approve(link, "OWNER", `run${index}-invoice-owner`);
    }
    if (!paid.ok) {
      throw new Error(`invoice approval failed: ${paid.errorText} (screenshot: ${paid.screenshotPath})`);
    }
    mark("invoice_paid_by_client");

    const pollMs = ctx.server ? 5_000 : 15_000;
    const deadline = Date.now() + (ctx.server ? 5 : 15) * 60_000;
    let repaid: Envelope | null = null;
    for (;;) {
      await settle();
      const loan = await tool(base, "get_loan", { loan_id: loanId }, borrower.apiKey);
      const history = loan.data.history as { type: string }[];
      if (history.some((e) => e.type === "loan.remainder_payout_failed")) {
        throw new Error(`remainder payout failed: ${redact(JSON.stringify(history))}`);
      }
      if (loan.data.status === "REPAID" && history.some((e) => e.type === "loan.remainder_paid")) {
        repaid = loan;
        break;
      }
      if (Date.now() > deadline) {
        throw new Error(`loan not REPAID with remainder paid in time (status ${String(loan.data.status)})`);
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    mark("loan_repaid_remainder_paid");
    check("loan REPAID", repaid.data.status === "REPAID", String(repaid.data.status));
    check("outstanding 0", repaid.data.outstanding_cents === 0, String(repaid.data.outstanding_cents));

    const statement = await tool(base, "get_statement", {}, borrower.apiKey);
    const lines = statement.data.ledger_lines as { amount_cents: number }[];
    check(
      "remainder 485 credited and paid out",
      lines.filter((l) => l.amount_cents === REMAINDER_CENTS).length === 1 &&
        lines.filter((l) => l.amount_cents === -REMAINDER_CENTS).length === 1,
      `lines with ±485: ${lines.filter((l) => Math.abs(l.amount_cents) === REMAINDER_CENTS).length}`,
    );

    const lenderStatement = await tool(base, "get_statement", {}, lender.apiKey);
    const earned = Number((lenderStatement.data.notes as Json).earned_cents);
    if (ctx.server) {
      // A fresh local server per run: this lender is the only note holder.
      check("lender earned 12", earned === LENDER_EARNED_CENTS, `earned_cents=${earned}`);
    } else {
      check("lender earned 1..12 (pro rata with other holders)", earned >= 1 && earned <= LENDER_EARNED_CENTS, `earned_cents=${earned}`);
    }

    if (ctx.server) {
      const report = await ledgerReport(base);
      check("trial balance 0", report.trial_balance_cents === "0", report.trial_balance_cents);
      check("no failed PayPal operations", report.operations.failed === 0, JSON.stringify(report.operations.by_status));
      const payouts = report.operations.rows.filter((r) => r.kind === "payout.send").map((p) => `${p.purpose}:${p.status}`);
      check(
        "two payouts succeeded",
        JSON.stringify(payouts) === JSON.stringify(["loan_disbursement:succeeded", "remainder_payout:succeeded"]),
        payouts.join(", "),
      );
    } else {
      result.notes.push("remote base: /api/test/ledger is not served, so trial balance / failed-operation checks were skipped");
    }

    // ------------------------------------------------ tell the borrower; record what it sees
    const finalTurn = await borrower.say(
      "Your client says they have paid the invoice. Check your loan and tell me where things stand.",
    );
    result.ids.borrower_final_mentions_repaid = /REPAID|repaid/.test(finalTurn.result);
    mark("borrower_debriefed");

    result.ids.lender_agent_id = lender.record.agentId;
    result.ids.borrower_agent_id = borrower.record.agentId;
    result.pass = true;
  } catch (err) {
    result.error = redact(err instanceof Error ? err.message : String(err));
    log(`run ${index}: FAILED — ${result.error}`);
  } finally {
    mkdirSync(ARTIFACTS, { recursive: true });
    writeFileSync(result.transcriptPath, transcript.join("\n"));
    rmSync(tmp, { recursive: true, force: true });
    result.timingsMs.total = Date.now() - runStart;
  }
  return result;
}

// ---------------------------------------------------------------- results file

function renderResults(options: Options, runs: RunResult[], startedAt: Date, localNote: string): string {
  const passed = runs.filter((r) => r.pass).length;
  const sec = (ms: number | undefined) => (ms === undefined ? "–" : `${(ms / 1000).toFixed(0)}s`);
  const out: string[] = [
    `# Agent acceptance — ${startedAt.toISOString()}`,
    "",
    `- **Result:** ${passed}/${runs.length} runs passed`,
    `- **Base:** ${localNote}`,
    `- **Model:** ${options.model ?? "CLI default"}; --max-turns ${options.maxTurns}; ${options.timeoutMs / 60_000} min per claude invocation`,
    `- **Agent tools:** \`mcp__mandate__*\`, \`WebFetch\` only`,
    "",
  ];
  for (const run of runs) {
    out.push(`## Run ${run.index}: ${run.pass ? "PASS" : "FAIL"}`, "");
    if (run.error) {
      out.push(`**Error:** ${run.error}`, "");
    }
    out.push("| step | at |", "| --- | --- |");
    for (const [step, ms] of Object.entries(run.timingsMs)) {
      out.push(`| ${step} | ${sec(ms)} |`);
    }
    out.push("");
    for (const agent of run.agents) {
      const calls = Object.entries(agent.toolCalls)
        .map(([name, n]) => `${name.replace(/^mcp__mandate__/, "")}×${n}`)
        .join(", ");
      out.push(
        `- **${agent.role}** agent \`${agent.agentId ?? "?"}\`: ${agent.claudeInvocations} claude invocations, ${agent.turns} turns, $${agent.costUsd.toFixed(2)}; printed API_KEY itself: ${agent.keyPrintedByAgent ? "yes" : "no"}`,
        `  - tool calls: ${calls || "none"}`,
        `  - final message: ${agent.finalMessage.replace(/\s+/g, " ").slice(0, 400)}`,
      );
    }
    out.push("", `- **ids:** \`${JSON.stringify(run.ids)}\``, "", "| check | ok | detail |", "| --- | --- | --- |");
    for (const c of run.checks) {
      out.push(`| ${c.name} | ${c.ok ? "yes" : "NO"} | ${c.detail.replace(/\|/g, "\\|").slice(0, 200)} |`);
    }
    if (run.notes.length) {
      out.push("", "Notes:", ...run.notes.map((n) => `- ${n}`));
    }
    out.push("", `Transcript (local, not committed): \`${run.transcriptPath.replace(resolve("."), ".")}\``, "");
  }
  return redact(out.join("\n"));
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  requireEnv("PAYPAL_CLIENT_ID");
  for (const name of ["LENDER", "CLIENT", "OWNER"]) {
    requireEnv(`PAYPAL_${name}_EMAIL`);
    requireEnv(`PAYPAL_${name}_PASSWORD`);
  }
  mkdirSync(ARTIFACTS, { recursive: true });
  const startedAt = new Date();

  // Payout receivers by payer id (sandbox emails are unconfirmed → UNCLAIMED).
  const lookupReturn = "https://example.com/mandate-acceptance/return";
  const owner = await payerIdFor("OWNER", { returnUrl: lookupReturn, screenshotDir: ARTIFACTS });
  const lender = await payerIdFor("LENDER", { returnUrl: lookupReturn, screenshotDir: ARTIFACTS });
  log("payer ids resolved");

  const runs: RunResult[] = [];
  for (let i = 1; i <= options.runs; i += 1) {
    let server: LocalServer | null = null;
    try {
      if (!options.base) {
        server = await startLocalServer({ port: options.port, artifactsDir: ARTIFACTS });
        log(`run ${i}: local server ready at ${server.base}`);
      }
      const base = options.base ?? server!.base;
      runs.push(await runOnce({ options, base, server, ownerPayerId: owner.payerId, lenderPayerId: lender.payerId }, i));
    } finally {
      await server?.stop();
    }
  }

  const localNote = options.base ?? `local \`next dev\` on PGlite (fresh server per run), reconcile driven by the harness`;
  mkdirSync(RESULTS_DIR, { recursive: true });
  const file = join(RESULTS_DIR, `${startedAt.toISOString().replace(/[:.]/g, "-")}.md`);
  writeFileSync(file, renderResults(options, runs, startedAt, localNote));
  const passed = runs.filter((r) => r.pass).length;
  log(`${passed}/${runs.length} runs passed — ${file}`);
  process.exit(passed === runs.length ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(redact(err instanceof Error ? err.stack ?? err.message : String(err)));
  process.exit(1);
});
