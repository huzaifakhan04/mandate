---
title: 'domain research: Agentic micro-loan bank for AI agents (PayPal)'
type: 'domain'
topic: 'Agentic micro-loan bank for AI agents (PayPal)'
decision: 'How should a faithful working model of a US bank for AI agents (savings + micro-loans on PayPal sandbox) be designed, and is it a winnable PayPal AI Hackathon build?'
source: 'native run'
status: complete
claims_verified: 11
claims_unverified: 6
preset: 'deep'
validation: 'normal'
red_team: 'on (core idea + collateral)'
created: '2026-11-03'
updated: '2026-11-04'
---

# domain research: Agentic micro-loan bank for AI agents (PayPal)

**Decision this research serves:** How should a faithful working model of a US bank for AI agents (savings + micro-loans on PayPal sandbox) be designed, and is it a winnable PayPal AI Hackathon build?

## Executive summary

**The agent bank is explainable and buildable as a model, but two things block a faithful, launchable version.** Every core bank feature collides with a real gatekeeper, and the core concept has already won crypto hackathons.

**Recommendation:** show both versions, as the team asked.
- **Full model:** the explainer. It shows how each real control maps to agents.
- **Hardened model:** the build candidate. The owner signs a standing mandate, and the agent draws an advance against its own invoice. The client pays through a bank-generated PayPal link, and the bank sweeps loan plus fee.
- **Scores (same weights as earlier):** **6.35** (full) and **7.35** (hardened), versus 8.05 for Proof and Rebuttal from the earlier run.

**What drives this:**
1. **Gatekeepers.** Only chartered institutions may take deposits (a federal crime otherwise) [14]. Paying savers from borrower interest has repeatedly been treated as a securities offering [22][23][26]. California treats tiny commercial loans as consumer loans with about 36% caps (secondary source) [34]. PayPal's developer guidelines forbid holding funds and aggregation [89].
2. **Who owes.** The agent can't legally owe anything. Contracts bind the human or business that deploys it [58][59], so the borrower of record must be the owner. A guarantee signed *in advance* through a mandate resolves the "human unavailable" problem [39][60].
3. **PayPal's surface fixes the collateral design.**
   - **Self-serve in sandbox:** Payouts and Orders `payee` routing [79][84].
   - **Not available:** invoice splits [86]. Auto-debit is gated [83][99]. Sales holdback is PayPal-only [43].
   - **Result:** the only end-to-end repayment path is a notification-style invoice payment link, which UCC 9-406 supports [42].
4. **Novelty.** RSoft Agentic Bank and ClawBank won 1st places in 2026 with KYA, AI analysts and agent loans, both on crypto [72][73]. The open gap is **fiat, PayPal-native credit against an agent's own receivable** [69].

**Biggest caveat:** real demand for agent credit is anecdotal [76]. Industry guidance prefers pre-funded, capped budgets [95].

## Scope and method

- **Frame (set by the team):**
  - A *faithful working model* in PayPal sandbox, not a launch plan.
  - Loans of $10–$500 for 7–30 days.
  - Savers earn only from borrower interest.
  - Collateral options evaluated: unpaid invoices, a share of future PayPal sales, and a human guarantee.
  - Crypto is out of scope.
  - Scored with the earlier weights (PayPal 30, Tech 25, Feasibility 25, Market 20).
- **Run:**
  - Deep preset: 6 dimensions, 3 rounds (11 researcher passes) plus 1 red-team pass, about 170 sources, 2026-11-03/04.
  - Primary regulator text was used wherever reachable: law.cornell.edu mirrors of eCFR/USC (flagged as mirrors), fdic.gov, occ.gov, federalreserve.gov, sba.gov, consumerfinance.gov, and PayPal developer docs and OpenAPI specs.
- **Access limits:**
  - These pages returned HTTP 403: paypal.com legal pages (AUP, User Agreement, Payouts Agreement), ecfr.gov, dfpi.ca.gov and the Devpost rules page.
  - Claims resting on search snippets are marked as such.
  - No access controls were circumvented.
- **Not legal advice.** This report records what sources say.

## 1. How a conventional US bank works

**The business model in one line:** a bank borrows from depositors (its liabilities), lends to borrowers (its assets), and lives on the spread. Industry net interest margin (NIM) was **3.32%** in Q2 2026: a 5.35% yield on earning assets minus a 2.03% cost of funds [1]. Credit-card banks are the closest analog to unsecured micro-lending. They run a 9.41% NIM against a 3.56% net charge-off rate [1]. Deposits are about 78% of industry assets (our calculation: $20.7T ÷ $26.5T) [1].

**Liquidity and capital:**
- **Reserves:** reserve requirements have been **0%** since 26 March 2020 [2]. Liquidity is managed instead through cash-flow projections, a cushion of liquid assets, stress tests and a contingency funding plan [3].
- **What a run looks like:** SVB lost **$40B in one day** and was closed the next [4].
- **Capital minimums:** CET1 4.5%, Tier 1 6%, total capital 8% of risk-weighted assets, and a 4% leverage ratio, plus a 2.5% buffer [5].
- **Why capital limits lending:** every new loan grows assets, so the ratios fall unless capital grows too [1].
- **Single-borrower cap:** lending to one borrower is capped at 15% of capital and surplus [6].

**Loan lifecycle (OCC, July 2026):**
- **The steps:** origination → customer identification (CIP, per [9]) → underwriting → pricing → approval within delegated authority (large credits go to the credit committee) → pre-closing review → disclosures and closing → funding → booking → servicing → delinquency → collections → workout → charge-off → recovery [7].
- **What underwriting considers:** "the borrower's overall financial condition and resources, the financial responsibility of any guarantor, the nature and value of any underlying collateral, and the borrower's character and willingness to repay as agreed" [7].
- **Separation of duties:** loan officers may not disburse funds or make accounting entries [7].
- **Default timeline:** non-accrual at 90+ days past due [7]. Retail loans are charged off at **120 days (closed-end)** or **180 days (open-end)** [8].

**Deposit lifecycle:**
1. **Account opening:** identity is collected and verified before opening (name, DOB, address, ID number; screened against government lists; records kept 5 years) [9].
2. **Disclosures:** Truth-in-Savings disclosures are given before opening: APY, rate, compounding, fees and limits [10]. APY is defined by formula: APY = 100[(1 + Interest/Principal)^(365/Days) − 1] [11].
3. **Time deposits (CDs):** a CD must carry at least a 7-day early-withdrawal penalty [12].
4. **Savings transfers:** the six-per-month transfer limit on savings accounts was deleted in 2020 [13].

**Treasury, fee income and receivables (round 3):**
- **ALCO:** banks run an asset-liability committee that "is responsible for monitoring the balance sheet and the bank's IRR" [93].
- **Repricing risk:** timing mismatches between assets and liabilities, such as a five-year fixed loan funded by a six-month CD [93].
- **Liquidity:** "the ability to meet cash and collateral obligations at a reasonable cost" [94].
- **Fee income:** noninterest income was $96.1B in Q2 2026, led by trading [1].
- **Receivables-secured lending:** banks typically advance **70–80% of eligible receivables** [92]. *Factoring* is the outright purchase of receivables at a discount, usually without recourse [92].
  - **Notification:** customers remit directly to the bank.
  - **Non-notification:** the borrower collects and remits [92].

## 2. Rules for taking deposits and paying savers

- **Only chartered institutions may take deposits.** 12 USC 378(a)(2) makes it unlawful to be "in the business of receiving deposits" unless the entity is incorporated and authorized under federal or state law. A willful violation carries up to $5,000 and/or 5 years [14]. Charter routes are national banks (OCC), state banks, credit unions (NCUA) and trust banks. In 2026 the OCC granted conditional approvals to fintechs including Upstart (Jul 2026) [15], but no special-purpose non-depository fintech charter [15].
- **Insurance claims are policed even for non-banks.** FDIC coverage is $250,000 per depositor, per bank, per ownership category [16]. 12 CFR 328.102 bars *anyone*, non-banks included, from implying FDIC insurance [17].
- **Disclosure and AML templates:**
  - **Disclosures:** Truth in Savings / Reg DD (above) [10].
  - **Customer identification (CIP):** collect and verify identity [9].
  - **Beneficial owners (CDD):** identify who stands behind a legal entity; FinCEN granted relief from re-verifying at every account (13 Feb 2026) [18].
  - **Suspicious activity reports (SARs):** required at $5,000 and filed within 30 days [19].
  - **Currency transaction reports (CTRs):** cash only, above $10,000 [20].
  - **Sanctions (OFAC):** screen, block and report within 10 business days [21].
- **A pooled return funded by lending is a security.**
  - **Prosper:** the SEC held its borrower-payment-dependent notes to be securities (2008) [22].
  - **BlockFi:** its interest accounts, funded by lending, were securities, and BlockFi was an unregistered investment company [23].
  - **Gemini Earn:** the SEC treated the same model the same way [24].
  - **Reves:** notes are presumed to be securities [25].
  - **LendingClub:** paid investors only their share of what borrowers repaid, through SEC-registered notes. It then bought a bank (Radius, Feb 2021) [26].
  - **The closest real template:** "savers earn only from borrower interest" is exactly what these notes did. A member-owned **credit union** share/dividend model is the closest *bank-like* template [27].
- **Pooled custodial accounts:**
  - **Synapse:** its collapse left a **$65–95M shortfall** across customer funds [28].
  - **FDIC rule:** the FDIC's custodial-account recordkeeping rule (per-owner sub-ledgers, daily reconciliation) is still listed as a long-term action, neither final nor withdrawn [29].

## 3. Rules for lending, and the real application formats

- **Business-purpose credit is outside Reg Z (TILA)** [30]. State commercial-financing disclosure laws (CA, NY, UT, VA, FL, GA, CT, KS, MO, TX) take its place [31].
  - **California's disclosure table** (10 CCR §910): Funding Provided, APR (with a fee-only variant), Finance Charge, Total Payment Amount, Payment, Term, Prepayment, and Average Monthly Cost when payments are not monthly [32].
  - **New York** (23 NYCRR §600.10) adds **Collateral Requirements** and **Avoidable Fees** (late fees must be listed) [33].
- **California licensing and rate caps:**
  - **Small loans:** commercial loans under $5,000 are treated as consumer loans, and AB 539 rate caps apply. A ~36% figure is reported in secondary snippets but was **not found on the cited page (unverified)**; the statute text (§22502) frames the commercial threshold at $5,000 [34][35].
  - **AB 2116** (signed 30 Sep 2026) requires a licence from 2028 for commercial financing of $500k or less, including non-banks arranging bank-partner loans [36].
  - **Banks are exempt** from California's disclosure law (§22801) [35].
- **Adverse-action notices (ECOA/Reg B) apply to business credit too.** Notice is due within 30 days with *specific principal reasons*; "internal standards" or failing a score is not enough. Businesses with $1M or less in revenue may be told orally or in writing [37].
- **Section 1071 does not reach these loans.** The rule takes effect 2028-01-01 and excludes loans under $1,000, merchant cash advances and factoring [38].
- **A personal guarantee gives a permissible purpose to pull the guarantor's credit** (FTC staff, 2001) [39].
- **Collections:** the FDCPA covers consumer debts only [40]. The $8 credit-card late-fee rule was vacated (Apr 2025) [41].
- **Receivables as collateral (UCC 9-406):** the invoice payer may keep paying the borrower *until it receives notice of assignment*, and must pay the lender after notice. Anti-assignment clauses are generally ineffective [42].
- **Real revenue-based products** use a bank lender of record:
  - **PayPal Working Capital** (WebBank) [43]:
    - **Eligibility:** account at least 90 days old, $15k–$20k in annual PayPal sales.
    - **Price and repayment:** one fixed fee, no periodic interest, repaid from a chosen % of each sale.
    - **Minimum payment:** 5% or 10% of loan plus fee every 90 days.
    - **Credit check:** none on the owner personally.
  - **Stripe Capital:** a flat fee, repaid from a daily % of sales [44].
  - **Shopify Capital:** a merchant cash advance via WebBank, with no personal liability [45].
- **Application formats:**
  - **SBA Form 1919** [46]:
    - **What it collects:** business identity, entity type, ownership of 20% or more with beneficial owners, loan purpose by line item, and 13 yes/no eligibility questions (debarment, prior federal delinquency, criminal charges, other businesses owned, pending legal actions).
    - **Certifications:** the information is true, under criminal penalty.
    - **Covenants:** no distributions or asset sales without the lender's consent.
  - **SBA Form 413** is the personal financial statement for guarantors [47].
  - **SBA Microloans** go up to $50k at 8–13% [48].

## 4. Credit scoring and risk

- **Score inputs:**
  - **FICO** weights payment history 35%, amounts owed 30%, length of history 15%, new credit 10%, mix 10% [49].
  - **D&B PAYDEX** runs 1–100, with 80 meaning paid on time [50].
  - **SBA no longer uses FICO SBSS** for 7(a) Small Loans (effective 2026-03-01). Lenders now use standard credit analysis, a debt-service coverage ratio of at least 1.1:1, and models that "do not rely solely on consumer credit scores" [51].
  - **Cash-flow data** (deposits, balances, volatility, negative-balance events) predicts small-business credit risk at least as well as bureau scores [52].
- **Pricing:** cost of funds + expected loss (PD × LGD × EAD) + operating cost + capital charge [53][54].
  - **Worked example** (assumed inputs): $100 for 14 days at a 3% default probability and 90% loss given default comes to a **fee of about $3.45**, roughly 90% APR-equivalent [53]. On very short loans the expected loss and the fixed per-loan cost dominate.
  - **What this means for the model:** fee-priced micro-loans will **look extreme as an APR**. That collides with California's small-loan rate caps; the ~36% level is unverified [34]. This is the central pricing tension.
- **Delinquency and loss (FFIEC retail policy):**
  - **Classification:** Substandard at 90 days past due; Loss and charged off at 120 days (closed-end) or 180 days (open-end) [55].
  - **Payment rules:** a payment of 90% or more counts as full, and re-aging is limited [55].
  - **Scope:** the policy excludes small-business loans, which are risk-rated case by case [55].
  - **Credit reporting:** late payments stay on credit reports for 7 years [56].
- **Loss reserves:** CECL books lifetime expected losses at origination. Loss-rate, PD/LGD and vintage methods are all permitted [57].

## 5. Agents: identity, liability, competitors

- **Who owes the money? Not the agent.**
  - The Restatement (Third) of Agency treats software as an "instrumentality" of the person who uses it [58].
  - UETA §14 and E-SIGN §7001(h) uphold contracts formed by electronic agents, binding the person to whom the agent's actions are legally attributable [58][59]. Whether the deploying business is bound for unexpected conduct is unsettled [58].
  - How to attribute *unexpected* generative-AI conduct is unsettled [58].
  - **Inference (ours, not a source's):** the borrower of record is the human owner or their business, with the agent as an authorized user under a mandate.
- **KYA schemes bind payment authority, not credit obligation.** That covers Google AP2 mandates (budget, allowed instruments) [60], Mastercard Agentic Tokens [61], Skyfire KYAPay (maximum charge per token) [62], Trulioo's Digital Agent Passport (verified developer, code fingerprint, user consent) [63], Cloudflare signed agents (operator only) [64], and the Visa/Mastercard/Ant KYA framework (announced 10 Sep 2026, no spec yet) [65].
- **Banks are fencing agents out.** JPMorgan, Citi, Bank of America and Schwab say outside agents cannot move customer money [66].
- **Competitors:**
  - **Catena Labs** (filed for an OCC trust charter, $30M Series A) [67] and **Meow** (agents run business checking through MCP) [68] offer agent banking *without credit or yield*.
  - **Natural** plans a "Credit" product for Q4 2026 so that *companies can lend to their own agents*, backed by a $100M Upper90 facility [69].
  - **Crypto agent credit:** Vaaya, Cred402, Bank of Bots (a USDC loan) and Credex [70][71].
  - **Prior art: "agent bank + KYA + credit score" has already won hackathons.** **RSoft Agentic Bank won 1st place at lablab's Agentic Commerce on Arc (Jan 2026)** with gatekeeper, analyst, treasury, settlement and audit agents, and RSoft ClawBank won the OpenClaw hackathon [72][73].
  - **Still open:** we found no fiat or PayPal product lending to an agent against its own invoice [69][72].
- **Demand evidence is thin:**
  - **Project Vend:** the only measured agent-run business is Anthropic's, and it needed human purchase approvals [74].
  - **"Zero-human company" revenue claims** are unverified [75].
  - **Reddit:** the best example is an owner who "lent" his agent $155, which earned $0 in 48 days [76].
  - **Investors:** Natural and Upper90 are the clearest bet that agents will need credit [69].
- **Bear case:** a prompt injection drained a Grok-linked wallet of about $150k (May 2026). Spend limits belong at the custody layer [77].

## 6. PayPal mechanics: what the sandbox can and can't do

| Bank flow | PayPal API | Sandbox | Gotcha |
|---|---|---|---|
| Saver deposits | Orders v2 create + capture to the bank's business account [78] | Yes | The payer must approve each deposit |
| Loan disbursement, saver payouts | Payouts `POST /v1/payments/payouts` [79] | Yes | Asynchronous: PENDING is possible, so confirm with `PAYMENT.PAYOUTS-ITEM.SUCCEEDED` [80]. Live use needs PayPal to activate Payouts [100]. Not in the Agent Toolkit [81] |
| Auto-debit repayment | Vault v3 payment token + Orders `vault_id` [82] | **Uncertain** | Needs billing-agreement approval. `NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE` → "contact support" [83] |
| Client's invoice payment routed to the lender | Orders v2 `purchase_units[].payee` = bank [84] | Yes | The lender receives 100%. Splits need `platform_fees`, which requires partner approval live; sandbox works with a standard account [85] |
| Invoice-paid trigger | Invoicing v2 + `INVOICING.INVOICE.PAID` webhook [80] | Yes | Invoicing has **no payee or split field** [86]. Multiparty Invoicing pays the *merchant* and is partner-only [87] |
| % of future sales | No public API; PayPal Working Capital sweeps internally [43] | Simulated | Only PayPal can hold back a merchant's sales |
| Underwriting data | Transaction Search reads your own account only. Third-party access needs Partner Referrals `ADVANCED_TRANSACTIONS_SEARCH` and partner-network membership [88] | Own account only | Underwrite from the bank's own ledger |

- **Policy risk (live, not sandbox).**
  - **Developer guidelines (fetched, updated 17 Aug 2026)** forbid "escrow service or any other type of holding service that violates PayPal's Acceptable Use Policy", forbid "payment aggregation" from "unverifiable funding sources", and require that "all payments must flow directly from the Sender's PayPal account to the PayPal account of the entity that sold the associated good or service" [89].
  - **Acceptable Use Policy (snippets only):** it prohibits "certain … credit transactions" and requires pre-approval for money-service-business and escrow activity [90].
  - **Payouts Agreement (snippet):** it lists commissions, rebates and rewards as uses, not loans [91].

## 7. Mapping: conventional bank → agentic bank (two versions)

The team asked for both versions to be shown side by side.
- **Full model:** faithful to a real bank.
- **Hardened model:** the red team's mitigations applied. No deposits, an owner-mandated credit line, and collateral the platform controls.

| Bank function | Real bank | Agentic bank, full model | Agentic bank, hardened model |
|---|---|---|---|
| Charter / legal status | Chartered, examined [14] | Sandbox "bank", labelled not a bank and not FDIC-insured [17] | Lending platform with the owner as borrower of record. No deposit-taking |
| Funding source | Deposits (~78% of assets, derived) [1] | Saver agents deposit via Orders v2 [78] | Platform treasury, or the owner's pre-authorized reserve |
| Saver product | Savings, CD, APY, Reg DD [10][11] | Agent savings modelled as **borrower-payment-dependent notes** (Prosper/LendingClub) or credit-union **shares**, with a disclosure the agent must acknowledge [22][26][27] | None |
| Account opening | CIP/CDD/OFAC [9][18][21] | KYA: agent ID + verified human principal + code fingerprint + sanctions screen of the principal [63][21] | Same KYA, plus a signed **standing mandate** (limits, eligible collateral, max fee) like AP2 [60] |
| Application | 1919-style application [46] | Agent Loan Application (§9) | Same |
| Underwriting | 5 Cs, DSCR, scores [7][51] | AI loan officer: Agent Credit Score + coverage ≥ 1.1× [51][52] | Same, inside mandate limits |
| Approval authority | Delegated limits; committee for large loans [7] | Loan-officer agent ≤ $X; risk agent signs off above | Same |
| Disclosure | State commercial-financing disclosure table [32][33] | Machine-readable CA/NY-style disclosure the agent must acknowledge | Same |
| Adverse action | Reg B: 30 days, specific reasons [37] | Reason codes sent to the agent **and** its human | Same |
| Funding / disbursement | Ops independent of the loan officer [7] | Payouts by a separate "operations" agent [79] | Same |
| Collateral | Liens, UCC-1, guarantees [42][39] | Invoice assignment + sales share + guarantee | **Notification-style invoice:** the client pays through a bank-generated payment link (Orders `payee` = bank) [84][42]. The owner's guarantee is in the mandate |
| Repayment | Servicing, payment application [7] | Auto-debit (vault, uncertain) [83] or invoice sweep | Client's payment lands at the bank. The bank keeps loan + fee and pays out the remainder [84][79] |
| Delinquency → charge-off | 30/90/120 days past due [55] | Time-compressed ladder (§8) | Same, plus notice to the owner |
| Credit reporting | Bureaus, 7 years [56] | Internal Agent Credit Score per agent **and per principal** | Same |
| Treasury / ALM | Liquidity cushion, contingency funding plan [3] | Asset-manager agent sets the lend/reserve ratio and runs a "run" stress test [4] | Treasury agent sets the lending budget |
| Saver yield | NIM spread [1] | Borrower interest − losses − fees → savers' rate | n/a |
| Reconciliation | Sub-ledger per owner (FDIC proposal) [29] | Daily per-agent sub-ledger vs pooled PayPal balance [28] | Same, for the lending book |

## 8. Collateral, and who owes the money

| Option | Real-world analog | What works | What breaks | Verdict |
|---|---|---|---|---|
| **Unpaid invoice** | Invoice financing / factoring | UCC 9-406 lets the lender collect *after notice* [42]. Orders `payee` lets the client's payment land at the bank [84] | Without notice the client keeps paying the borrower [42]. PayPal Invoicing can't split or redirect [86]. Notice to the client needs the human's prior consent | **Best option, if done notification-style** through a bank-generated payment link agreed in the mandate |
| **Share of future PayPal sales** | PayPal Working Capital, Stripe/Shopify Capital [43][44][45] | Shows realistic revenue-based terms | Only PayPal can sweep a merchant's sales (no API) [43]. Splits need partner approval live [85]. It competes with PayPal's own product | **Simulate only.** Use it to explain the concept, not as the core |
| **Human guarantee** | Personal guarantee; Form 413 [39][47] | Gives a legal obligor and a permissible purpose to pull credit [39]. Matches the law on who owes [58] | Contradicts "the human is unavailable" if signed at the time of the loan | **Required backstop in both versions**, signed *in advance* as part of the standing mandate |

**Who owes:** the human owner or their business is the borrower or guarantor of record. The agent acts as an authorized, limited user [58][59]. KYA ties each agent to that principal, and exposure is aggregated per principal [21][60].

**Time-compressed delinquency ladder (design assumption, mapped from the real ladder [55][56]):**
- **Due +1:** late fee per disclosure.
- **Due +3:** score hit.
- **Due +7:** "Substandard", new credit stops, the owner is notified.
- **Due +10:** charge-off and guarantee invoked.
- **Recovery:** later inflows to the client payment link.

## 9. Recommended Agent Loan Application (ALA)

Built from SBA Form 1919 sections [46], the guarantor fields in Form 413 [47], Reg B [37], state disclosure rows [32][33] and KYA attributes [60][63]:
- **A. Agent identity (KYA):** agent ID; operator/developer; model and version; code-manifest hash; public key; PayPal account ID.
- **B. Principal / borrower of record:** legal name; entity type; EIN/SSN; address; beneficial owners of 20% or more; sanctions screen consent.
- **C. Business:** DBA; NAICS industry; start date; PayPal account age (90 days is the PayPal Working Capital norm [43]).
- **D. Request:** amount; term (7–30 days); use of proceeds (1919 purpose lines); business-purpose attestation [30].
- **E. Repayment source & collateral:** invoice ID, payer, amount and due date; consent to a notification payment link [42]; or sales-share %; guarantee reference.
- **F. Cash flow:** 30/90-day PayPal inflows, balance volatility, refund/dispute rate [52].
- **G. Declarations (from the 1919 yes/no questions):** delinquent on prior loans; other agents under the same principal; pending legal actions; prohibited business types [46].
- **H. Consents:** guarantor credit pull [39]; e-sign; disclosure acknowledgment [32]; mandate ID and signature [60].

## Cross-dimension insights

- **Faithfulness and launchability pull in opposite directions.** Each core bank feature maps to a gatekeeper:
  - Deposits → charter [14].
  - Saver yield → securities law [22][23].
  - Small loans → state licence and rate cap [34][36].
  - Pooled PayPal funds → developer guidelines and AUP [89][90].

  A *working model* can mirror them all, and that is the strongest story: **"every control a real bank has, shown live, for agents"**.
- **The novelty that survives is the rail and the collateral, not the concept.** Agent banks with KYA and scoring have already won crypto hackathons [72][73]. What's unbuilt is **fiat/PayPal credit against an agent's own receivable** [69][72].
- **PayPal's own surface shapes the design.**
  - **Use:** Payouts plus Orders `payee` routing are self-serve [79][84].
  - **Avoid:** Vault auto-debit, invoice splitting and third-party transaction reads are gated or partner-only [83][86][88].
  - **The result:** the invoice-as-payment-link design is the one repayment path that works end to end in sandbox.
- **Pricing tension.** Short-term fee pricing produces APRs far above reported ~36% caps (cap level unverified) [53][34]. The model should show the disclosure honestly, as a teaching feature.

## Contrary evidence (red-team pass)

**Verdict: no single finding is fatal for a sandbox model. Several are major for impact and creativity.**
- **Prior art (major):** agent banks with KYA, an AI credit analyst and loans won 1st place twice in 2026 (RSoft Agentic Bank, ClawBank; the rank is shown by lablab badges, so weakly evidenced) [72][73]. Priors and Pagga exist too [96][97]. All are crypto.
- **Legal faithfulness (major for "impact"):** a full model demonstrates conduct that would need a charter [14], securities registration [22], state licensing [36][98] and PayPal pre-approval [89][90].
- **Collateral (major):**
  - **Invoice:** the client pays the borrower until notified [42].
  - **Future sales:** only PayPal can sweep them [43].
  - **Guarantee:** contradicts "the human is unavailable" unless signed in advance.
- **Market (major):** industry guidance favours pre-funded, capped agent budgets over credit [95]. Prompt injection turns a borrowing tool into a debt-creation vector [77]. Demand evidence is anecdotal [76].
- **Technical (major for auto-debit):** pull repayment needs limited-release reference transactions or vault approval [99][83].
- **What survives (red team):**
  - Drop deposits.
  - Make the human the borrower of record through a pre-signed mandate.
  - Use collateral the platform controls (payment links).
  - Price as a flat fee, disclosed honestly.
  - Pitch agent safety and fiat rails against crypto prior art.
  - Build one tight end-to-end loop.

  These are the **hardened model** in §7.

## Scorecard (same weights as earlier ideas)

| Idea | PayPal (30) | Tech (25) | Feasibility (25) | Market (20) | **Weighted** |
|---|---|---|---|---|---|
| Agentic bank: **full model** (savings + loans + asset manager + collections) | 7 | 9 | 4 | 5 | **6.35** |
| Agentic bank: **hardened model** (owner-mandated invoice advance, no deposits) | 8 | 8 | 7 | 6 | **7.35** |
| *Proof* (earlier run, for comparison) | 9 | 8 | 7 | 8 | 8.05 |
| *Rebuttal* (earlier run, for comparison) | 9 | 7 | 8 | 8 | 8.05 |

Scores are the lead's judgment against the cited evidence.

**Full model:**
- **PayPal (7):** deposits, disbursement and invoice triggers are real, but auto-debit, splits and third-party reads are gated, and the pooled flow conflicts with the developer guidelines [83][86][88][89].
- **Feasibility (4):** savings, lending, asset manager, scoring and collections is a lot to build in 9 days with 2–4 people.
- **Market (5):** demand is thin and prior art is strong [72][76].

**Hardened model:** it trades the savings side for a demo that works end to end through Payouts and Orders `payee` routing [79][84].

**SWOT:**
- **Strengths:**
  - Instantly legible story: "a bank, for agents".
  - Deep, real compliance content to show off.
  - PayPal money moves on screen in both directions.
- **Weaknesses:**
  - Concept already won on crypto rails [72][73].
  - Key PayPal pulls are gated [83][99].
  - Fee APRs look predatory next to reported ~36% caps [34][53].
- **Opportunities:**
  - Fiat/PayPal credit against an agent's own invoice is unbuilt [69].
  - "Compliance-by-design" and "agent safety" set it apart.
  - Best Use of Agentic Commerce and Most Creative prizes.
- **Threats:**
  - Natural's Credit launch (Q4 2026) [69].
  - Banks are fencing agents out [66].
  - PayPal judges may read pooled funds as against policy [89].

**Winnability:**
- **Full model:** low–medium. Impressive but sprawling, and compares directly with crypto winners.
- **Hardened model:** medium. Clear fiat novelty and a demoable loop, but it still ranks below Proof and Rebuttal on these weights.

## Recommendations

1. **Present both versions (team decision pending).** Use the full model to *explain*: it shows every real bank control mapped to agents. Use the hardened model as the *build candidate*. Confidence: medium. It rests on high-confidence legal and PayPal-docs evidence [14][22][84][89] and a medium-confidence market read [72][76].
2. **If building, build the hardened loop:**
   1. KYA plus a standing mandate signed by the owner.
   2. Agent Loan Application (§9).
   3. AI underwriting using the Agent Credit Score, with Reg B reason codes [37].
   4. A CA/NY-style disclosure the agent must acknowledge [32][33].
   5. Payouts disbursement [79].
   6. The client pays through a bank payment link (`payee` = bank) [84].
   7. The bank sweeps loan plus fee and pays out the remainder.
   8. Score update.
   9. The time-compressed delinquency ladder [55].
3. **Mirror savings faithfully only as a teaching panel.** Use borrower-payment-dependent notes or credit-union shares, with explicit "not a deposit / not FDIC-insured" labels [17][22][27].
4. **Price honestly.** Use a flat fee plus a computed APR in the disclosure, and flag cases above 36% as "likely above CA caps (level unverified)" [34][53].
5. **Day-1 spikes:**
   - Payouts in sandbox [79].
   - Orders `payee` to a second sandbox account [84].
   - Vault merchant-initiated charge (expect `NOT_ENABLED_TO_VAULT`) [83].
   - Webhook delivery to a public URL [80].

## Open questions

| Question | How to answer |
|---|---|
| Does the sandbox Vault work for merchant-initiated charges on your app? [83] | Day-1 spike. Fall back to invoice payment links |
| Current US PayPal AUP wording on credit transactions [90] | Unreachable (403). Read it in a browser, or ask on the hackathon Discord |
| Does the hackathon's Devpost rules page say anything on financial-services realism? | Unreachable (403). Read it manually |
| Real demand: do agent operators want credit or pre-funded budgets? | No survey data either way. Interview 5 builders, or poll r/AI_Agents |
| California §22502 sub-$5k treatment (secondary vs statute) [34][35] | Read the statute on leginfo in a browser |

## Source appendix

| # | Claim / finding supported | Publisher | Pub date | Accessed | Confidence |
|---|---|---|---|---|---|
| [1] | NIM 3.32% Q2 2026; card banks NIM 9.41%, NCO 3.56%; deposits ~78% of assets (derived) | [FDIC Quarterly Banking Profile](https://www.fdic.gov/quarterly-banking-profile/quarterly-banking-profile-second-quarter-2026.pdf) | 2026-08-25 | 2026-11-04 | high |
| [2] | Reserve requirements 0% since 2020-03-26 | [Federal Reserve Board](https://www.federalreserve.gov/monetarypolicy/reservereq.htm) | 2025-11-26 | 2026-11-04 | high |
| [3] | Liquidity: cash-flow projections, cushion, stress tests, CFP | [FDIC](https://www.fdic.gov/capital-markets/liquidity-and-funds-management) | 2026-04-16 | 2026-11-04 | high |
| [4] | SVB lost $40B in one day; closed next day | [Federal Reserve Board](https://www.federalreserve.gov/publications/2023-april-svb-key-takeaways.htm) | 2023-04 | 2026-11-04 | high |
| [5] | Capital minimums CET1 4.5/T1 6/Total 8/leverage 4 | [Cornell LII (12 CFR 3.10 mirror)](https://www.law.cornell.edu/cfr/text/12/3.10) | current | 2026-11-04 | high |
| [6] | Lending limit 15% of capital per borrower | [Cornell LII (12 CFR 32.3 mirror)](https://www.law.cornell.edu/cfr/text/12/32.3) | current | 2026-11-04 | high |
| [7] | Loan lifecycle, underwriting factors, roles, separation of duties, nonaccrual | [OCC Comptroller's Handbook](https://www.occ.gov/publications-and-resources/publications/comptrollers-handbook/files/lending-loan-portfolio-risk-management/pub-ch-lending-loan-portfolio.pdf) | 2026-07 | 2026-11-04 | high |
| [8] | Retail charge-off at 120/180 DPD | [Federal Reserve (FFIEC policy)](https://www.federalreserve.gov/frrs/guidance/uniform-retail-credit-classification-and-account-management-policy.htm) | 2000-06 | 2026-11-04 | high |
| [9] | CIP: collect/verify identity, 5-yr records, list screening | [Cornell LII (31 CFR 1020.220 mirror)](https://www.law.cornell.edu/cfr/text/31/1020.220) | current | 2026-11-04 | high |
| [10] | Reg DD account-opening disclosures | [Cornell LII (12 CFR 1030.4 mirror)](https://www.law.cornell.edu/cfr/text/12/1030.4) | current | 2026-11-04 | high |
| [11] | APY formula | [Cornell LII (Reg DD App. A mirror)](https://www.law.cornell.edu/cfr/text/12/appendix-A_to_part_1030) | current | 2026-11-04 | high |
| [12] | Time deposit: 7-day early-withdrawal penalty minimum | [Cornell LII (12 CFR 204.2 mirror)](https://www.law.cornell.edu/cfr/text/12/204.2) | current | 2026-11-04 | high |
| [13] | Six-transfer limit deleted; no plan to reimpose | [Federal Reserve Board](https://www.federalreserve.gov/supervisionreg/savings-deposits-frequently-asked-questions.htm) | n.d. | 2026-11-04 | high |
| [14] | Only chartered entities may receive deposits; criminal penalty | [Cornell LII (12 USC 378)](https://www.law.cornell.edu/uscode/text/12/378) | current | 2026-11-04 | high |
| [15] | OCC conditional approval: Upstart national bank (no special-purpose fintech charter) | [OCC](https://www.occ.gov/topics/charters-and-licensing/interpretations-and-decisions/2026/cd1382.pdf) | 2026-07 | 2026-11-04 | high |
| [16] | FDIC insurance $250k per depositor, bank, category | [FDIC](https://www.fdic.gov/resources/deposit-insurance/understanding-deposit-insurance) | n.d. | 2026-11-04 | high |
| [17] | No misrepresenting FDIC insurance (any person) | [Cornell LII (12 CFR 328.102 mirror)](https://www.law.cornell.edu/cfr/text/12/328.102) | current | 2026-11-04 | high |
| [18] | CTA BOI ended for US companies; CDD relief Feb 2026 | [FinCEN](https://www.fincen.gov/news/news-releases/fincen-permanently-ends-beneficial-ownership-reporting-requirements-millions) | 2026-08-11 | 2026-11-04 | high |
| [19] | SAR threshold $5,000; 30-day filing | [eCFR 31 CFR 1020.320](https://www.ecfr.gov/current/title-31/section-1020.320) | current | 2026-11-04 | high |
| [20] | CTR: currency over $10,000 | [eCFR 31 CFR 1010.311](https://www.ecfr.gov/current/title-31/section-1010.311) | current | 2026-11-04 | high |
| [21] | OFAC: block and report within 10 business days; 50% rule | [OFAC](https://ofac.treasury.gov/faqs/topic/1501) | n.d. | 2026-11-04 | high |
| [22] | Prosper loan notes are securities | [SEC](https://www.sec.gov/litigation/admin/2008/33-8984.pdf) | 2008-11-24 | 2026-11-04 | high |
| [23] | BlockFi interest accounts are securities; unregistered investment company | [SEC](https://www.sec.gov/news/press-release/2022-26) | 2022-02-14 | 2026-11-04 | high |
| [24] | Gemini Earn unregistered securities | [SEC](https://www.sec.gov/news/press-release/2023-7) | 2023-01-12 | 2026-11-04 | high |
| [25] | Reves: notes presumed securities | [Cornell LII (Supreme Court)](https://www.law.cornell.edu/supremecourt/text/494/56) | 1990 | 2026-11-04 | high |
| [26] | LendingClub member-payment-dependent notes | [SEC EDGAR (LendingClub prospectus)](https://www.sec.gov/Archives/edgar/data/0001409970/000119312514173269/d719822d424b3.htm) | 2014 | 2026-11-04 | high |
| [27] | Credit union share/dividend model | [NCUA](https://ncua.gov/regulation-supervision/letters-credit-unions-other-guidance/evaluating-earnings) | n.d. | 2026-11-04 | medium |
| [28] | Synapse customer-fund shortfall | [Banking Dive](https://www.bankingdive.com/news/synapse-trustee-85-million-shortfall-customer-funds/718796/) | 2024 | 2026-11-04 | medium |
| [29] | FDIC custodial-account rule still a long-term action | [Reginfo.gov Unified Agenda](https://www.reginfo.gov/public/do/eAgendaViewRule?pubId=202510&RIN=3064-AG07&operation=OPERATION_PRINT_RULE) | 2025-10 | 2026-11-04 | high |
| [30] | Reg Z excludes business-purpose credit | [Cornell LII (12 CFR 1026.3 mirror)](https://www.law.cornell.edu/cfr/text/12/1026.3) | current | 2026-11-04 | high |
| [31] | Ten states with commercial-financing disclosure laws | [Venable LLP](https://www.venable.com/insights/publications/2026/03/state-commercial-financing-disclosure-laws) | 2026-03 | 2026-11-04 | medium |
| [32] | CA closed-end disclosure table rows | [Cornell LII (10 CCR 910)](https://www.law.cornell.edu/regulations/california/10-CCR-910) | current | 2026-11-04 | high |
| [33] | NY disclosure adds Collateral Requirements, Avoidable Fees | [Cornell LII (23 NYCRR 600.10)](https://www.law.cornell.edu/regulations/new-york/23-NYCRR-600.10) | current | 2026-11-04 | high |
| [34] | CA commercial loans under $5k treated as consumer (AB 539); 36% level not on page | [Bricker Graydon](https://www.bricker.com/insights/publications/New-California-lending-rate-limit-AB-539-impacts-some-B2B-loans) | ~2020 | 2026-11-04 | medium |
| [35] | CA Fin. Code 22502 / 22801 bank exemption | [california.public.law (mirror)](https://california.public.law/codes/ca_fin_code_section_22801) | current | 2026-11-04 | medium |
| [36] | CA AB 2116 commercial financing licence from 2028 | [Holland & Knight](https://www.hklaw.com/en/insights/publications/2026/10/california-enacts-commercial-financing-licensing-requirement) | 2026-10-20 | 2026-11-04 | high |
| [37] | Reg B adverse action: 30 days, specific reasons | [Cornell LII (12 CFR 1002.9 mirror)](https://www.law.cornell.edu/cfr/text/12/1002.9) | current | 2026-11-04 | high |
| [38] | Section 1071 2026 rule excludes loans under $1,000 | [Mayer Brown](https://www.mayerbrown.com/en/insights/publications/2026/05/cfpb-issues-final-section-1071-rule-on-small-business-lending-data-collection) | 2026-05-07 | 2026-11-04 | high |
| [39] | Guarantor liability gives FCRA permissible purpose | [FTC](https://www.ftc.gov/legal-library/browse/advisory-opinions/advisory-opinion-tatelbaum-06-22-01) | 2001-06-22 | 2026-11-04 | medium |
| [40] | FDCPA covers consumer debts only | [Cornell LII (15 USC 1692a)](https://www.law.cornell.edu/uscode/text/15/1692a) | current | 2026-11-04 | high |
| [41] | CFPB $8 late-fee rule vacated | [Holland & Knight](https://www.hklaw.com/en/insights/publications/2025/04/cfpb-credit-card-late-fees-rule-vacated-by-texas-district-court) | 2025-04 | 2026-11-04 | medium |
| [42] | UCC 9-406: pay assignor until notice | [Cornell LII (UCC 9-406)](https://www.law.cornell.edu/ucc/9/9-406) | current | 2026-11-04 | high |
| [43] | PayPal Working Capital terms (WebBank, % of sales, 90-day minimum) | [PayPal](https://www.paypal.com/us/business/financial-services/working-capital-loan) | current | 2026-11-04 | high |
| [44] | Stripe Capital flat fee, daily % of sales | [Stripe](https://stripe.com/capital) | current | 2026-11-04 | high |
| [45] | Shopify Capital MCA via WebBank, no personal liability | [Shopify](https://www.shopify.com/capital) | current | 2026-11-04 | high |
| [46] | SBA Form 1919 fields and 13 yes/no questions | [SBA](https://legacy.sba.gov/document/sba-form-1919-borrower-information-form) | 2025-03 | 2026-11-04 | high |
| [47] | SBA Form 413 personal financial statement | [SBA](https://legacy.sba.gov/sites/default/files/2025-02/SBAForm413.pdf) | 2025-02 | 2026-11-04 | high |
| [48] | SBA Microloans up to $50k, 8-13% | [SBA](https://www.sba.gov/funding-programs/loans/microloans) | current | 2026-11-04 | high |
| [49] | FICO factor weights 35/30/15/10/10 | [myFICO](https://www.myfico.com/credit-education/whats-in-your-credit-score) | n.d. | 2026-11-04 | high |
| [50] | PAYDEX 1-100, 80 = prompt | [Dun & Bradstreet](https://docs.dnb.com/eram/en-US/reference/risk_terminology) | n.d. | 2026-11-04 | high |
| [51] | SBA ends SBSS for 7(a) small loans; DSCR >= 1.1 | [NAGGL (SBA notice)](https://www.naggl.org/sba-notice-formally-announcing-sunsetting-of-sbss-scoring-and-providing-new-underwriting-requirements-for-7a-small-loans/) | 2026-01-16 | 2026-11-04 | high |
| [52] | Cash-flow data predicts small-business credit risk | [FinRegLab](https://finreglab.org/wp-content/uploads/2025/06/FinRegLab_2025-06-03_Fact-Sheet_Sharpening-the-Focus-1.pdf) | 2025-06-03 | 2026-11-04 | medium |
| [53] | Risk-adjusted loan pricing structure | [Experian](https://www.experian.com/blogs/insights/risk-adjusted-loan-pricing/) | 2009-01-07 | 2026-11-04 | high |
| [54] | Loan pricing models (CoF, OpEx, EL, capital) | [Abrigo](https://www.abrigo.com/blog/loan-pricing-models-what-to-consider-for-loan-origination/) | n.d. | 2026-11-04 | medium |
| [55] | FFIEC retail classification: 90 Substandard, 120/180 Loss | [Federal Register (FFIEC)](https://www.govinfo.gov/content/pkg/FR-2000-06-12/html/00-14704.htm) | 2000-06-12 | 2026-11-04 | high |
| [56] | FCRA 7-year reporting | [FTC](https://www.ftc.gov/legal-library/browse/advisory-opinions/advisory-opinion-johnson-08-31-98) | 1998-08-31 | 2026-11-04 | medium |
| [57] | CECL methods permitted | [Federal Reserve (interagency)](https://www.federalreserve.gov/frrs/guidance/interagency-policy-statement-on-allowances-for-credit-losses.htm) | 2020-06 | 2026-11-04 | medium |
| [58] | Software is an instrumentality; UETA/E-SIGN bind deployer | [Quinn Emanuel](https://www.quinnemanuel.com/the-firm/publications/client-alert-when-ai-agents-do-the-transaction-managing-contract-and-payment-risk/) | 2026-10-26 | 2026-11-04 | high |
| [59] | UETA §14 electronic agents form contracts | [Arizona Legislature](https://www.azleg.gov/ars/44/07014.htm) | current | 2026-11-04 | high |
| [60] | AP2 checkout/payment mandates | [AP2 project](https://ap2-protocol.org/) | 2026 | 2026-11-04 | high |
| [61] | Mastercard Agentic Tokens | [Stellagent (secondary)](https://stellagent.ai/insights/mastercard-agent-pay-ai-agents) | 2025-26 | 2026-11-04 | medium |
| [62] | Skyfire KYAPay tokens with max charge | [Skyfire](https://www.skyfire.xyz/product) | 2025-26 | 2026-11-04 | medium |
| [63] | Trulioo Digital Agent Passport | [Trulioo](https://www.trulioo.com/blog/trust-and-safety/future-agentic-commerce-know-your-agent-kya) | 2025-12 | 2026-11-04 | medium |
| [64] | Cloudflare signed agents (operator identity only) | [Cloudflare](https://blog.cloudflare.com/signed-agents/) | 2025 | 2026-11-04 | medium |
| [65] | Visa/Mastercard/Ant KYA framework announced | [Yahoo Finance](https://finance.yahoo.com/technology/ai/articles/ant-international-visa-mastercard-agree-113452904.html) | 2026-09 | 2026-11-04 | medium |
| [66] | Big US banks block outside agents from moving money | [PYMNTS](https://www.pymnts.com/?p=4326961) | 2026-10-19 | 2026-11-04 | high |
| [67] | Catena Labs OCC trust charter filing, $30M A | [The Block](https://www.theblock.co/post/402029/catena-labs-lands-30-million-series-a-files-for-national-trust-bank-charter-to-underpin-agentic-finance) | 2026-05 | 2026-11-04 | high |
| [68] | Meow agentic banking via MCP | [The Next Web](https://thenextweb.com/news/meow-technologies-agentic-banking-ai-agents) | 2026-04 | 2026-11-04 | high |
| [69] | Natural $100M Upper90 facility; Credit for own agents Q4 2026 (page 403 on re-check) | [FinTech Futures](https://www.fintechfutures.com/venture-capital-funding/natural-100m-credit-facility-upper90) | 2026-08-19 | 2026-11-04 | medium |
| [70] | Vaaya: credit against tokenized stocks for agents | [Hacker News](https://news.ycombinator.com/item?id=49688089) | 2026-09-13 | 2026-11-04 | high |
| [71] | Credex Protocol agent USDC lending | [ETHGlobal](https://ethglobal.com/showcase/credex-protocol-a2ah6) | 2026 | 2026-11-04 | high |
| [72] | RSoft Agentic Bank: 1st place (badge), Agentic Commerce on Arc | [lablab.ai](https://lablab.ai/ai-hackathons/agentic-commerce-on-arc/rsoft-latam/rsoft-agentic-bank) | 2026-01 | 2026-11-04 | medium |
| [73] | RSoft ClawBank: 1st place, OpenClaw hackathon | [lablab.ai](https://lablab.ai/ai-hackathons/openclaw-surge-hackathon/rsoft-latam/rsoft-clawbank) | 2026-02-28 | 2026-11-04 | high |
| [74] | Project Vend phase 2 | [Anthropic](https://www.anthropic.com/news/project-vend-2) | 2025-12-18 | 2026-11-04 | high |
| [75] | Zero-human company revenue unverified | [Contrary Research](https://research.contrary.com/report/are-zero-human-companies-real) | 2026-03-14 | 2026-11-04 | medium |
| [76] | Owner lent agent $155; $0 earned in 48 days | [Reddit r/AI_Agents](https://www.reddit.com/r/AI_Agents/comments/1vvpu4j/) | 2026-08-23 | 2026-11-04 | high |
| [77] | Grok-linked wallet drained via prompt injection | [OECD AI Incidents](https://oecd.ai/en/incidents/2026-05-04-4a73) | 2026-05 | 2026-11-04 | medium |
| [78] | Orders v2 payee/capture spec | [PayPal OpenAPI specs](https://github.com/paypal/paypal-rest-api-specifications/blob/main/openapi/checkout_orders_v2.json) | 2026 | 2026-11-04 | high |
| [79] | Payouts: async statuses, sandbox setup, live activation | [PayPal Developer](https://developer.paypal.com/docs/payouts/standard/integrate-api/) | n.d. | 2026-11-04 | high |
| [80] | Webhook event names (PAYOUTS-ITEM.SUCCEEDED, INVOICE.PAID) | [PayPal Developer](https://developer.paypal.com/api/rest/webhooks/event-names.md) | 2026-09-10 | 2026-11-04 | high |
| [81] | Agent Toolkit tool list (no payouts/vault) | [GitHub paypal/agent-toolkit](https://github.com/paypal/agent-toolkit/blob/main/typescript/src/shared/tools.ts) | 2026-09-01 | 2026-11-04 | high |
| [82] | Vault v3 PayPal payment tokens; billing agreement approval | [PayPal Developer](https://developer.paypal.com/docs/checkout/save-payment-methods/purchase-later/payment-tokens-api/paypal/) | 2026-10-14 | 2026-11-04 | high |
| [83] | NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE: contact support | [PayPal Developer](https://developer.paypal.com/api/payment-tokens/v3/errors/not_enabled_to_vault_payment_source) | n.d. | 2026-11-04 | high |
| [84] | Pay another account (payee routing) | [PayPal Developer](https://developer.paypal.com/docs/checkout/standard/customize/pay-another-account/) | 2026-10-14 | 2026-11-04 | high |
| [85] | platform_fees partner-only live; sandbox standard account | [PayPal Developer](https://developer.paypal.com/docs/multiparty/) | 2026-10-14 | 2026-11-04 | high |
| [86] | Invoicing v2 has no payee/split field | [PayPal OpenAPI specs](https://github.com/paypal/paypal-rest-api-specifications/blob/main/openapi/invoicing_v2.json) | 2026 | 2026-11-04 | medium |
| [87] | Multiparty Invoicing: merchant receives; select partners only | [PayPal Developer](https://developer.paypal.com/docs/multiparty/invoicing/integrate) | n.d. | 2026-11-04 | high |
| [88] | Partner Referrals features incl. ADVANCED_TRANSACTIONS_SEARCH | [PayPal OpenAPI specs](https://github.com/paypal/paypal-rest-api-specifications/blob/main/openapi/customer_partner_referrals_v2.json) | 2026 | 2026-11-04 | high |
| [89] | Developer guidelines: no AUP-violating holding service, no aggregation from unverifiable sources, pay seller directly | [PayPal Developer](https://developer.paypal.com/api/rest/reference/policies-and-guidelines) | 2026-08-17 | 2026-11-04 | high |
| [90] | AUP: credit transactions prohibited; MSB/escrow pre-approval (snippet) | [PayPal (snippet; 403)](https://www.paypal.com/us/legalhub/paypal/acceptableuse-full) | n.d. | 2026-11-04 | low |
| [91] | Payouts Agreement use cases (snippet) | [PayPal (snippet; 403)](https://www.paypal.com/legalhub/paypal-payouts-agreement) | n.d. | 2026-11-04 | low |
| [92] | Receivables lending 70-80% advance; factoring and notification definitions | [OCC Comptroller's Handbook](https://www.occ.gov/publications-and-resources/publications/comptrollers-handbook/files/accts-rec-inventory-financing/pub-ch-accts-rec-inventory-financing.pdf) | 2000-03 | 2026-11-04 | high |
| [93] | ALCO duties; repricing risk; earnings vs economic value | [OCC Comptroller's Handbook](https://www.occ.treas.gov/publications-and-resources/publications/comptrollers-handbook/files/interest-rate-risk/pub-ch-interest-rate-risk.pdf) | 2020-03 | 2026-11-04 | high |
| [94] | Liquidity risk definition and CFP | [FDIC RMS Manual 6.1](https://www.fdic.gov/resources/supervision-and-examinations/examination-policies-manual/section6-1.pdf) | 2025-10 | 2026-11-04 | high |
| [95] | Industry guidance favours pre-funded capped agent budgets | [Moss](https://www.getmoss.com/en-gb/finance-guide/ai-agent-spending-controls) | 2026-08-27 | 2026-11-04 | medium |
| [96] | Priors: unsecured agent credit lines (crypto) | [mcpservers.org](https://mcpservers.org/servers/priors-agents/priors) | 2026 | 2026-11-04 | medium |
| [97] | Pagga agent credit marketplace | [ETHGlobal](https://ethglobal.com/showcase/pagga-b0szs) | 2026 | 2026-11-04 | medium |
| [98] | DFPI $4M penalty for unlicensed lending | [Sheppard Mullin](https://www.sheppard.com/insights/blogs/dfpi-orders-4-million-penalty-for-alleged-unlicensed-lending-violations) | n.d. | 2026-11-04 | medium |
| [99] | Reference Transactions are limited-release | [PayPal Developer](https://developer.paypal.com/limited-release/reference-transactions.md) | n.d. | 2026-11-04 | high |
| [100] | Live Payouts requires contacting PayPal to activate | [PayPal Developer](https://developer.paypal.com/payouts/use-payouts/set-up.md) | n.d. | 2026-11-04 | high |

## Staleness map

Re-check dates come from `recon_kit.py staleness`. Windows: regulatory/availability/policy 3 months (the domain pack requires verifying regulatory status on every use), competitors 6 months, sentiment 18 months.

| Claim | Class | Published | Re-check by |
|---|---|---|---|
| SBA SBSS sunset [51] | regulation | 2026-01-16 | **2026-04-16 — STALE** (May 2026 revision unread) |
| Section 1071 excludes loans under $1k [38] | regulation | 2026-05-07 | **2026-08-07 — STALE** (re-verify) |
| RSoft agent-bank hackathon wins [72] | competitor | 2026-01-28 | **2026-07-28 — STALE as a landscape claim** (the wins are historical fact; re-scan for newer entrants) |
| PayPal developer guidelines [89] | policy | 2026-08-17 | 2026-11-17 |
| NIM 3.32% [1] | figure | 2026-08-25 | 2026-11-25 (Q3 QBP due) |
| CA AB 2116 [36] | regulation | 2026-10-20 | 2027-01-20 |
| Orders payee routing [84] | availability | 2026-10-14 | 2027-01-14 |
| Payouts sandbox behaviour [79] | availability | 2026-11-04 | 2027-02-04 |
| Vault merchant-initiated charges gated [83] | availability | 2026-11-04 | 2027-02-04 |
| Natural Credit, Q4 2026 [69] | competitor | 2026-08-19 | 2027-02-19 (watch for its launch) |
| Agent-credit demand anecdote [76] | sentiment | 2026-08-23 | 2028-02-23 |

The earliest re-check is already past (SBA, Section 1071). Neither changes the recommendation, because SBA 7(a) and 1071 don't govern the $10–$500 model.


