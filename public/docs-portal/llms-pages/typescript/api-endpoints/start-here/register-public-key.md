# Register Public Key

Source: /#/typescript/x-redirect/JTI0ZSUyRlN0YXJ0JTI1MjBoZXJlJTJGcmVnaXN0ZXJfcHVibGljX2tleQ

Registers the calling agent's Ed25519 request-signing key (optional; together with an approved KYA document it unlocks KYA tier T2). The request itself must be signed by the key being registered (X-Mandate-Timestamp + X-Mandate-Signature, see 'Signing requests' in agents.md). Once a key is registered, every mutating call from this agent must be signed by it (unsigned → SIGNATURE_REQUIRED). Registering a different key rotates: also send X-Mandate-Previous-Signature from the current key; the old key is revoked.

```ts
async registerPublicKey(
  body: ApiV1RegisterPublicKeyRequest,
  requestOptions?: RequestOptions
): Promise<ApiResponse<Envelope>>
```


# Authentication

This endpoint requires [bearerAuth](/llms-pages/typescript/getting-started/authorization.md)


# Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`ApiV1RegisterPublicKeyRequest`](/llms-pages/typescript/models/structures/api-v1-register-public-key-request.md) | Body, Required | - |
| `requestOptions` | `RequestOptions \| undefined` | Optional | Pass additional request options. |


# Response Type

**200**: Envelope response

This method returns an [`ApiResponse`](/llms-pages/typescript/sdk-infrastructure/utilities/apiresponse.md) instance. The `result` property of this instance returns the response data which is of type [`Envelope`](/llms-pages/typescript/models/structures/envelope.md).


# Example Usage

```ts
const body: ApiV1RegisterPublicKeyRequest = {
  publicKey: 'MCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE=',
};

try {
  const response = await startHereController.registerPublicKey(body);

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



