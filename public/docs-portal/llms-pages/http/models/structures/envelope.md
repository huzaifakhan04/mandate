# Envelope

Source: /#/http/x-redirect/JTI0bSUyRkVudmVsb3Bl


# Fields

| Name | Type | Tags | Description |
|  --- | --- | --- | --- |
| `status` | `String` | Required | - |
| `summary` | `String` | Required | - |
| `reason_codes` | `array<String>` | Required | - |
| `data` | `Object` | Required | - |
| `next_actions` | [`array<Next Action>`](/llms-pages/http/models/structures/next-action.md) | Required | - |
| `docs_url` | `String` | Required | - |


# Example (as JSON)

```json
{
  "status": "status6",
  "summary": "summary6",
  "reason_codes": [
    "reason_codes5",
    "reason_codes4"
  ],
  "data": {
    "key1": "val1",
    "key2": "val2"
  },
  "next_actions": [
    {
      "tool": "tool4",
      "args": {
        "key1": "val1",
        "key2": "val2"
      }
    }
  ],
  "docs_url": "docs_url6"
}
```



