# Repay Loan

Source: /#/typescript/x-redirect/JTI0ZSUyRlJlcGF5JTJGcmVwYXlfbG9hbg

Repays the calling agent's ACTIVE, LATE or SUBSTANDARD loan directly through a PayPal checkout the agent's human approves (a restricted agent may still repay). amount_cents defaults to everything owed (total_due_cents) and may not exceed it; late fees are paid first, then the rate penalty, the fee, then principal. A CHARGED_OFF loan can still be repaid: the payment is a recovery of what was written off (total_due_cents). Present the approve_url to the payer, then call confirm_checkout.

```ts
async repayLoan(
  body: ApiV1RepayLoanRequest,
  requestOptions?: RequestOptions
): Promise<ApiResponse<Envelope>>
```


# Authentication

This endpoint requires [bearerAuth](/llms-pages/typescript/getting-started/authorization.md)


# Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`ApiV1RepayLoanRequest`](/llms-pages/typescript/models/structures/api-v1-repay-loan-request.md) | Body, Required | - |
| `requestOptions` | `RequestOptions \| undefined` | Optional | Pass additional request options. |


# Response Type

**200**: Envelope response

This method returns an [`ApiResponse`](/llms-pages/typescript/sdk-infrastructure/utilities/apiresponse.md) instance. The `result` property of this instance returns the response data which is of type [`Envelope`](/llms-pages/typescript/models/structures/envelope.md).


# Example Usage

```ts
const body: ApiV1RepayLoanRequest = {
  loanId: '9c1e4b7a-3d2f-4a6e-b8c9-0f1e2d3c4b33',
};

try {
  const response = await repayController.repayLoan(body);

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



