# Borrow

```ts
const borrowApi = new BorrowApi(client);
```

## Class Name

`BorrowApi`

## Methods

* [Check Eligibility](../../doc/controllers/borrow.md#check-eligibility)
* [Apply for Loan](../../doc/controllers/borrow.md#apply-for-loan)
* [Accept Offer](../../doc/controllers/borrow.md#accept-offer)
* [Decline Offer](../../doc/controllers/borrow.md#decline-offer)
* [Get Application](../../doc/controllers/borrow.md#get-application)


# Check Eligibility

Checks, without committing to anything, whether the calling agent could borrow amount_cents for term_days right now (P1: 1000–50000 cents, 7–30 days, one open loan, enough pool liquidity, and KYA tier ≥ 1: claimed by your human and covered by a signed mandate) and quotes the fee, APR and total repayment. data.mandate shows the limits your human signed (max per loan, max total owed across all their agents, max fee in bps of the principal, max term, eligible collateral) and the headroom left; breaking one gives a mandate_* reason, and a loan above your tier's cap (T1 25000, T2 50000 cents) gives tier_per_loan. Pass collateral to also check the collateral rule. data.credit is your Agent Credit Score (0–100), grade A–E, grade limit and top 3 factors; pass invoice_amount_cents to include invoice collateral (coverage ≥ 1.5× scores 20 points, ≥ 1.1× scores 12; below 1.1× gives insufficient_collateral). The same underwriting rules as apply_for_loan run: grade E declines (insufficient_credit_history / score_too_low), effective_cap_cents = min(grade limit, tier cap, mandate max_per_loan), grade D above 5000 cents gives manual_review_declined. The quote is risk-based (grade, score, rate components, apr_flag) and null for grade E. Call it before apply_for_loan; if eligible, call apply_for_loan with the same amount and term. While unclaimed, reasons include claim_required and data.claim_url is the link to give your human.

```ts
async checkEligibility(
  body: ApiV1CheckEligibilityRequest,
  requestOptions?: RequestOptions
): Promise<ApiResponse<Envelope>>
```

## Authentication

This endpoint requires [bearerAuth](../../doc/auth/oauth-2-bearer-token.md)

## Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`ApiV1CheckEligibilityRequest`](../../doc/models/api-v1-check-eligibility-request.md) | Body, Required | - |
| `requestOptions` | `RequestOptions \| undefined` | Optional | Pass additional request options. |

## Response Type

**200**: Envelope response

This method returns an [`ApiResponse`](../../doc/api-response.md) instance. The `result` property of this instance returns the response data which is of type [`Envelope`](../../doc/models/envelope.md).

## Example Usage

```ts
const body: ApiV1CheckEligibilityRequest = {
  amountCents: 1000,
  termDays: 7,
  collateral: Collateral.InvoiceLink,
  invoiceAmountCents: 1500,
};

try {
  const response = await borrowApi.checkEligibility(body);

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


# Apply for Loan

Applies for a loan of amount_cents over term_days (optionally backed by an invoice the bank will collect via a payment link; invoice.amount_cents must cover the principal plus the fee, i.e. at least amount_cents + the fee check_eligibility quotes). Returns either DECLINED with reason codes, or OFFERED with a disclosure and its disclosure_hash, valid for one simulated day. Review the disclosure, then call accept_offer with offer_id and disclosure_hash, or decline_offer. Needs KYA tier ≥ 1: an unclaimed agent gets 403 CLAIM_REQUIRED (data.claim_url is the link for your human), a claimed agent without a signed mandate gets 403 MANDATE_REQUIRED. An offer that breaks your owner's mandate is DECLINED with mandate_per_loan / mandate_total_owed / mandate_fee / mandate_term / mandate_collateral, or tier_per_loan above your tier's cap. Applications are underwritten by your Agent Credit Score: grade E declines (insufficient_credit_history / score_too_low), above your grade's limit gives amount_exceeds_limit, grade D above 5000 cents gives manual_review_declined, an invoice covering < 1.1× the amount gives insufficient_collateral (new agents: start with a small invoice-backed loan, invoice ≥ 1.5× the amount). The fee is risk-based; the disclosure shows your score, grade and the rate components, and names the mandate_id and mandate_version it was made under. The application has sections A–H: identity {operator, model, code_manifest_hash} (optional), purpose, amount_cents/term_days, invoice (optional), declarations.no_other_debt (REQUIRED true), consent_bank_records (optional), mandate_version (optional: the mandate version you expect — 409 MANDATE_CHANGED if it is no longer current) and attest (REQUIRED true: the application is accurate). Without declarations.no_other_debt and attest it is DECLINED with declaration_missing. A DECLINED response carries adverse_action {reasons [{code, text}], score, grade, score_factors, notice, explanation}; every response carries an explanation. Re-read either later with get_application.

```ts
async applyForLoan(
  body: ApiV1ApplyForLoanRequest,
  requestOptions?: RequestOptions
): Promise<ApiResponse<Envelope>>
```

## Authentication

This endpoint requires [bearerAuth](../../doc/auth/oauth-2-bearer-token.md)

## Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`ApiV1ApplyForLoanRequest`](../../doc/models/api-v1-apply-for-loan-request.md) | Body, Required | - |
| `requestOptions` | `RequestOptions \| undefined` | Optional | Pass additional request options. |

## Response Type

**200**: Envelope response

This method returns an [`ApiResponse`](../../doc/api-response.md) instance. The `result` property of this instance returns the response data which is of type [`Envelope`](../../doc/models/envelope.md).

## Example Usage

```ts
const body: ApiV1ApplyForLoanRequest = {
  amountCents: 1000,
  termDays: 7,
  purpose: 'Buy materials for invoice INV-1042',
  identity: {
    operator: 'Acme Ops',
    model: 'claude-sonnet',
  },
  invoice: {
    clientEmail: 'client@example.com',
    amountCents: 1500,
    dueInDays: 7,
    description: 'INV-1042: website build',
  },
  declarations: {
    noOtherDebt: true,
  },
  consentBankRecords: true,
  attest: true,
};

try {
  const response = await borrowApi.applyForLoan(body);

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


# Accept Offer

Accepts a loan offer from apply_for_loan. disclosure_hash must equal the hash returned with the offer (proof the disclosure was read). The bank re-checks your KYA tier (403 CLAIM_REQUIRED / MANDATE_REQUIRED if you may no longer borrow), your owner's mandate (409 MANDATE_REVOKED if the mandate the offer was made under was revoked or replaced — apply again; 400 MANDATE_LIMIT with mandate_* reasons if the offer no longer fits, e.g. your owner's other agents borrowed meanwhile) liquidity and the bank's treasury policy (409 TREASURY_LIMIT with reserve_floor, concentration_limit or daily_budget_exhausted — apply again later or for less), creates the loan and pays the principal to the agent's PayPal payout receiver: the result is ACTIVE, DISBURSING (poll get_loan) or DISBURSEMENT_FAILED (with the reason).

```ts
async acceptOffer(
  body: ApiV1AcceptOfferRequest,
  requestOptions?: RequestOptions
): Promise<ApiResponse<Envelope>>
```

## Authentication

This endpoint requires [bearerAuth](../../doc/auth/oauth-2-bearer-token.md)

## Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`ApiV1AcceptOfferRequest`](../../doc/models/api-v1-accept-offer-request.md) | Body, Required | - |
| `requestOptions` | `RequestOptions \| undefined` | Optional | Pass additional request options. |

## Response Type

**200**: Envelope response

This method returns an [`ApiResponse`](../../doc/api-response.md) instance. The `result` property of this instance returns the response data which is of type [`Envelope`](../../doc/models/envelope.md).

## Example Usage

```ts
const body: ApiV1AcceptOfferRequest = {
  offerId: '2b0f6c1e-8a43-4c7e-9a51-3f7d2e9b0c11',
  disclosureHash: 'sha256:<disclosure_hash from apply_for_loan>',
};

try {
  const response = await borrowApi.acceptOffer(body);

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


# Decline Offer

Declines one of the calling agent's open loan offers (from apply_for_loan), so it can no longer be accepted. Nothing is charged. Call apply_for_loan again later for a new offer, or get_status to see the agent's current position.

```ts
async declineOffer(
  body: ApiV1DeclineOfferRequest,
  requestOptions?: RequestOptions
): Promise<ApiResponse<Envelope>>
```

## Authentication

This endpoint requires [bearerAuth](../../doc/auth/oauth-2-bearer-token.md)

## Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`ApiV1DeclineOfferRequest`](../../doc/models/api-v1-decline-offer-request.md) | Body, Required | - |
| `requestOptions` | `RequestOptions \| undefined` | Optional | Pass additional request options. |

## Response Type

**200**: Envelope response

This method returns an [`ApiResponse`](../../doc/api-response.md) instance. The `result` property of this instance returns the response data which is of type [`Envelope`](../../doc/models/envelope.md).

## Example Usage

```ts
const body: ApiV1DeclineOfferRequest = {
  offerId: '2b0f6c1e-8a43-4c7e-9a51-3f7d2e9b0c11',
};

try {
  const response = await borrowApi.declineOffer(body);

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


# Get Application

Returns one of the calling agent's loan applications: its status — OFFERED (the bank made an offer; the application stays OFFERED after the offer is accepted, declined or expires, so use get_loan / get_status for what happened next) or DECLINED (see adverse_action) — the decision, the principal reasons [{code, text}], the adverse_action notice of a decline (your statement of specific reasons), the latest explanation (the loan officer's text, or its template when the AI was unavailable), the offer_id of an offered application, and an echo of the application sections A–H (ala) as submitted. Read-only.

```ts
async getApplication(
  body: ApiV1GetApplicationRequest,
  requestOptions?: RequestOptions
): Promise<ApiResponse<Envelope>>
```

## Authentication

This endpoint requires [bearerAuth](../../doc/auth/oauth-2-bearer-token.md)

## Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`ApiV1GetApplicationRequest`](../../doc/models/api-v1-get-application-request.md) | Body, Required | - |
| `requestOptions` | `RequestOptions \| undefined` | Optional | Pass additional request options. |

## Response Type

**200**: Envelope response

This method returns an [`ApiResponse`](../../doc/api-response.md) instance. The `result` property of this instance returns the response data which is of type [`Envelope`](../../doc/models/envelope.md).

## Example Usage

```ts
const body: ApiV1GetApplicationRequest = {
  applicationId: '7d3a9e52-1f6b-4b28-8c0d-5e4f1a2b3c22',
};

try {
  const response = await borrowApi.getApplication(body);

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

