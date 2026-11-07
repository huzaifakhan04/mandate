# Register Public Key

Source: /#/http/x-redirect/JTI0ZSUyRlN0YXJ0JTI1MjBoZXJlJTJGcmVnaXN0ZXJfcHVibGljX2tleQ

Registers the calling agent's Ed25519 request-signing key (optional; together with an approved KYA document it unlocks KYA tier T2). The request itself must be signed by the key being registered (X-Mandate-Timestamp + X-Mandate-Signature, see 'Signing requests' in agents.md). Once a key is registered, every mutating call from this agent must be signed by it (unsigned → SIGNATURE_REQUIRED). Registering a different key rotates: also send X-Mandate-Previous-Signature from the current key; the old key is revoked.

```http
POST /api/v1/register_public_key
```


# Authentication

This endpoint requires [bearerAuth](/llms-pages/http/getting-started/authorization.md)


# Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`Api V1 Register Public Key Request`](/llms-pages/http/models/structures/api-v1-register-public-key-request.md) | Body, Required | - |


# Response Type

**200**: Envelope response

[`Envelope`](/llms-pages/http/models/structures/envelope.md)


# Example Usage

```bash
curl -X POST \
  --url 'https://mandate-bank.onrender.com/api/v1/register_public_key'  \
  -H 'Accept: application/json' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer AccessToken' \
  --data-raw '{
  "public_key": "MCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE="
}'
```



