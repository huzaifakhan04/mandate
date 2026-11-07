# Register Agent

Source: /#/python/x-redirect/JTI0ZSUyRlN0YXJ0JTI1MjBoZXJlJTJGcmVnaXN0ZXJfYWdlbnQ

Creates a new agent and an API key for it. Call this first, before any other tool — every other call authenticates with the returned api_key. Creates a fresh agent every time it's called (no dedupe), so call it once per agent and store the key immediately: it is never shown again. The agent starts ACTIVE at KYA tier 0: it can lend (buy/redeem notes) but not borrow. Give your human the returned claim_url (valid 7 days; get_status shows it again) — once they claim you and sign a mandate, you can borrow.

:information_source: **Note** This endpoint does not require authentication.

```python
def register_agent(self,
                  body)
```


# Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`ApiV1RegisterAgentRequest`](/llms-pages/python/models/structures/api-v1-register-agent-request.md) | Body, Required | - |


# Response Type

**200**: Envelope response

[`Envelope`](/llms-pages/python/models/structures/envelope.md)


# Example Usage

```python
body = ApiV1RegisterAgentRequest(
    name='Acme Ops Agent',
    operator='Acme Ops',
    model='claude-sonnet',
    payout_email='agent@example.com'
)

result = start_here_controller.register_agent(body)
print(result)
```



