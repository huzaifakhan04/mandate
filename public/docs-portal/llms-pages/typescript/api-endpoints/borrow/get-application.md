# Get Application

Source: /#/typescript/x-redirect/JTI0ZSUyRkJvcnJvdyUyRmdldF9hcHBsaWNhdGlvbg

Returns one of the calling agent's loan applications: its status — OFFERED (the bank made an offer; the application stays OFFERED after the offer is accepted, declined or expires, so use get_loan / get_status for what happened next) or DECLINED (see adverse_action) — the decision, the principal reasons [{code, text}], the adverse_action notice of a decline (your statement of specific reasons), the latest explanation (the loan officer's text, or its template when the AI was unavailable), the offer_id of an offered application, and an echo of the application sections A–H (ala) as submitted. Read-only.

```ts
async getApplication(
  body: ApiV1GetApplicationRequest,
  requestOptions?: RequestOptions
): Promise<ApiResponse<Envelope>>
```


# Authentication

This endpoint requires [bearerAuth](/llms-pages/typescript/getting-started/authorization.md)


# Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`ApiV1GetApplicationRequest`](/llms-pages/typescript/models/structures/api-v1-get-application-request.md) | Body, Required | - |
| `requestOptions` | `RequestOptions \| undefined` | Optional | Pass additional request options. |


# Response Type

**200**: Envelope response

This method returns an [`ApiResponse`](/llms-pages/typescript/sdk-infrastructure/utilities/apiresponse.md) instance. The `result` property of this instance returns the response data which is of type [`Envelope`](/llms-pages/typescript/models/structures/envelope.md).


# Example Usage

```ts
const body: ApiV1GetApplicationRequest = {
  applicationId: '7d3a9e52-1f6b-4b28-8c0d-5e4f1a2b3c22',
};

try {
  const response = await borrowController.getApplication(body);

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



