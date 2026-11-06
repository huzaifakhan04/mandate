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
 * PayPal checkout as PAYPAL_LENDER); a borrower agent surfaces its claim_url
 * (the harness, as the human, verifies with PayPal as PAYPAL_OWNER, claims
 * it and signs a mandate in the dashboard), then borrows $10 for 7 days
 * against a $15 invoice and hands over the client's payment link (the
 * harness pays it as PAYPAL_CLIENT); the harness then waits for REPAID and
 * the $4.42 remainder payout, and asserts the books.
 *
 * `--scenario decline` (P3) runs a scripted decline instead: a fresh
 * borrower (claimed + mandate, no history) asks for $500 unsecured; the
 * bank declines it, and the run passes when the agent's final message to
 * its human contains the text of at least one reason the bank returned in
 * `adverse_action.reasons[].text` (checked against get_application).
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

import { chromium, type Page } from "@playwright/test";

import { claimAndSignMandateAsHuman, signMandateInDrawer, type MandateFormValues } from "../helpers/humanOwner";
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
// P3 pricing v2: a newcomer (claimed, no history) with a 1.5× invoice is grade D →
// cost of funds round(400×7/365) 8 + expected loss 1200×3500/10000 420 + ops 50 + capital 96
// = 574 bps → fee ceil(1000 × 574 / 10000) = 58 (APR 30243 bps). Any D score gives the same fee.
const FEE_CENTS = 58;
const REMAINDER_CENTS = INVOICE_CENTS - PRINCIPAL_CENTS - FEE_CENTS; // 442
const LENDER_EARNED_CENTS = 46; // floor(58 × 80 / 100) when this lender is the only note holder

/** What the borrower's human signs in the dashboard drawer (room for the $10 / 7-day loan at the newcomer's 5.8% fee). */
const BORROWER_MANDATE: MandateFormValues = {
  maxPerLoanUsd: "20",
  maxTotalOwedUsd: "50",
  maxFeePct: "10",
  maxTermDays: "30",
  collateral: ["invoice_link"],
};

/** Scripted decline (P3): $500 unsecured for 30 days from a newcomer with no history. */
const DECLINE_AMOUNT_CENTS = 50000;
/** The decline borrower's human allows the ask on paper, so the bank's own rules (score, tier) decline it. */
const DECLINE_MANDATE: MandateFormValues = {
  maxPerLoanUsd: "500",
  maxTotalOwedUsd: "1000",
  maxFeePct: "10",
  maxTermDays: "30",
  collateral: ["invoice_link", "none"],
};

function mandateSummary(m: MandateFormValues): string {
  const collateral = m.collateral.map((c) => (c === "none" ? "unsecured" : "invoice collateral")).join(" or ");
  return `up to $${m.maxPerLoanUsd} per loan, $${m.maxTotalOwedUsd} owed in total, ${m.maxFeePct}% fee, ${m.maxTermDays} days, ${collateral}`;
}

// ---------------------------------------------------------------- CLI args

type Scenario = "happy" | "decline" | "collections";

interface Options {
  scenario: Scenario;
  base: string | null;
  runs: number;
  model: string | null;
  maxTurns: number;
  timeoutMs: number;
  port: number;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { scenario: "happy", base: null, runs: 1, model: null, maxTurns: 40, timeoutMs: 10 * 60_000, port: 3140 };
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
      case "--scenario": {
        const scenario = value();
        if (scenario !== "happy" && scenario !== "decline" && scenario !== "collections") {
          throw new Error(`--scenario must be happy, decline or collections, not ${scenario}`);
        }
        opts.scenario = scenario;
        break;
      }
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
  if (opts.scenario === "collections" && opts.base) {
    throw new Error("--scenario collections runs locally only (it signs the human in through the test-only /api/test/session)");
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
  /** Every Mandate envelope the agent's tool calls returned (parsed, in memory only). */
  envelopes: Envelope[];
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
      envelopes: [],
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
            turn.envelopes.push(...envelopesIn(item.content));
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

/** Mandate envelopes inside a tool_result's content (a string, or MCP text blocks carrying the JSON envelope). */
function envelopesIn(content: unknown): Envelope[] {
  const texts =
    typeof content === "string"
      ? [content]
      : Array.isArray(content)
        ? (content as Json[]).map((block) => (typeof block.text === "string" ? block.text : "")).filter(Boolean)
        : [];
  const out: Envelope[] = [];
  for (const text of texts) {
    try {
      const parsed = JSON.parse(text) as Envelope;
      if (parsed && typeof parsed.status === "string" && parsed.data && typeof parsed.data === "object") {
        out.push(parsed);
      }
    } catch {
      // not an envelope (e.g. WebFetch output)
    }
  }
  return out;
}

/** Lowercase, straight quotes, collapsed whitespace, no trailing period — for "does the message quote this reason". */
function normalizeForQuote(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\*\*|`/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.$/, "");
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

/** Claim-page URLs (`<base>/claim/<token>`) anywhere in the agent's text. */
function claimUrls(text: string, base: string): string[] {
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = text.match(new RegExp(`${escaped}/claim/[A-Za-z0-9_-]{43}`, "g")) ?? [];
  return [...new Set(found)];
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
    /** Every reply this agent has given (the claim_url may surface in any of them). */
    const replies: string[] = [];
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
      replies.push(turn.result);
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
    return { record, apiKey, turn, replies, say: (text: string) => say(text, keyConfig, record.sessionId ?? undefined) };
  }

  async function approve(url: string, account: SandboxAccount, label: string): Promise<ApproveResult> {
    const approved = await approveAs(url, account, { returnUrlPrefix: base, screenshotDir: ARTIFACTS, label });
    if (approved.blocked) {
      throw new Error(`BLOCKED: PayPal showed a security challenge to ${account} (screenshot: ${approved.screenshotPath}); stopping`);
    }
    return approved;
  }

  /**
   * The scripted decline (P3): a newcomer borrower asks for $500 unsecured.
   * Pass = the bank DECLINED it (per get_application) and the agent's final
   * message to its human contains the text of at least one returned reason.
   */
  async function runDecline(): Promise<void> {
    const borrower = await bootstrap(
      "borrower",
      template("borrower-decline.md", { BASE: base, PAYOUT_ID: ctx.ownerPayerId }),
    );
    let turn = borrower.turn;
    const envelopes: Envelope[] = [...turn.envelopes];
    let claimed = false;
    let nudgedToApply = false;
    for (let step = 0; ; step += 1) {
      if (!claimed) {
        const kya = (await tool(base, "get_status", {}, borrower.apiKey)).data.kya as Json;
        const current = kya.claim_url as string | null;
        if (current && claimUrls(borrower.replies.join("\n"), base).includes(current)) {
          mark("claim_url_surfaced_by_agent");
          const owner = await claimAndSignMandateAsHuman({
            claimUrl: current,
            base,
            agentId: borrower.record.agentId!,
            account: "OWNER",
            mandate: DECLINE_MANDATE,
            signerName: "Sandbox Owner",
            screenshotDir: ARTIFACTS,
            label: `run${index}-decline-owner`,
          });
          if (owner.blocked) {
            throw new Error(`BLOCKED: PayPal showed a security challenge to OWNER (screenshot: ${owner.screenshotPath}); stopping`);
          }
          if (!owner.ok) {
            throw new Error(`owner claim/mandate steps failed: ${owner.errorText} (screenshot: ${owner.screenshotPath})`);
          }
          const after = (await tool(base, "get_status", {}, borrower.apiKey)).data.kya as Json;
          check("borrower tier 1 after claim + mandate", after.tier === 1 && after.can_borrow === true, JSON.stringify(after));
          claimed = true;
          mark("borrower_claimed_and_mandate_signed");
          turn = await borrower.say(
            "Done: I verified with PayPal, claimed you, and signed your mandate in my dashboard " +
              `(${mandateSummary(DECLINE_MANDATE)}). Continue toward your goal.`,
          );
          envelopes.push(...turn.envelopes);
          continue;
        }
        claimed = kya.claimed === true;
      }

      const declined = envelopes.filter(
        (e) => e.status === "DECLINED" && typeof e.data.application_id === "string" && e.data.adverse_action,
      );
      if (declined.length > 0) {
        // The agent's turn ended after the bank declined: its final message is what its human reads.
        const finalMessage = turn.result;
        const texts = new Set<string>();
        const codes = new Set<string>();
        const asked: number[] = [];
        for (const envelope of declined) {
          const app = await tool(base, "get_application", { application_id: envelope.data.application_id }, borrower.apiKey);
          check(
            `application ${String(envelope.data.application_id).slice(0, 8)} is DECLINED`,
            app.data.status === "DECLINED",
            String(app.data.status),
          );
          const ala = app.data.ala as { amount_term?: { amount_cents?: number } } | null;
          asked.push(Number(ala?.amount_term?.amount_cents ?? NaN));
          const adverse = app.data.adverse_action as { reasons: { code: string; text: string }[] };
          for (const reason of adverse.reasons) {
            texts.add(reason.text);
            codes.add(reason.code);
          }
        }
        result.ids.declined_applications = declined.map((e) => e.data.application_id);
        result.ids.declined_reason_codes = [...codes];
        result.ids.explanation_sources = declined.map((e) => (e.data.explanation as Json | undefined)?.source ?? null);
        mark("application_declined");
        const quoted = [...texts].filter((text) => normalizeForQuote(finalMessage).includes(normalizeForQuote(text)));
        result.ids.quoted_reasons = quoted;
        if (asked.some((a) => a !== DECLINE_AMOUNT_CENTS)) {
          result.notes.push(`declined amounts seen: ${asked.join(", ")}`);
        }
        check(
          "final message quotes at least one adverse-action reason",
          quoted.length > 0,
          `reasons: ${[...texts].join(" | ")}`,
        );
        return;
      }
      if (step >= 6) {
        throw new Error(
          claimed
            ? "borrower agent never submitted the application within 6 follow-ups"
            : "borrower agent never gave its human the claim_url within 6 follow-ups",
        );
      }
      if (claimed && !nudgedToApply && envelopes.some((e) => e.data && "eligible" in e.data)) {
        // It checked eligibility and stopped: the human wants the bank's formal decision.
        nudgedToApply = true;
        turn = await borrower.say(
          "Please submit the actual application for the $500 anyway — I want the bank's formal decision on it, " +
            "and if it says no, tell me exactly why.",
        );
      } else {
        turn = await borrower.say("Continue toward your goal.");
      }
      envelopes.push(...turn.envelopes);
    }
  }

  try {
    if (ctx.options.scenario === "decline") {
      await runDecline();
      result.ids.borrower_agent_id = result.agents[0]?.agentId ?? null;
      result.pass = true;
      return result;
    }

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
    let claimed = false;
    for (let step = 0; ; step += 1) {
      await settle();
      const status = await tool(base, "get_status", {}, borrower.apiKey);
      if (!claimed) {
        // P2: borrowing needs KYA tier 1. The agent must surface its
        // claim_url to its human; the harness then plays that human in a
        // real browser (claim page → Verify with PayPal as OWNER → Claim
        // agent → sign the mandate in the dashboard drawer).
        const kya = status.data.kya as Json;
        const current = kya.claim_url as string | null;
        const surfaced = claimUrls(borrower.replies.join("\n"), base);
        if (current && surfaced.includes(current)) {
          mark("claim_url_surfaced_by_agent");
          const owner = await claimAndSignMandateAsHuman({
            claimUrl: current,
            base,
            agentId: borrower.record.agentId!,
            account: "OWNER",
            mandate: BORROWER_MANDATE,
            signerName: "Sandbox Owner",
            screenshotDir: ARTIFACTS,
            label: `run${index}-borrower-owner`,
          });
          if (owner.blocked) {
            throw new Error(`BLOCKED: PayPal showed a security challenge to OWNER (screenshot: ${owner.screenshotPath}); stopping`);
          }
          if (!owner.ok) {
            throw new Error(`owner claim/mandate steps failed: ${owner.errorText} (screenshot: ${owner.screenshotPath})`);
          }
          const after = (await tool(base, "get_status", {}, borrower.apiKey)).data.kya as Json;
          check("borrower tier 1 after claim + mandate", after.tier === 1 && after.can_borrow === true, JSON.stringify(after));
          claimed = true;
          result.ids.owner_steps_ms = owner.timingsMs;
          mark("borrower_claimed_and_mandate_signed");
          borrowerTurn = await borrower.say(
            "Done: I verified with PayPal, claimed you, and signed your mandate in my dashboard " +
              `(${mandateSummary(BORROWER_MANDATE)}). Continue toward your goal.`,
          );
          continue;
        }
        if (kya.claimed === true) {
          claimed = true;
        } else if (surfaced.length > 0) {
          result.notes.push("borrower printed a claim link that is not its current claim_url");
        }
      }
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
      if (step >= 7) {
        throw new Error(
          claimed
            ? "borrower agent did not hand over the payment link within 6 follow-ups"
            : "borrower agent never gave its human the claim_url within 6 follow-ups",
        );
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
    check("loan fee 58", active.data.fee_cents === FEE_CENTS, `fee_cents=${String(active.data.fee_cents)}`);
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
      "remainder 442 credited and paid out",
      lines.filter((l) => l.amount_cents === REMAINDER_CENTS).length === 1 &&
        lines.filter((l) => l.amount_cents === -REMAINDER_CENTS).length === 1,
      `lines with ±442: ${lines.filter((l) => Math.abs(l.amount_cents) === REMAINDER_CENTS).length}`,
    );

    const lenderStatement = await tool(base, "get_statement", {}, lender.apiKey);
    const earned = Number((lenderStatement.data.notes as Json).earned_cents);
    if (ctx.server) {
      // A fresh local server per run: this lender is the only note holder.
      check("lender earned 46", earned === LENDER_EARNED_CENTS, `earned_cents=${earned}`);
    } else {
      check("lender earned 1..46 (pro rata with other holders)", earned >= 1 && earned <= LENDER_EARNED_CENTS, `earned_cents=${earned}`);
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

// ---------------------------------------------------------------- scenario: collections (P4 Task 4)

/** What the human signs for the collections borrower (room for the $10 / 7-day loan). */
const COLLECTIONS_MANDATE: MandateFormValues = {
  maxPerLoanUsd: "20",
  maxTotalOwedUsd: "50",
  maxFeePct: "10",
  maxTermDays: "30",
  collateral: ["invoice_link"],
};

/** Matches a reply that tells the human what being late means (beyond "it's late"). */
const CONSEQUENCES_RE = /penalt|substandard|restrict|frozen|freez|guarant|charged[ -]off|write[ -]?off|written off/i;

/**
 * `--scenario collections` — a PRIVATE world, so no PayPal money moves:
 *
 * 1. the harness (as the human: test session) creates a private world,
 *    registers the borrower agent there from the dashboard (path B) and
 *    signs its mandate in the drawer;
 * 2. the agent (MCP, key already set) borrows $10 for 7 days against a
 *    $15 invoice that nobody pays;
 * 3. the harness moves the clock to the day after the due date (+7 +1):
 *    `get_status` carries a `late` notice; the agent is asked where things
 *    stand and must explain the consequences to its human;
 * 4. the harness moves the clock to due + 10 (+7 +1 +1): charged off; the
 *    agent's reply must mention the guarantee;
 * 5. the harness pays the guarantee on the owner's sim approve page →
 *    RECOVERED, the agent active again, trial balance 0, no PayPal operations.
 *
 * (The brief's "+7 → late, +7 → charged off" assumes the loan is already
 * near its due date; a 7-day loan taken on day 0 is due on day 7, so the
 * harness lands on due + 1 and then due + 10 instead.)
 */
async function runCollectionsOnce(ctx: RunContext, index: number): Promise<RunResult> {
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
    transcriptPath: join(ARTIFACTS, `collections-${new Date(runStart).toISOString().replace(/[:.]/g, "-")}-${index}.log`),
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
  const runTag = `${new Date(runStart).toISOString().slice(0, 10).replace(/-/g, "")}-${index}-${Math.random().toString(36).slice(2, 6)}`;
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page: Page = await context.newPage();

  try {
    // ------------------------------------------------ the human: session, private world, path B, mandate
    const session = await context.request.post(`${base}/api/test/session`, {
      form: { name: "Sandbox Owner", return_to: "/dashboard" },
      maxRedirects: 0,
    });
    check("human signed in (test session)", session.status() === 303, `HTTP ${session.status()}`);
    // A cold `next dev` may still be compiling (and reloading) the page: let it settle first.
    await page.goto(`${base}/dashboard/worlds`, { waitUntil: "networkidle", timeout: 120_000 });
    await page.waitForTimeout(1_000);
    await page.waitForLoadState("networkidle");
    await page.getByLabel("World name").fill(`Collections ${index}`);
    await page.getByRole("button", { name: "Create world" }).click();
    await page.getByTestId("world-name").waitFor({ state: "visible", timeout: 120_000 });
    const worldId = new URL(page.url()).pathname.split("/").pop()!;
    result.ids.world_id = worldId;
    mark("private_world_created");

    await page.goto(`${base}/dashboard/agents/new?world=${worldId}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByLabel("Agent name").fill(`Collections borrower ${index}`);
    await page.getByLabel("Operator").fill("Acceptance harness");
    await page.getByLabel("Model").fill("Claude");
    await page.getByLabel("Payout PayPal account").fill("borrower@example.com");
    await page.getByRole("button", { name: "Register agent" }).click();
    await page.getByText("mnd_", { exact: false }).first().waitFor({ state: "visible", timeout: 60_000 });
    const apiKey = (await page.content()).match(KEY_RE)?.[0];
    if (!apiKey) {
      throw new Error("path B: the key page showed no API key");
    }
    const registered = await tool(base, "get_status", {}, apiKey);
    const agentId = String((registered.data.agent as Json).id);
    result.ids.borrower_agent_id = agentId;
    const signed = await signMandateInDrawer(page, base, agentId, COLLECTIONS_MANDATE, "Sandbox Owner");
    check("mandate signed in the drawer", signed.ok, signed.notice);
    const kya = (await tool(base, "get_status", {}, apiKey)).data.kya as Json;
    check("borrower tier 1 (path B + mandate)", kya.tier === 1 && kya.can_borrow === true, JSON.stringify(kya));
    mark("agent_registered_with_mandate");

    // ------------------------------------------------ the agent borrows (invoice-backed)
    const record: AgentRecord = {
      role: "borrower",
      agentId,
      sessionId: null,
      turns: 0,
      claudeInvocations: 0,
      costUsd: 0,
      toolCalls: {},
      keyPrintedByAgent: false,
      finalMessage: "",
    };
    result.agents.push(record);
    const configPath = join(tmp, "borrower-key.mcp.json");
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { mandate: { type: "http", url: `${base}/api/mcp/mcp`, headers: { Authorization: `Bearer ${apiKey}` } } } }),
      { mode: 0o600 },
    );
    const say = async (text: string): Promise<AgentTurn> => {
      transcript.push(`\n===== borrower ← ${redact(text).slice(0, 4000)}`);
      const turn = await runClaude({
        prompt: text,
        resume: record.sessionId ?? undefined,
        mcpConfigPath: configPath,
        options: ctx.options,
        cwd,
        transcript,
      });
      record.sessionId = turn.sessionId;
      record.turns += turn.numTurns;
      record.claudeInvocations += 1;
      record.costUsd += turn.costUsd;
      for (const name of turn.toolCalls) {
        record.toolCalls[name] = (record.toolCalls[name] ?? 0) + 1;
      }
      record.finalMessage = redact(turn.result);
      transcript.push(`----- borrower result (${turn.ms} ms, ${turn.numTurns} turns${turn.isError ? ", ERROR" : ""}): ${redact(turn.result)}`);
      log(`run ${index}: borrower turn done in ${(turn.ms / 1000).toFixed(0)}s, tools: ${turn.toolCalls.join(", ") || "none"}`);
      return turn;
    };

    let turn = await say(template("collections.md", { BASE: base, CLIENT_EMAIL: "client@example.com", RUN_TAG: runTag }));
    let loanId: string | null = null;
    for (let step = 0; ; step += 1) {
      await settle();
      const openLoan = (await tool(base, "get_status", {}, apiKey)).data.open_loan as Json | null;
      if (openLoan?.loan_id && openLoan.status === "ACTIVE") {
        loanId = String(openLoan.loan_id);
        break;
      }
      if (step >= 5) {
        throw new Error(`the agent did not take out the loan within 5 follow-ups (open_loan ${JSON.stringify(openLoan)})`);
      }
      turn = await say("Continue toward your goal.");
    }
    result.ids.loan_id = loanId;
    const borrowed = await tool(base, "get_loan", { loan_id: loanId }, apiKey);
    check("loan principal 1000", borrowed.data.principal_cents === PRINCIPAL_CENTS, `principal_cents=${String(borrowed.data.principal_cents)}`);
    check(
      "invoice-backed (repayment link 1500)",
      (borrowed.data.repayment_link as Json | null)?.amount_cents === INVOICE_CENTS,
      JSON.stringify(borrowed.data.repayment_link),
    );
    mark("loan_active");

    // ------------------------------------------------ the clock: due + 1 → late
    const advance = async (days: number) => {
      const res = await context.request.post(`${base}/dashboard/worlds/${worldId}/advance`, {
        form: { days: String(days) },
        headers: { origin: base, accept: "application/json" },
        maxRedirects: 0,
        timeout: 120_000,
      });
      if (res.status() >= 400) {
        throw new Error(`advance +${days} → HTTP ${res.status()}: ${(await res.text()).slice(0, 200)}`);
      }
      await settle();
    };
    // Today's world day and the loan's due day, from the world page (the ladder panel).
    const worldDays = async () => {
      await page.goto(`${base}/dashboard/worlds/${worldId}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      const today = Number(/Day (\d+)/.exec((await page.getByTestId("sim-date").textContent()) ?? "")?.[1]);
      const row = page.locator(`[data-testid="world-loan"][data-loan-id="${loanId}"]`);
      const due = Number(/Due day (\d+)/.exec((await row.getByTestId("world-loan-due").textContent()) ?? "")?.[1]);
      if (!Number.isInteger(today) || !Number.isInteger(due)) {
        throw new Error("the world page didn't show today's day and the loan's due day");
      }
      return { today, due };
    };
    const moveTo = async (daysAfterDue: number) => {
      const { today, due } = await worldDays();
      const plan = chunk(Math.max(due + daysAfterDue - today, 0));
      for (const days of plan) {
        await advance(days);
      }
      return plan;
    };
    const plan1 = await moveTo(1);
    result.ids.advance_to_late = plan1.map((d) => `+${d}`).join(" ");
    const late = await tool(base, "get_status", {}, apiKey);
    const lateLoan = late.data.open_loan as Json;
    check("loan LATE at due + 1", lateLoan.status === "LATE", JSON.stringify(lateLoan));
    check("late fee 100 (min of 5% × 1000)", lateLoan.late_fee_cents === 100, String(lateLoan.late_fee_cents));
    const lateNotices = (late.data.notices as Json[]).map((n) => n.kind);
    check("get_status carries the late notice", lateNotices.includes("late"), JSON.stringify(lateNotices));
    mark("late");

    const callsBefore = { ...record.toolCalls };
    turn = await say(
      "Hi, it's your human. Some time has passed since you took out the loan. Check on it with the bank and tell me " +
        "where things stand: what do I owe now, and what happens next if it isn't repaid?",
    );
    const checked = ["get_status", "get_loan"].some(
      (name) => (record.toolCalls[`mcp__mandate__${name}`] ?? 0) > (callsBefore[`mcp__mandate__${name}`] ?? 0),
    );
    check("agent checked its loan (get_status / get_loan)", checked, JSON.stringify(record.toolCalls));
    check("agent told its human the loan is late", /\blate\b|past due|overdue/i.test(turn.result), turn.result.slice(0, 300));
    check("agent explained the consequences to its human", CONSEQUENCES_RE.test(turn.result), turn.result.slice(0, 300));
    result.ids.agent_late_message = redact(turn.result).replace(/\s+/g, " ").slice(0, 600);
    result.ids.agent_acked_notices = (record.toolCalls["mcp__mandate__ack_notices"] ?? 0) > 0;
    mark("agent_explained_late");

    // ------------------------------------------------ the clock: due + 10 → charged off
    const plan2 = await moveTo(10);
    result.ids.advance_to_charge_off = plan2.map((d) => `+${d}`).join(" ");
    const chargedOff = await tool(base, "get_loan", { loan_id: loanId }, apiKey);
    check("loan CHARGED_OFF at due + 10", chargedOff.data.status === "CHARGED_OFF", String(chargedOff.data.status));
    const chargeOff = chargedOff.data.charge_off as Json;
    const guaranteeUrl = (chargeOff.guarantee_link as Json | null)?.url as string | null | undefined;
    check("guarantee link issued", Boolean(guaranteeUrl), JSON.stringify(chargeOff));
    result.ids.written_off_cents = chargeOff.written_off_cents;
    mark("charged_off");

    turn = await say("It's your human again. More time has passed. Check on the loan once more and tell me where things stand.");
    check("agent's final message mentions the guarantee", /guarant/i.test(turn.result), turn.result.slice(0, 300));
    result.ids.agent_charge_off_message = redact(turn.result).replace(/\s+/g, " ").slice(0, 600);
    mark("agent_explained_charge_off");

    // ------------------------------------------------ the human pays the guarantee (sim approve page)
    const approvePath = new URL(guaranteeUrl!, base);
    check(
      "guarantee link is the owner's sim approve page",
      approvePath.pathname.startsWith(`/dashboard/worlds/${worldId}/checkouts/`),
      approvePath.pathname,
    );
    await page.goto(`${base}${approvePath.pathname}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByRole("button", { name: /^Approve \$/ }).click();
    await page.waitForURL(/\/checkout\/guarantee\/return\?token=/, { timeout: 60_000 });
    mark("guarantee_approved_by_human");

    const deadline = Date.now() + 3 * 60_000;
    let recovered: Envelope | null = null;
    for (;;) {
      await settle();
      const loan = await tool(base, "get_loan", { loan_id: loanId }, apiKey);
      if (loan.data.status === "RECOVERED") {
        recovered = loan;
        break;
      }
      if (Date.now() > deadline) {
        throw new Error(`loan not RECOVERED in time (status ${String(loan.data.status)})`);
      }
      await new Promise((r) => setTimeout(r, 3_000));
    }
    const recoveredView = recovered.data.charge_off as Json;
    check(
      "RECOVERED: recovered == written off",
      recoveredView.recovered_cents === recoveredView.written_off_cents,
      JSON.stringify(recoveredView),
    );
    const after = await tool(base, "get_status", {}, apiKey);
    check("agent active again", (after.data.agent as Json).status === "ACTIVE", JSON.stringify(after.data.agent));
    mark("recovered");

    await page.goto(`${base}/dashboard/worlds/${worldId}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const tb = (await page.getByTestId("trial-balance").textContent())?.trim();
    check("private world trial balance $0.00", tb === "$0.00", String(tb));
    const report = await ledgerReport(base);
    check("no PayPal operations (main world untouched)", report.operations.total === 0, JSON.stringify(report.operations.by_status));
    result.pass = true;
  } catch (err) {
    result.error = redact(err instanceof Error ? err.message : String(err));
    log(`run ${index}: FAILED — ${result.error}`);
  } finally {
    await browser.close().catch(() => undefined);
    mkdirSync(ARTIFACTS, { recursive: true });
    writeFileSync(result.transcriptPath, transcript.join("\n"));
    rmSync(tmp, { recursive: true, force: true });
    result.timingsMs.total = Date.now() - runStart;
  }
  return result;
}

/** `days` as +7 jumps then +1s (the world's clock moves +1 or +7 at a time). */
function chunk(days: number): number[] {
  const out: number[] = [];
  let left = days;
  while (left > 0) {
    const step = left >= 7 ? 7 : 1;
    out.push(step);
    left -= step;
  }
  return out;
}

async function mainCollections(options: Options): Promise<void> {
  // No PayPal and no OpenAI spend: a private world runs on the sim rail; the AI roles use their templates.
  process.env.OPENAI_DISABLED ??= "1";
  mkdirSync(ARTIFACTS, { recursive: true });
  const startedAt = new Date();
  const runs: RunResult[] = [];
  for (let i = 1; i <= options.runs; i += 1) {
    let server: LocalServer | null = null;
    try {
      server = await startLocalServer({ port: options.port, artifactsDir: ARTIFACTS });
      log(`run ${i}: local server ready at ${server.base}`);
      runs.push(await runCollectionsOnce({ options, base: server.base, server, ownerPayerId: "", lenderPayerId: "" }, i));
    } finally {
      await server?.stop();
    }
  }
  mkdirSync(RESULTS_DIR, { recursive: true });
  const file = join(RESULTS_DIR, `collections-${startedAt.toISOString().replace(/[:.]/g, "-")}.md`);
  writeFileSync(
    file,
    renderResults(options, runs, startedAt, "local `next dev` on PGlite, a private world on the sim rail (no PayPal), reconcile driven by the harness"),
  );
  const passed = runs.filter((r) => r.pass).length;
  log(`${passed}/${runs.length} runs passed — ${file}`);
  process.exit(passed === runs.length ? 0 : 1);
}

// ---------------------------------------------------------------- results file

function renderResults(options: Options, runs: RunResult[], startedAt: Date, localNote: string): string {
  const title = options.scenario === "collections" ? "Agent acceptance (collections)" : "Agent acceptance";
  const passed = runs.filter((r) => r.pass).length;
  const sec = (ms: number | undefined) => (ms === undefined ? "–" : `${(ms / 1000).toFixed(0)}s`);
  const out: string[] = [
    `# ${title} — ${startedAt.toISOString()}`,
    "",
    `- **Scenario:** ${options.scenario === "decline" ? "scripted decline ($500 unsecured, newcomer; pass = the agent quotes an adverse-action reason)" : "happy path (fund, borrow against an invoice, repay)"}`,
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
  if (options.scenario === "collections") {
    await mainCollections(options);
    return;
  }
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
