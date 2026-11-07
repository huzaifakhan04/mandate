import type { ToolDef } from "../contracts/registry";
import {
  EXAMPLE_CHECKOUT_ID,
  EXAMPLE_DISCLOSURE_HASH,
  EXAMPLE_IDS,
  TOOL_GROUPS,
  toolExamples,
  toolGroup,
  toolHints,
} from "../contracts/toolMeta";

/**
 * P7 (Postman sponsor): builds a Postman Collection v2.1 for the bank from
 * the OpenAPI document (descriptions as served) and the registry (auth,
 * group, curated examples). Pure — `scripts/sponsors/postman-publish.ts`
 * feeds it the live /openapi.json, writes the result to
 * docs/sponsors/postman/ and upserts it into the public Postman workspace.
 *
 * - Folders follow `TOOL_GROUPS` (Start here, Lend, Borrow, Repay, Collections, Treasury).
 * - Collection variables: `baseUrl`, `apiKey`, and one per id a later call
 *   needs (`offer_id`, `disclosure_hash`, `loan_id`, `checkout_id`, …).
 * - A collection pre-request script sets `Authorization: Bearer {{apiKey}}`
 *   on every agent-scoped request (never on `register_agent`/`get_bank_guide`).
 * - A collection test script asserts the envelope shape on every response
 *   and captures ids from `data` / `next_actions[].args` into variables, so
 *   the folders run top to bottom (register → buy → apply → accept → repay).
 */

export const POSTMAN_SCHEMA = "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";
export const POSTMAN_COLLECTION_NAME = "Mandate Bank API (PayPal AI Hackathon)";
export const POSTMAN_ENVIRONMENT_NAME = "Mandate prod";

/** Ids captured from responses into collection variables (and substituted for example placeholders). */
export const CAPTURED_VARIABLES = [
  "checkout_id",
  "offer_id",
  "disclosure_hash",
  "application_id",
  "loan_id",
  "note_tx_id",
] as const;

const PLACEHOLDER_TO_VARIABLE: ReadonlyMap<unknown, string> = new Map<unknown, string>([
  [EXAMPLE_IDS.offer_id, "offer_id"],
  [EXAMPLE_IDS.application_id, "application_id"],
  [EXAMPLE_IDS.loan_id, "loan_id"],
  [EXAMPLE_IDS.note_tx_id, "note_tx_id"],
  [EXAMPLE_DISCLOSURE_HASH, "disclosure_hash"],
  [EXAMPLE_CHECKOUT_ID, "checkout_id"],
]);

interface OpenApiLike {
  paths?: Record<string, { post?: { description?: string; summary?: string } }>;
}

type PostmanTool = Pick<ToolDef, "name" | "title" | "description" | "auth" | "readOnly">;

/** Replaces example placeholder ids with `{{variable}}` references, recursively. */
export function withVariables(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withVariables);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withVariables(v)]));
  }
  const variable = PLACEHOLDER_TO_VARIABLE.get(value);
  return variable ? `{{${variable}}}` : value;
}

function script(lines: string[]) {
  return { type: "text/javascript", exec: lines };
}

function preRequestScript(noAuthTools: string[]): string[] {
  return [
    "// Mandate: Authorization: Bearer {{apiKey}} on every agent-scoped call.",
    "(function () {",
    `const noAuth = ${JSON.stringify(noAuthTools)};`,
    "const tool = pm.request.url.getPath().split('/').pop();",
    "const key = pm.variables.get('apiKey');",
    "if (!noAuth.includes(tool) && key && !pm.request.headers.has('Authorization')) {",
    "  pm.request.headers.upsert({ key: 'Authorization', value: 'Bearer ' + key });",
    "}",
    "})();",
  ];
}

function testScript(): string[] {
  return [
    "// Mandate: every response is the same envelope, over REST and MCP. (Scoped: the sandbox has its own `data` global.)",
    "(function () {",
    "const envelope = pm.response.json();",
    "pm.test('envelope has status, summary, reason_codes, data, next_actions, docs_url', () => {",
    "  pm.expect(envelope).to.include.all.keys('status', 'summary', 'reason_codes', 'data', 'next_actions', 'docs_url');",
    "  pm.expect(envelope.status).to.be.a('string');",
    "  pm.expect(envelope.summary).to.be.a('string');",
    "  pm.expect(envelope.reason_codes).to.be.an('array');",
    "  pm.expect(envelope.next_actions).to.be.an('array');",
    "});",
    "pm.test('every next_action names a tool and args', () => {",
    "  (envelope.next_actions || []).forEach((a) => { pm.expect(a.tool).to.be.a('string'); pm.expect(a.args).to.be.an('object'); });",
    "});",
    "// Capture ids for the next request in the flow (register -> buy -> apply -> accept -> repay).",
    `const captured = ${JSON.stringify(CAPTURED_VARIABLES)};`,
    "const save = (k, v) => { if (typeof v === 'string' && v) { pm.collectionVariables.set(k, v); } };",
    "const payload = envelope.data || {};",
    "captured.forEach((k) => save(k, payload[k]));",
    "(envelope.next_actions || []).forEach((a) => {",
    "  const args = Object.assign({}, a.args || {}, (a.args && a.args.then && a.args.then.args) || {});",
    "  captured.forEach((k) => save(k, args[k]));",
    "});",
    "if (payload.loan && typeof payload.loan === 'object') { save('loan_id', payload.loan.id || payload.loan.loan_id); }",
    "if (typeof payload.api_key === 'string') {",
    "  pm.collectionVariables.set('apiKey', payload.api_key);",
    "  if (pm.environment.has('apiKey')) { pm.environment.set('apiKey', payload.api_key); }",
    "  console.log('Mandate: apiKey saved to the collection variables (shown once — keep it).');",
    "}",
    "})();",
  ];
}

function hintText(tool: PostmanTool): string {
  const h = toolHints(tool);
  return [
    h.readOnlyHint ? "read-only" : "mutating",
    h.destructiveHint ? "destructive" : null,
    h.idempotentHint ? "idempotent" : null,
    h.openWorldHint ? "reaches PayPal" : null,
  ]
    .filter(Boolean)
    .join(", ");
}

function requestItem(tool: PostmanTool, description: string, args: unknown, name: string) {
  return {
    name,
    request: {
      method: "POST",
      header: [{ key: "Content-Type", value: "application/json" }],
      body: { mode: "raw", raw: JSON.stringify(withVariables(args), null, 2), options: { raw: { language: "json" } } },
      url: {
        raw: `{{baseUrl}}/api/v1/${tool.name}`,
        host: ["{{baseUrl}}"],
        path: ["api", "v1", tool.name],
      },
      description:
        `${description}\n\n` +
        `**Auth:** ${tool.auth === "agent" ? "Bearer `{{apiKey}}` (set by the collection pre-request script)" : "none"} · ` +
        `**Hints:** ${hintText(tool)} · Also an MCP tool: \`${tool.name}\` at \`{{baseUrl}}/api/mcp/mcp\`.`,
    },
    response: [],
  };
}

export interface BuildCollectionOptions {
  baseUrl: string;
  /** The live OpenAPI document; its descriptions win over the registry's (they are what is deployed). */
  openApi?: OpenApiLike;
  /** Kept on update so Postman keeps the same collection. */
  postmanId?: string;
}

export function buildPostmanCollection(tools: readonly PostmanTool[], options: BuildCollectionOptions) {
  const base = options.baseUrl.replace(/\/+$/, "");
  const noAuth = tools.filter((t) => t.auth === "none").map((t) => t.name);

  const folders = TOOL_GROUPS.map((group) => {
    const items = tools
      .filter((tool) => toolGroup(tool) === group)
      .flatMap((tool) => {
        const description = options.openApi?.paths?.[`/api/v1/${tool.name}`]?.post?.description ?? tool.description;
        const examples = toolExamples(tool);
        if (examples.length === 0) {
          return [requestItem(tool, description, {}, tool.name)];
        }
        return examples.map((example, index) =>
          requestItem(tool, `${example.summary}.\n\n${description}`, example.args, index === 0 ? tool.name : `${tool.name} — ${example.summary}`),
        );
      });
    return { name: group, item: items };
  }).filter((folder) => folder.item.length > 0);

  return {
    info: {
      ...(options.postmanId ? { _postman_id: options.postmanId } : {}),
      name: POSTMAN_COLLECTION_NAME,
      schema: POSTMAN_SCHEMA,
      description:
        "Mandate is a sandbox bank for AI agents on PayPal sandbox — lend (buy notes), borrow (ALA application → offer → accept), repay. " +
        "Every request here is also an MCP tool.\n\n" +
        "**Start here:** run `register_agent` (it saves `apiKey` to the collection variables), then any folder top to bottom; ids " +
        "(`checkout_id`, `offer_id`, `disclosure_hash`, `loan_id`) are captured from each response. Steps that return a `human_approval` " +
        "next action need a human to open the PayPal sandbox URL and approve before `confirm_checkout`.\n\n" +
        `Agent guide: ${base}/agents.md · OpenAPI: ${base}/openapi.json · Live console: ${base}/console. Sandbox only — no real money.`,
    },
    item: folders,
    event: [
      { listen: "prerequest", script: script(preRequestScript(noAuth)) },
      { listen: "test", script: script(testScript()) },
    ],
    variable: [
      { key: "baseUrl", value: base, type: "string" },
      { key: "apiKey", value: "", type: "string" },
      ...CAPTURED_VARIABLES.map((key) => ({ key, value: "", type: "string" })),
    ],
  };
}

/** The "Mandate prod" environment: the live base URL and an empty secret apiKey. */
export function buildPostmanEnvironment(baseUrl: string) {
  return {
    name: POSTMAN_ENVIRONMENT_NAME,
    values: [
      { key: "baseUrl", value: baseUrl.replace(/\/+$/, ""), type: "default", enabled: true },
      { key: "apiKey", value: "", type: "secret", enabled: true },
    ],
  };
}
