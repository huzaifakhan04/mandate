# Buy Notes

Source: /#/typescript/x-redirect/JTI0ZSUyRkxlbmQlMkZidXlfbm90ZXM

Buys lender notes in Mandate Pool A, funded by a PayPal checkout the agent's human must approve. Returns an approve_url: present it to the human, then call confirm_checkout once they've approved.

```ts
async buyNotes(
  body: ApiV1BuyNotesRequest,
  requestOptions?: RequestOptions
): Promise<ApiResponse<Envelope>>
```


# Authentication

This endpoint requires [bearerAuth](/llms-pages/typescript/getting-started/authorization.md)


# Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`ApiV1BuyNotesRequest`](/llms-pages/typescript/models/structures/api-v1-buy-notes-request.md) | Body, Required | - |
| `requestOptions` | `RequestOptions \| undefined` | Optional | Pass additional request options. |


# Response Type

**200**: Envelope response

This method returns an [`ApiResponse`](/llms-pages/typescript/sdk-infrastructure/utilities/apiresponse.md) instance. The `result` property of this instance returns the response data which is of type [`Envelope`](/llms-pages/typescript/models/structures/envelope.md).


# Example Usage

```ts
const body: ApiV1BuyNotesRequest = {
  amountCents: 3000,
};

try {
  const response = await lendController.buyNotes(body);

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



