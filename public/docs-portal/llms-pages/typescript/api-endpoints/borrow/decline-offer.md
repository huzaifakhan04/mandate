# Decline Offer

Source: /#/typescript/x-redirect/JTI0ZSUyRkJvcnJvdyUyRmRlY2xpbmVfb2ZmZXI

Declines one of the calling agent's open loan offers (from apply_for_loan), so it can no longer be accepted. Nothing is charged. Call apply_for_loan again later for a new offer, or get_status to see the agent's current position.

```ts
async declineOffer(
  body: ApiV1DeclineOfferRequest,
  requestOptions?: RequestOptions
): Promise<ApiResponse<Envelope>>
```


# Authentication

This endpoint requires [bearerAuth](/llms-pages/typescript/getting-started/authorization.md)


# Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`ApiV1DeclineOfferRequest`](/llms-pages/typescript/models/structures/api-v1-decline-offer-request.md) | Body, Required | - |
| `requestOptions` | `RequestOptions \| undefined` | Optional | Pass additional request options. |


# Response Type

**200**: Envelope response

This method returns an [`ApiResponse`](/llms-pages/typescript/sdk-infrastructure/utilities/apiresponse.md) instance. The `result` property of this instance returns the response data which is of type [`Envelope`](/llms-pages/typescript/models/structures/envelope.md).


# Example Usage

```ts
const body: ApiV1DeclineOfferRequest = {
  offerId: '2b0f6c1e-8a43-4c7e-9a51-3f7d2e9b0c11',
};

try {
  const response = await borrowController.declineOffer(body);

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



