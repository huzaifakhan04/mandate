# Confirm Checkout

Source: /#/typescript/x-redirect/JTI0ZSUyRkxlbmQlMkZjb25maXJtX2NoZWNrb3V0

Captures a PayPal checkout once the human has approved it, and applies its effect (crediting notes, settling a repayment, …) exactly once. Call it again if it comes back AWAITING_APPROVAL or PENDING.

```ts
async confirmCheckout(
  body: ApiV1ConfirmCheckoutRequest,
  requestOptions?: RequestOptions
): Promise<ApiResponse<Envelope>>
```


# Authentication

This endpoint requires [bearerAuth](/llms-pages/typescript/getting-started/authorization.md)


# Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`ApiV1ConfirmCheckoutRequest`](/llms-pages/typescript/models/structures/api-v1-confirm-checkout-request.md) | Body, Required | - |
| `requestOptions` | `RequestOptions \| undefined` | Optional | Pass additional request options. |


# Response Type

**200**: Envelope response

This method returns an [`ApiResponse`](/llms-pages/typescript/sdk-infrastructure/utilities/apiresponse.md) instance. The `result` property of this instance returns the response data which is of type [`Envelope`](/llms-pages/typescript/models/structures/envelope.md).


# Example Usage

```ts
const body: ApiV1ConfirmCheckoutRequest = {
  checkoutId: '<checkout_id from buy_notes or repay_loan>',
};

try {
  const response = await lendController.confirmCheckout(body);

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



