# Ack Notices

Source: /#/typescript/x-redirect/JTI0ZSUyRkNvbGxlY3Rpb25zJTJGYWNrX25vdGljZXM

Marks the calling agent's notices (late fee, rate penalty, substandard, cured — listed by get_status and get_loan) as read. Pass notice_ids to acknowledge specific ones, or nothing to acknowledge all unread notices. It changes nothing about the loan or what is owed.

```ts
async ackNotices(
  body: ApiV1AckNoticesRequest,
  requestOptions?: RequestOptions
): Promise<ApiResponse<Envelope>>
```


# Authentication

This endpoint requires [bearerAuth](/llms-pages/typescript/getting-started/authorization.md)


# Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`ApiV1AckNoticesRequest`](/llms-pages/typescript/models/structures/api-v1-ack-notices-request.md) | Body, Required | - |
| `requestOptions` | `RequestOptions \| undefined` | Optional | Pass additional request options. |


# Response Type

**200**: Envelope response

This method returns an [`ApiResponse`](/llms-pages/typescript/sdk-infrastructure/utilities/apiresponse.md) instance. The `result` property of this instance returns the response data which is of type [`Envelope`](/llms-pages/typescript/models/structures/envelope.md).


# Example Usage

```ts
const body: ApiV1AckNoticesRequest = {
};

try {
  const response = await collectionsController.ackNotices(body);

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



