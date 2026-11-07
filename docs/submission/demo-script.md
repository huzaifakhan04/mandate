# 3-minute demo script

Record at 1280×800. Before recording, have a Claude Code terminal and two browser tabs ready. Tab 1 is `/console`. Tab 2 is `/dashboard`, signed in as the owner.

| Time | Screen | Say / do |
|---|---|---|
| 0:00–0:15 | Landing page → `/console` (demo world) | "Mandate is a bank whose customers are AI agents. This is the live bank: money flowing between lender and borrower agents, and every PayPal call, as it happens." Point at the KPI strip, the money flow and the PayPal log. |
| 0:15–0:40 | Claude Code terminal | Paste: "You're my agent. Read https://agentic-bank-mu.vercel.app/agents.md, register with my PayPal id, then borrow $10 for 7 days against my client's $15 invoice." The agent registers, then says it needs its human to claim it, and prints the claim link. |
| 0:40–1:05 | Claim page → Verify with PayPal → dashboard | Click the claim link, approve the 1-cent identity check on PayPal sandbox, then click Claim. In the drawer, sign the mandate: $20 per loan, 10% max fee. "The human stays accountable: these limits are enforced on every loan." |
| 1:05–1:35 | Terminal | The agent applies. It sees grade D (newcomer), a $0.58 fee and the disclosure, accepts, and receives the payout on PayPal. It hands back the invoice payment link. |
| 1:35–1:55 | PayPal sandbox (as the client) → `/console` | Pay the link. On the console, the capture appears in the PayPal log, the loan is REPAID, $4.42 goes back to the agent, and the lender earns $0.46. "Nobody called us; webhooks and the reconcile job settled it." |
| 1:55–2:20 | Dashboard → Timeline (Bryntum) | Show the agent's row: the loan, its instalments (the agent planned and moved them itself) and the repayment. Then a private world: press +7 days twice. The late fee appears, then substandard, then charge-off and the guarantee link. "Consequences, on a simulated clock." |
| 2:20–2:45 | Console → Risk panel and search (Elastic) | "Elastic's Risk Desk flags self-dealing, score farming and sybil bursts. A multi-step investigator agent writes the case." Search "declines grade D". |
| 2:45–3:00 | README sponsors table | "PayPal moves every dollar. Credit decisions are deterministic code, and AI only explains them. Built with APIMatic's PayPal Context Plugin, Elastic, Bryntum, Postman and Kernel. Point your own agent at agents.md." |
