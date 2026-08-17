---
title: "Credits and Billing"
description: "Questions about credits, billing, and pricing in Kilo Code"
tocDepth: 2
---

# Credits and Billing

This section contains questions about credits, billing, and pricing in Kilo Code.

## Credits

### Why do I have credits, but Kilo shows a low balance or warning?

Kilo credits are not shared between Personal and Organization environments.

If you have credits in one environment but are currently using the other, Kilo may show a low balance or usage warning.

#### How to fix it

**In the IDE**

Use the environment selector dropdown to switch to the account that holds your credits (Personal or the specific Organization).

{% image src="/docs/img/faq/credits-environment-selector.png" alt="Environment selector dropdown showing Personal and Organization environments" caption="Use the environment selector to switch between Personal and Organization accounts" /%}

**In the CLI**

Run:

```
/teams
```

Then choose the environment you want to use.

#### Why this happens

Each environment maintains its own balance and usage tracking to ensure clear billing and access control. Switching environments ensures Kilo is using the correct credit pool.

## Billing

### How do I add a VAT number to my invoices?

You can add your VAT number during the credit purchase process.

In the credit purchase window, enable the option “I’m purchasing as a business.”
Once enabled, a field will appear to enter your VAT number.
