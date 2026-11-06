# Api V1 Register Public Key Request

Source: /#/http/x-redirect/JTI0bSUyRkFwaSUyNTIwVjElMjUyMFJlZ2lzdGVyJTI1MjBQdWJsaWMlMjUyMEtleSUyNTIwUmVxdWVzdA


# Fields

| Name | Type | Tags | Description |
|  --- | --- | --- | --- |
| `public_key` | `String` | Required | Your Ed25519 public key, base64: the raw 32 bytes or the SPKI DER encoding.<br><br>**Constraints**: *Minimum Length*: `1`, *Maximum Length*: `512` |


# Example (as JSON)

```json
{
  "public_key": "public_key8"
}
```



