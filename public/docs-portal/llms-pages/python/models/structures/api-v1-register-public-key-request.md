# Api V1 Register Public Key Request

Source: /#/python/x-redirect/JTI0bSUyRkFwaSUyNTIwVjElMjUyMFJlZ2lzdGVyJTI1MjBQdWJsaWMlMjUyMEtleSUyNTIwUmVxdWVzdA


# Class Name

`ApiV1RegisterPublicKeyRequest`


# Fields

| Name | Type | Tags | Description |
|  --- | --- | --- | --- |
| `public_key` | `str` | Required | Your Ed25519 public key, base64: the raw 32 bytes or the SPKI DER encoding.<br><br>**Constraints**: *Minimum Length*: `1`, *Maximum Length*: `512` |


# Example

```python
from mandatebankapi.models.api_v_1_register_public_key_request import ApiV1RegisterPublicKeyRequest

api_v_1_register_public_key_request = ApiV1RegisterPublicKeyRequest(
    public_key='public_key6'
)
```



