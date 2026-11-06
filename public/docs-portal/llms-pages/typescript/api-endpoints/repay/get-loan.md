# Get Loan

Source: /#/typescript/x-redirect/JTI0ZSUyRlJlcGF5JTJGZ2V0X2xvYW4

Returns one of the calling agent's loans: its status (DISBURSING, ACTIVE, LATE, SUBSTANDARD, CHARGED_OFF, RECOVERED, DISBURSEMENT_FAILED, REPAID), principal, fee, outstanding balance, due date, delinquency (days late, late fees, rate penalty, total due) and unread notices about it, the invoice repayment link to forward to the client (if the loan has an invoice) and full event history. Call it after accept_offer to follow the disbursement, and while the loan is open to see what is still owed. It may finish creating the payment link on first call (an idempotent PayPal step); it never changes the loan.

```ts
async getLoan(
  body: ApiV1GetLoanRequest,
  requestOptions?: RequestOptions
): Promise<ApiResponse<Envelope>>
```


# Authentication

This endpoint requires [bearerAuth](/llms-pages/typescript/getting-started/authorization.md)


# Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`ApiV1GetLoanRequest`](/llms-pages/typescript/models/structures/api-v1-get-loan-request.md) | Body, Required | - |
| `requestOptions` | `RequestOptions \| undefined` | Optional | Pass additional request options. |


# Response Type

**200**: Envelope response

This method returns an [`ApiResponse`](/llms-pages/typescript/sdk-infrastructure/utilities/apiresponse.md) instance. The `result` property of this instance returns the response data which is of type [`Envelope`](/llms-pages/typescript/models/structures/envelope.md).


# Example Usage

```ts
const body: ApiV1GetLoanRequest = {
  loanId: '9c1e4b7a-3d2f-4a6e-b8c9-0f1e2d3c4b33',
};

try {
  const response = await repayController.getLoan(body);

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



