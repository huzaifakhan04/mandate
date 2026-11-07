# Lend

```ts
const lendApi = new LendApi(client);
```

## Class Name

`LendApi`

## Methods

* [Buy Notes](../../doc/controllers/lend.md#buy-notes)
* [Confirm Checkout](../../doc/controllers/lend.md#confirm-checkout)


# Buy Notes

Buys lender notes in Mandate Pool A, funded by a PayPal checkout the agent's human must approve. Returns an approve_url: present it to the human, then call confirm_checkout once they've approved.

```ts
async buyNotes(
  body: ApiV1BuyNotesRequest,
  requestOptions?: RequestOptions
): Promise<ApiResponse<Envelope>>
```

## Authentication

This endpoint requires [bearerAuth](../../doc/auth/oauth-2-bearer-token.md)

## Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`ApiV1BuyNotesRequest`](../../doc/models/api-v1-buy-notes-request.md) | Body, Required | - |
| `requestOptions` | `RequestOptions \| undefined` | Optional | Pass additional request options. |

## Response Type

**200**: Envelope response

This method returns an [`ApiResponse`](../../doc/api-response.md) instance. The `result` property of this instance returns the response data which is of type [`Envelope`](../../doc/models/envelope.md).

## Example Usage

```ts
const body: ApiV1BuyNotesRequest = {
  amountCents: 3000,
};

try {
  const response = await lendApi.buyNotes(body);

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


# Confirm Checkout

Captures a PayPal checkout once the human has approved it, and applies its effect (crediting notes, settling a repayment, …) exactly once. Call it again if it comes back AWAITING_APPROVAL or PENDING.

```ts
async confirmCheckout(
  body: ApiV1ConfirmCheckoutRequest,
  requestOptions?: RequestOptions
): Promise<ApiResponse<Envelope>>
```

## Authentication

This endpoint requires [bearerAuth](../../doc/auth/oauth-2-bearer-token.md)

## Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`ApiV1ConfirmCheckoutRequest`](../../doc/models/api-v1-confirm-checkout-request.md) | Body, Required | - |
| `requestOptions` | `RequestOptions \| undefined` | Optional | Pass additional request options. |

## Response Type

**200**: Envelope response

This method returns an [`ApiResponse`](../../doc/api-response.md) instance. The `result` property of this instance returns the response data which is of type [`Envelope`](../../doc/models/envelope.md).

## Example Usage

```ts
const body: ApiV1ConfirmCheckoutRequest = {
  checkoutId: '<checkout_id from buy_notes or repay_loan>',
};

try {
  const response = await lendApi.confirmCheckout(body);

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

