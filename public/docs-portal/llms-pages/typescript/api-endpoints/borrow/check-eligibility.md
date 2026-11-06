# Check Eligibility

Source: /#/typescript/x-redirect/JTI0ZSUyRkJvcnJvdyUyRmNoZWNrX2VsaWdpYmlsaXR5

Checks, without committing to anything, whether the calling agent could borrow amount_cents for term_days right now (P1: 1000–50000 cents, 7–30 days, one open loan, enough pool liquidity, and KYA tier ≥ 1: claimed by your human and covered by a signed mandate) and quotes the fee, APR and total repayment. data.mandate shows the limits your human signed (max per loan, max total owed across all their agents, max fee in bps of the principal, max term, eligible collateral) and the headroom left; breaking one gives a mandate_* reason, and a loan above your tier's cap (T1 25000, T2 50000 cents) gives tier_per_loan. Pass collateral to also check the collateral rule. data.credit is your Agent Credit Score (0–100), grade A–E, grade limit and top 3 factors; pass invoice_amount_cents to include invoice collateral (coverage ≥ 1.5× scores 20 points, ≥ 1.1× scores 12; below 1.1× gives insufficient_collateral). The same underwriting rules as apply_for_loan run: grade E declines (insufficient_credit_history / score_too_low), effective_cap_cents = min(grade limit, tier cap, mandate max_per_loan), grade D above 5000 cents gives manual_review_declined. The quote is risk-based (grade, score, rate components, apr_flag) and null for grade E. Call it before apply_for_loan; if eligible, call apply_for_loan with the same amount and term. While unclaimed, reasons include claim_required and data.claim_url is the link to give your human.

```ts
async checkEligibility(
  body: ApiV1CheckEligibilityRequest,
  requestOptions?: RequestOptions
): Promise<ApiResponse<Envelope>>
```


# Authentication

This endpoint requires [bearerAuth](/llms-pages/typescript/getting-started/authorization.md)


# Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`ApiV1CheckEligibilityRequest`](/llms-pages/typescript/models/structures/api-v1-check-eligibility-request.md) | Body, Required | - |
| `requestOptions` | `RequestOptions \| undefined` | Optional | Pass additional request options. |


# Response Type

**200**: Envelope response

This method returns an [`ApiResponse`](/llms-pages/typescript/sdk-infrastructure/utilities/apiresponse.md) instance. The `result` property of this instance returns the response data which is of type [`Envelope`](/llms-pages/typescript/models/structures/envelope.md).


# Example Usage

```ts
const body: ApiV1CheckEligibilityRequest = {
  amountCents: 1000,
  termDays: 7,
  collateral: CollateralEnum.InvoiceLink,
  invoiceAmountCents: 1500,
};

try {
  const response = await borrowController.checkEligibility(body);

  // Extracting fully parsed response body.
  console.log(response.result);

  // Extracting response status code.
  console.log(response.statusCode);
  // Extracting response headers.
  console.log(response.headers);
  // Extracting response body of type `string | Stream`
  console.log(response.body);
} catch (error) {
  if (error instanceof ApiError) {
    // Extracting response error status code.
    console.log(error.statusCode);
    // Extracting response error headers.
    console.log(error.headers);
    // Extracting response error body of type `string | Stream`.
    console.log(error.body);
  }
}
```



