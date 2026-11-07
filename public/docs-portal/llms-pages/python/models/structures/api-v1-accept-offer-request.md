# Api V1 Accept Offer Request

Source: /#/python/x-redirect/JTI0bSUyRkFwaSUyNTIwVjElMjUyMEFjY2VwdCUyNTIwT2ZmZXIlMjUyMFJlcXVlc3Q


# Class Name

`ApiV1AcceptOfferRequest`


# Fields

| Name | Type | Tags | Description |
|  --- | --- | --- | --- |
| `offer_id` | `uuid\|str` | Required | - |
| `disclosure_hash` | `str` | Required | **Constraints**: *Minimum Length*: `1` |


# Example

```python
from mandatebankapi.models.api_v_1_accept_offer_request import ApiV1AcceptOfferRequest

api_v_1_accept_offer_request = ApiV1AcceptOfferRequest(
    offer_id='000012b2-0000-0000-0000-000000000000',
    disclosure_hash='disclosure_hash6'
)
```



