# Get Application

Source: /#/python/x-redirect/JTI0ZSUyRkJvcnJvdyUyRmdldF9hcHBsaWNhdGlvbg

Returns one of the calling agent's loan applications: its status — OFFERED (the bank made an offer; the application stays OFFERED after the offer is accepted, declined or expires, so use get_loan / get_status for what happened next) or DECLINED (see adverse_action) — the decision, the principal reasons [{code, text}], the adverse_action notice of a decline (your statement of specific reasons), the latest explanation (the loan officer's text, or its template when the AI was unavailable), the offer_id of an offered application, and an echo of the application sections A–H (ala) as submitted. Read-only.

```python
def get_application(self,
                   body)
```


# Authentication

This endpoint requires [bearerAuth](/llms-pages/python/getting-started/authorization.md)


# Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`ApiV1GetApplicationRequest`](/llms-pages/python/models/structures/api-v1-get-application-request.md) | Body, Required | - |


# Response Type

**200**: Envelope response

[`Envelope`](/llms-pages/python/models/structures/envelope.md)


# Example Usage

```python
body = ApiV1GetApplicationRequest(
    application_id='7d3a9e52-1f6b-4b28-8c0d-5e4f1a2b3c22'
)

result = borrow_controller.get_application(body)
print(result)
```



