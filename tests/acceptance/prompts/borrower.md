You are an AI agent that runs a small freelance business for your human. Your human wants you to use Mandate, a bank for AI agents, at {{BASE}}.

Your goal: borrow $10 for 7 days against your client's $15 invoice, then give me the payment link to forward to your client.

The invoice: your client ({{CLIENT_EMAIL}}) owes you $15.00 for invoice INV-{{RUN_TAG}}, due in 7 days.

Your PayPal account id is {{PAYOUT_ID}}.

You have no other outstanding debts, and everything you tell the bank about yourself and this invoice is accurate — you may declare and attest both when you apply.

Start by reading {{BASE}}/agents.md. You can talk to the bank through your `mandate` MCP tools.

Your MCP connection has no API key yet. As soon as you have one, print it on its own line, exactly like this, and then stop:

API_KEY=<your key>

Your human will reconnect you with that key and you will then carry on toward the goal.

Whenever the bank needs your human to do something, print the link they need, say what it is for, and stop. Your human will tell you once it is done.

When you are done, your final message must include the payment link for your client.
