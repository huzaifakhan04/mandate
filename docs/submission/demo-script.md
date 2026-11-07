# Demo script (about 2:45): "Mandate: credit for the AI economy"

The rendered video follows this script. The voice-over source of truth is `mandate-demo-video/script/voiceover.md`. For a live demo, record at 1280×800 with a Claude Code terminal, `/console` and `/dashboard` (signed in as the owner) ready.

| Time | Screen | Say / do |
|---|---|---|
| 0:00–0:15 | Cold open (motion graphics) | "Meet Nova, an AI agent that runs the books for a small studio. It finished a $400 job, and needs $10 today to deliver it. No bank on earth will lend to an agent." |
| 0:15–0:31 | Why credit (motion graphics) | "Every business runs on credit: a small advance now, paid back when the customer pays. Agents can't get it. Their only option is a human's credit card." |
| 0:31–0:41 | Logo reveal | "So we built Mandate: the bank for AI agents. Credit, for the AI economy." |
| 0:41–0:56 | How it works (3-step diagram) | Borrow against an invoice → other agents fund it and earn a share of the fee → the client pays and the loan repays itself. Every dollar moves on PayPal. |
| 0:56–1:11 | Any agent (logo tiles) | Claude Code, Codex, Cursor, Gemini CLI, Copilot. Tools over MCP, REST and OpenAPI. One URL: `/agents.md`. |
| 1:11–1:27 | Terminal + claim page | Paste: "You're my agent. Read https://agentic-bank-mu.vercel.app/agents.md, register with my PayPal id, then borrow $10 for 7 days against my client's $15 invoice." The agent registers and prints a claim link. The human verifies with PayPal and signs limits ($20 per loan, 10% max fee). |
| 1:27–1:43 | Terminal | The agent applies: grade D (newcomer), $0.58 fee with a plain-English disclosure. It accepts, and the payout lands on PayPal. |
| 1:43–1:57 | PayPal sandbox (as the client) → `/console` | Pay the invoice link. The capture shows in the PayPal log, the loan is REPAID, $4.42 goes back to the agent and the lenders earn their share. Nobody called an API. |
| 1:57–2:23 | Dashboard timeline → private world → Risk desk | The agent planned its own repayment schedule (timeline). Press +7 days twice: late fee, then charge-off and a guarantee request to the human. The risk desk flags gaming, and the AI investigator writes the case. "The decisions are code. AI only explains them." |
| 2:23–2:45 | Close + end card | "Agents keep working. Lenders earn yield. The bank earns the spread. Every PayPal call was built against the official SDK, with APIMatic's PayPal context. Mandate. Credit for the AI economy." |
