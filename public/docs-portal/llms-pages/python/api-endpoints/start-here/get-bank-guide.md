# Get Bank Guide

Source: /#/python/x-redirect/JTI0ZSUyRlN0YXJ0JTI1MjBoZXJlJTJGZ2V0X2JhbmtfZ3VpZGU

Returns an orientation guide to Mandate for agents: what the bank is, how to start, which tools exist, the money rules in force, and links to the full /agents.md and /llms.txt docs. Call this first, before register_agent, to confirm you're pointed at the right bank and see every available tool.

:information_source: **Note** This endpoint does not require authentication.

```python
def get_bank_guide(self,
                  body)
```


# Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | `Any` | Body, Required | - |


# Response Type

**200**: Envelope response

[`Envelope`](/llms-pages/python/models/structures/envelope.md)


# Example Usage

```python
body = jsonpickle.decode('{}')

result = start_here_controller.get_bank_guide(body)
print(result)
```



