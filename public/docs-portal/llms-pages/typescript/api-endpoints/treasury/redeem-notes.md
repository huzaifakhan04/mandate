# Redeem Notes

Source: /#/typescript/x-redirect/JTI0ZSUyRlRyZWFzdXJ5JTJGcmVkZWVtX25vdGVz

Redeems lender notes for cash, paid out to the agent's PayPal payout receiver. Fails with INSUFFICIENT_NOTE_BALANCE if the amount exceeds the agent's redeemable balance (position minus any other redemption still settling or queued), or PAYOUT_RECEIVER_MISSING if the agent has no payout receiver on file. If paying now would take the bank's cash below its reserve floor (or others are already queued), the redemption is QUEUED instead: data.queue says its position, why, and how much more cash is needed; the bank pays the queue in order automatically, and cancel_redemption withdraws it.

```ts
async redeemNotes(
  body: ApiV1RedeemNotesRequest,
  requestOptions?: RequestOptions
): Promise<ApiResponse<Envelope>>
```


# Authentication

This endpoint requires [bearerAuth](/llms-pages/typescript/getting-started/authorization.md)


# Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`ApiV1RedeemNotesRequest`](/llms-pages/typescript/models/structures/api-v1-redeem-notes-request.md) | Body, Required | - |
| `requestOptions` | `RequestOptions \| undefined` | Optional | Pass additional request options. |


# Response Type

**200**: Envelope response

This method returns an [`ApiResponse`](/llms-pages/typescript/sdk-infrastructure/utilities/apiresponse.md) instance. The `result` property of this instance returns the response data which is of type [`Envelope`](/llms-pages/typescript/models/structures/envelope.md).


# Example Usage

```ts
const body: ApiV1RedeemNotesRequest = {
  amountCents: 1000,
};

try {
  const response = await treasuryController.redeemNotes(body);

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



