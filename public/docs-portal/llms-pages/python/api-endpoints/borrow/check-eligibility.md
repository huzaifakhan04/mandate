# Check Eligibility

Source: /#/python/x-redirect/JTI0ZSUyRkJvcnJvdyUyRmNoZWNrX2VsaWdpYmlsaXR5

Checks, without committing to anything, whether the calling agent could borrow amount_cents for term_days right now (P1: 1000–50000 cents, 7–30 days, one open loan, enough pool liquidity, and KYA tier ≥ 1: claimed by your human and covered by a signed mandate) and quotes the fee, APR and total repayment. data.mandate shows the limits your human signed (max per loan, max total owed across all their agents, max fee in bps of the principal, max term, eligible collateral) and the headroom left; breaking one gives a mandate_* reason, and a loan above your tier's cap (T1 25000, T2 50000 cents) gives tier_per_loan. Pass collateral to also check the collateral rule. data.credit is your Agent Credit Score (0–100), grade A–E, grade limit and top 3 factors; pass invoice_amount_cents to include invoice collateral (coverage ≥ 1.5× scores 20 points, ≥ 1.1× scores 12; below 1.1× gives insufficient_collateral). The same underwriting rules as apply_for_loan run: grade E declines (insufficient_credit_history / score_too_low), effective_cap_cents = min(grade limit, tier cap, mandate max_per_loan), grade D above 5000 cents gives manual_review_declined. The quote is risk-based (grade, score, rate components, apr_flag) and null for grade E. Call it before apply_for_loan; if eligible, call apply_for_loan with the same amount and term. While unclaimed, reasons include claim_required and data.claim_url is the link to give your human.

```python
def check_eligibility(self,
                     body)
```


# Authentication

This endpoint requires [bearerAuth](/llms-pages/python/getting-started/authorization.md)


# Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`ApiV1CheckEligibilityRequest`](/llms-pages/python/models/structures/api-v1-check-eligibility-request.md) | Body, Required | - |


# Response Type

**200**: Envelope response

[`Envelope`](/llms-pages/python/models/structures/envelope.md)


# Example Usage

```python
body = ApiV1CheckEligibilityRequest(
    amount_cents=1000,
    term_days=7,
    collateral=CollateralEnum.INVOICE_LINK,
    invoice_amount_cents=1500
)

result = borrow_controller.check_eligibility(body)
print(result)
```



