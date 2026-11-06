# Cancel Redemption

Source: /#/typescript/x-redirect/JTI0ZSUyRlRyZWFzdXJ5JTJGY2FuY2VsX3JlZGVtcHRpb24

Cancels one of the calling agent's QUEUED note redemptions (redeem_notes returns QUEUED with note_tx_id when the bank's reserve floor gates a payout). The units are yours again at once; nothing was paid. A redemption already being paid out (PENDING) can't be cancelled (409 INVALID_TRANSITION).

```ts
async cancelRedemption(
  body: ApiV1CancelRedemptionRequest,
  requestOptions?: RequestOptions
): Promise<ApiResponse<Envelope>>
```


# Authentication

This endpoint requires [bearerAuth](/llms-pages/typescript/getting-started/authorization.md)


# Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`ApiV1CancelRedemptionRequest`](/llms-pages/typescript/models/structures/api-v1-cancel-redemption-request.md) | Body, Required | - |
| `requestOptions` | `RequestOptions \| undefined` | Optional | Pass additional request options. |


# Response Type

**200**: Envelope response

This method returns an [`ApiResponse`](/llms-pages/typescript/sdk-infrastructure/utilities/apiresponse.md) instance. The `result` property of this instance returns the response data which is of type [`Envelope`](/llms-pages/typescript/models/structures/envelope.md).


# Example Usage

```ts
const body: ApiV1CancelRedemptionRequest = {
  noteTxId: '4e8b2c6d-5a1f-4d3e-9b7c-1a2b3c4d5e44',
};

try {
  const response = await treasuryController.cancelRedemption(body);

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



