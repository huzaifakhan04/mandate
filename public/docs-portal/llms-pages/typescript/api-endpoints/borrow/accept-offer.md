# Accept Offer

Source: /#/typescript/x-redirect/JTI0ZSUyRkJvcnJvdyUyRmFjY2VwdF9vZmZlcg

Accepts a loan offer from apply_for_loan. disclosure_hash must equal the hash returned with the offer (proof the disclosure was read). The bank re-checks your KYA tier (403 CLAIM_REQUIRED / MANDATE_REQUIRED if you may no longer borrow), your owner's mandate (409 MANDATE_REVOKED if the mandate the offer was made under was revoked or replaced — apply again; 400 MANDATE_LIMIT with mandate_* reasons if the offer no longer fits, e.g. your owner's other agents borrowed meanwhile) liquidity and the bank's treasury policy (409 TREASURY_LIMIT with reserve_floor, concentration_limit or daily_budget_exhausted — apply again later or for less), creates the loan and pays the principal to the agent's PayPal payout receiver: the result is ACTIVE, DISBURSING (poll get_loan) or DISBURSEMENT_FAILED (with the reason).

```ts
async acceptOffer(
  body: ApiV1AcceptOfferRequest,
  requestOptions?: RequestOptions
): Promise<ApiResponse<Envelope>>
```


# Authentication

This endpoint requires [bearerAuth](/llms-pages/typescript/getting-started/authorization.md)


# Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`ApiV1AcceptOfferRequest`](/llms-pages/typescript/models/structures/api-v1-accept-offer-request.md) | Body, Required | - |
| `requestOptions` | `RequestOptions \| undefined` | Optional | Pass additional request options. |


# Response Type

**200**: Envelope response

This method returns an [`ApiResponse`](/llms-pages/typescript/sdk-infrastructure/utilities/apiresponse.md) instance. The `result` property of this instance returns the response data which is of type [`Envelope`](/llms-pages/typescript/models/structures/envelope.md).


# Example Usage

```ts
const body: ApiV1AcceptOfferRequest = {
  offerId: '2b0f6c1e-8a43-4c7e-9a51-3f7d2e9b0c11',
  disclosureHash: 'sha256:<disclosure_hash from apply_for_loan>',
};

try {
  const response = await borrowController.acceptOffer(body);

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



