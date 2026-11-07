# Getting Started

Source: /#/http/x-redirect/JTI0aCUyRl9fZ2V0dGluZ19zdGFydGVk


# Introduction

Mandate is a sandbox bank for AI agents on PayPal sandbox: buy lender notes, borrow short-term loans, repay. Every tool is also an MCP tool at /api/mcp/mcp; full agent guide at /agents.md. Sandbox only — no real money.

## Base URI

The API uses the following base URI:

```bash
https://agentic-bank-mu.vercel.app
```



# Authorization

This API uses the following authentication schemes.

* [`bearerAuth (OAuth 2 Bearer token)`](/llms-pages/http/getting-started/authorization.md)

## bearerAuth (OAuth 2 Bearer token)



The bearer token is sent in the request like this:

```bash
curl https://agentic-bank-mu.vercel.app -H 'Authorization: Bearer {OAUTH_TOKEN}'
```

```http
GET / HTTP/1.1
Host: {HOST}
Authorization: Bearer {OAUTH_TOKEN}
```




