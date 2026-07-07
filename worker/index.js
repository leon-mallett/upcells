/**
 * Upcells — Polar → Keygen webhook worker
 *
 * When a customer completes a purchase on Polar, this worker:
 * 1. Receives the webhook from Polar
 * 2. Validates the webhook signature (Standard Webhooks / Svix format)
 * 3. Creates a licence key in Keygen
 * 4. Optionally emails the key to the customer via Resend
 *
 * Required environment variables (set as Worker secrets):
 *   KEYGEN_ACCOUNT_ID   — your Keygen account ID
 *   KEYGEN_ADMIN_TOKEN   — a Keygen admin API token (create in Keygen → Settings → API Tokens)
 *   KEYGEN_POLICY_ID     — the policy ID for "Standard" licences
 *   POLAR_WEBHOOK_SECRET — the webhook signing secret from Polar
 *   RESEND_API_KEY       — (optional) Resend API key for emailing the licence key
 *   POLAR_SALES_ACCELERATOR_PRODUCT_IDS — (optional) comma-separated Polar product ID(s)
 *       that grant the Sales Accelerator tier. Orders for these products get
 *       metadata.salesAccelerator=true on the Keygen licence (the flag the app reads).
 *       Leave unset for standard-only.
 */

export default {
  async fetch(request, env) {
    // Only accept POST
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const body = await request.text();

    // ── Verify webhook signature ──────────────────────────────────────────
    try {
      await verifyWebhook(request.headers, body, env.POLAR_WEBHOOK_SECRET);
    } catch (err) {
      console.error("Webhook verification failed:", err.message);
      return new Response("Invalid signature", { status: 401 });
    }

    // ── Parse the event ───────────────────────────────────────────────────
    const event = JSON.parse(body);

    // Polar sends various event types — we only care about completed orders
    if (event.type !== "order.created") {
      return new Response("Ignored event type: " + event.type, { status: 200 });
    }

    const order = event.data;
    const customerEmail =
      order.customer?.email ||
      order.user?.email ||
      order.customer_email ||
      null;
    const customerName =
      order.customer?.name ||
      order.user?.public_name ||
      order.customer_name ||
      "Upcells Customer";

    if (!customerEmail) {
      console.error("No customer email found in order:", JSON.stringify(order));
      return new Response("No customer email", { status: 200 });
    }

    // Does this order include the Sales Accelerator tier?
    const salesAccelerator = orderGrantsSalesAccelerator(order, env);

    // ── Create Keygen licence ─────────────────────────────────────────────
    let licenceKey;
    try {
      licenceKey = await createKeygenLicence(env, customerEmail, customerName, salesAccelerator);
    } catch (err) {
      console.error("Keygen licence creation failed:", err.message);
      return new Response("Keygen error: " + err.message, { status: 500 });
    }

    // ── Email the key (optional — only if RESEND_API_KEY is set) ──────────
    if (env.RESEND_API_KEY && licenceKey) {
      try {
        await sendLicenceEmail(env.RESEND_API_KEY, customerEmail, customerName, licenceKey, salesAccelerator);
        console.log("Licence key emailed to", customerEmail);
      } catch (err) {
        // Don't fail the webhook if email fails — the key is still in Keygen
        console.error("Email send failed:", err.message);
      }
    }

    console.log(
      "Licence created for",
      customerEmail,
      salesAccelerator ? "(Sales Accelerator)" : "(Standard)",
      "— key starts with",
      licenceKey?.substring(0, 10)
    );
    return new Response("OK", { status: 200 });
  },
};

// ── Keygen licence creation ───────────────────────────────────────────────────

async function createKeygenLicence(env, email, name, salesAccelerator = false) {
  const url = `https://api.keygen.sh/v1/accounts/${env.KEYGEN_ACCOUNT_ID}/licenses`;

  const metadata = {
    customerEmail: email,
    customerName: name,
  };
  // The app gates the Sales Accelerator tier on this flag (LicenseInfo.sales_accelerator).
  if (salesAccelerator) {
    metadata.salesAccelerator = true;
  }

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/vnd.api+json",
      "Accept": "application/vnd.api+json",
      "Authorization": `Bearer ${env.KEYGEN_ADMIN_TOKEN}`,
    },
    body: JSON.stringify({
      data: {
        type: "licenses",
        attributes: { metadata },
        relationships: {
          policy: {
            data: { type: "policies", id: env.KEYGEN_POLICY_ID },
          },
        },
      },
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Keygen API ${resp.status}: ${text}`);
  }

  const json = await resp.json();
  return json.data.attributes.key;
}

// ── Tier detection ─────────────────────────────────────────────────────────────

/** Whether the order's product is configured to grant the Sales Accelerator tier. */
function orderGrantsSalesAccelerator(order, env) {
  const configured = (env.POLAR_SALES_ACCELERATOR_PRODUCT_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (configured.length === 0) return false;

  const ids = collectProductIds(order);
  return configured.some((id) => ids.has(id));
}

/** Collect every product id referenced by a Polar order, across the shapes Polar may use. */
function collectProductIds(order) {
  const ids = new Set();
  const add = (v) => {
    if (v) ids.add(String(v));
  };
  add(order.product_id);
  add(order.product?.id);
  for (const item of order.items || order.line_items || []) {
    add(item.product_id);
    add(item.product?.id);
    add(item.price?.product_id);
  }
  return ids;
}

// ── Webhook signature verification (Standard Webhooks / Svix format) ──────────

async function verifyWebhook(headers, body, secret) {
  const webhookId = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signatures = headers.get("webhook-signature");

  if (!webhookId || !timestamp || !signatures) {
    throw new Error("Missing webhook headers");
  }

  // Check timestamp is within 5 minutes to prevent replay attacks
  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(timestamp, 10);
  if (Math.abs(now - ts) > 300) {
    throw new Error("Webhook timestamp too old");
  }

  // The secret from Polar is prefixed with "whsec_" and base64-encoded
  const secretBase64 = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const secretBytes = Uint8Array.from(atob(secretBase64), (c) => c.charCodeAt(0));

  // Construct the signed content
  const signedContent = `${webhookId}.${timestamp}.${body}`;
  const encoder = new TextEncoder();

  // Compute HMAC-SHA256
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signatureBytes = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(signedContent)
  );
  const computed = btoa(String.fromCharCode(...new Uint8Array(signatureBytes)));

  // Polar may send multiple signatures (v1,xxx v2,yyy) — check if any match
  const valid = signatures.split(" ").some((sig) => {
    const value = sig.includes(",") ? sig.split(",")[1] : sig;
    return value === computed;
  });

  if (!valid) {
    throw new Error("Signature mismatch");
  }
}

// ── Email delivery via Resend ─────────────────────────────────────────────────

async function sendLicenceEmail(apiKey, toEmail, name, licenceKey, salesAccelerator = false) {
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from: "Upcells <noreply@upcells.app>",
      to: [toEmail],
      subject: "Your Upcells licence key",
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
          <h1 style="font-size: 24px; font-weight: bold; margin-bottom: 8px;">Welcome to Upcells</h1>
          <p style="color: #666; margin-bottom: 24px;">Hi ${name}, thanks for your purchase! Here's your licence key:</p>
          <div style="background: #f5f5f5; border: 1px solid #e0e0e0; border-radius: 8px; padding: 16px; font-family: monospace; font-size: 13px; word-break: break-all; margin-bottom: 24px;">
            ${licenceKey}
          </div>
          ${
            salesAccelerator
              ? `<p style="color: #666; font-size: 14px; margin-bottom: 24px;">Your licence includes the <strong>Sales Accelerator</strong> — a private, on-device AI assistant for your Salesforce data.</p>`
              : ""
          }
          <p style="color: #666; font-size: 14px; margin-bottom: 16px;"><strong>To activate:</strong></p>
          <ol style="color: #666; font-size: 14px; padding-left: 20px; margin-bottom: 24px;">
            <li>Open Upcells</li>
            <li>Click "Already have a licence key?"</li>
            <li>Paste the key above and click Activate</li>
          </ol>
          <p style="color: #999; font-size: 12px;">Your key can be activated on up to 3 machines. You can deactivate and transfer from Settings → License at any time.</p>
        </div>
      `,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Resend API ${resp.status}: ${text}`);
  }
}
