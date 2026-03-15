export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("worker actif", { headers: corsHeaders });
    }

    if (request.method === "GET" && url.pathname === "/success") {
      const reservationNumber = url.searchParams.get("reservationNumber") || "";
      const redirectUrl = reservationNumber
        ? `https://booking.interglobe.be/?success=1&res=${encodeURIComponent(reservationNumber)}`
        : `https://booking.interglobe.be/`;

      return Response.redirect(redirectUrl, 302);
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      try {
        const contentType = request.headers.get("content-type") || "";
        let paymentId = "";

        if (contentType.includes("application/x-www-form-urlencoded")) {
          const formData = await request.formData();
          paymentId = formData.get("id") || "";
        } else if (contentType.includes("application/json")) {
          const body = await request.json();
          paymentId = body.id || "";
        } else {
          const rawText = await request.text();
          const params = new URLSearchParams(rawText);
          paymentId = params.get("id") || "";
        }

        if (!paymentId) {
          return new Response("Payment ID manquant", {
            status: 400,
            headers: corsHeaders
          });
        }

        const molliePaymentRes = await fetch(`https://api.mollie.com/v2/payments/${paymentId}`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${env.MOLLIE_API_KEY}`
          }
        });

        const payment = await molliePaymentRes.json();

        if (!molliePaymentRes.ok) {
          return new Response(JSON.stringify(payment), {
            status: molliePaymentRes.status,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json"
            }
          });
        }

        if (payment.status !== "paid") {
          return new Response(`Paiement non payé (${payment.status})`, {
            status: 200,
            headers: corsHeaders
          });
        }

        const reservationNumber = payment.metadata?.reservationNumber || "";
        const vehicle = payment.metadata?.vehicle || "";
        const customerEmail = payment.metadata?.billingEmail || "";
        const amount = payment.amount?.value || "";
        const currency = payment.amount?.currency || "EUR";

        const fromEmail = env.FROM_EMAIL || "InterGlobe <mail@interglobe.be>";
        const adminEmail = env.ADMIN_EMAIL || "info@interglobe.be";
        const signatureEmail = env.SIGNATURE_EMAIL || "info@interglobe.be";

        if (customerEmail) {
          await sendEmailWithResend({
            env,
            to: customerEmail,
            subject: `Confirmation de votre réservation - ${reservationNumber}`,
            html: getCustomerEmailHtml({
              reservationNumber,
              amount,
              currency,
              vehicle,
              signatureEmail
            }),
            text: getCustomerEmailText({
              reservationNumber,
              amount,
              currency,
              vehicle,
              signatureEmail
            }),
            idempotencyKey: `payment-${payment.id}-customer-confirmation`
          });
        }

        await sendEmailWithResend({
          env,
          to: adminEmail,
          subject: `Nouvelle réservation payée - ${reservationNumber}`,
          html: getAdminEmailHtml({
            reservationNumber,
            amount,
            currency,
            vehicle,
            customerEmail,
            molliePaymentId: payment.id
          }),
          text: getAdminEmailText({
            reservationNumber,
            amount,
            currency,
            vehicle,
            customerEmail,
            molliePaymentId: payment.id
          }),
          idempotencyKey: `payment-${payment.id}-admin-notification`
        });

        return new Response("Webhook traité avec succès", {
          status: 200,
          headers: corsHeaders
        });
      } catch (error) {
        return new Response(
          JSON.stringify({ error: error.message }),
          {
            status: 500,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json"
            }
          }
        );
      }
    }

    if (request.method === "POST" && url.pathname === "/create-payment") {
      try {
        const data = await request.json();
        const price = Number(data.price);
        const reservationNumber = data.reservationNumber || "";

        if (!price || price <= 0) {
          return new Response(
            JSON.stringify({ error: "Prix invalide" }),
            {
              status: 400,
              headers: {
                ...corsHeaders,
                "Content-Type": "application/json"
              }
            }
          );
        }

        const baseUrl = `${url.protocol}//${url.host}`;

        const mollieResponse = await fetch("https://api.mollie.com/v2/payments", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.MOLLIE_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            amount: {
              currency: "EUR",
              value: price.toFixed(2)
            },
            description: `Commande transport ${reservationNumber}`.trim(),
            redirectUrl: `${baseUrl}/success?reservationNumber=${encodeURIComponent(reservationNumber)}`,
            webhookUrl: `${baseUrl}/webhook`,
            metadata: {
              reservationNumber: reservationNumber,
              vehicle: data.vehicle || "",
              billingEmail: data.billingEmail || ""
            }
          })
        });

        const payment = await mollieResponse.json();

        if (!mollieResponse.ok) {
          return new Response(JSON.stringify(payment), {
            status: mollieResponse.status,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json"
            }
          });
        }

        return new Response(
          JSON.stringify({
            checkout: payment._links.checkout.href,
            id: payment.id
          }),
          {
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json"
            }
          }
        );
      } catch (error) {
        return new Response(
          JSON.stringify({ error: error.message }),
          {
            status: 500,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json"
            }
          }
        );
      }
    }

    return new Response("Route introuvable", {
      status: 404,
      headers: corsHeaders
    });
  }
};

async function sendEmailWithResend({ env, to, subject, html, text, idempotencyKey }) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey
    },
    body: JSON.stringify({
      from: env.FROM_EMAIL || "InterGlobe <mail@interglobe.be>",
      to,
      subject,
      html,
      text
    })
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(`Erreur Resend: ${JSON.stringify(result)}`);
  }

  return result;
}

function getCustomerEmailHtml({ reservationNumber, amount, currency, vehicle, signatureEmail }) {
  return `
  <!DOCTYPE html>
  <html lang="fr">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Confirmation de réservation - InterGlobe</title>
  </head>
  <body style="margin:0; padding:0; background-color:#f4f6f8; font-family:Arial, Helvetica, sans-serif; color:#1f2937;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f6f8; margin:0; padding:30px 15px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px; background-color:#ffffff; border-radius:14px; overflow:hidden;">
            <tr>
              <td style="background-color:#17365d; padding:24px 30px; text-align:center;">
                <div style="font-size:28px; font-weight:bold; color:#ffffff; letter-spacing:0.5px;">
                  InterGlobe
                </div>
              </td>
            </tr>

            <tr>
              <td style="padding:36px 34px 10px 34px; text-align:center;">
                <h1 style="margin:0; font-size:28px; line-height:34px; color:#17365d;">
                  Paiement confirmé
                </h1>
              </td>
            </tr>

            <tr>
              <td style="padding:8px 34px 10px 34px; text-align:center; font-size:16px; line-height:25px; color:#4b5563;">
                Merci pour votre réservation.<br />
                Votre paiement a bien été reçu et votre transport est enregistré.
              </td>
            </tr>

            <tr>
              <td style="padding:22px 34px 10px 34px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb; border-radius:10px; overflow:hidden;">
                  <tr>
                    <td colspan="2" style="background:#f8fafc; padding:14px 18px; font-size:16px; font-weight:bold; color:#17365d;">
                      Détails de votre réservation
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:14px 18px; border-top:1px solid #e5e7eb; font-weight:bold; width:48%;">Numéro de réservation</td>
                    <td style="padding:14px 18px; border-top:1px solid #e5e7eb;">${escapeHtml(reservationNumber)}</td>
                  </tr>
                  <tr>
                    <td style="padding:14px 18px; border-top:1px solid #e5e7eb; font-weight:bold;">Montant payé</td>
                    <td style="padding:14px 18px; border-top:1px solid #e5e7eb;">${escapeHtml(amount)} ${escapeHtml(currency)}</td>
                  </tr>
                  <tr>
                    <td style="padding:14px 18px; border-top:1px solid #e5e7eb; font-weight:bold;">Véhicule</td>
                    <td style="padding:14px 18px; border-top:1px solid #e5e7eb;">${escapeHtml(vehicle)}</td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding:20px 34px 10px 34px; font-size:15px; line-height:25px; color:#374151;">
                Notre équipe reviendra vers vous prochainement afin de finaliser l’organisation du transport.
              </td>
            </tr>

            <tr>
              <td style="padding:14px 34px 34px 34px; font-size:15px; line-height:25px; color:#374151;">
                Merci pour votre confiance.<br /><br />
                <strong>L’équipe InterGlobe</strong>
              </td>
            </tr>

            <tr>
              <td style="background:#f8fafc; border-top:1px solid #e5e7eb; padding:28px 24px; text-align:center; font-size:14px; line-height:22px; color:#6b7280;">
                <strong style="color:#17365d;">InterGlobe</strong><br />
                Driving your success forward<br /><br />
                Leuvensesteenweg 270 - 1932 Zaventem - Belgique<br />
                ${escapeHtml(signatureEmail)} - 0032/472.31.73.11<br />
                <a href="https://www.interglobe.be" style="color:#17365d; text-decoration:none; font-weight:bold;">www.interglobe.be</a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>
  `;
}

function getCustomerEmailText({ reservationNumber, amount, currency, vehicle, signatureEmail }) {
  return `Votre paiement est confirmé

Merci pour votre réservation.

Numéro de réservation : ${reservationNumber}
Montant payé : ${amount} ${currency}
Véhicule : ${vehicle}

Notre équipe reviendra vers vous prochainement afin de finaliser l’organisation du transport.

InterGlobe
Driving your success forward

Leuvensesteenweg 270 - 1932 Zaventem - Belgique
${signatureEmail}
0032/472.31.73.11
www.interglobe.be`;
}

function getAdminEmailHtml({ reservationNumber, amount, currency, vehicle, customerEmail, molliePaymentId }) {
  return `
  <!DOCTYPE html>
  <html lang="fr">
  <head>
    <meta charset="UTF-8" />
    <title>Nouvelle réservation payée</title>
  </head>
  <body style="margin:0; padding:20px; background:#f4f6f8; font-family:Arial, Helvetica, sans-serif; color:#1f2937;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px; background:#ffffff; border-radius:12px; overflow:hidden;">
            <tr>
              <td style="background:#17365d; color:#ffffff; padding:22px 28px; font-size:22px; font-weight:bold;">
                Nouvelle réservation payée
              </td>
            </tr>
            <tr>
              <td style="padding:28px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
                  <tr>
                    <td style="padding:12px; border-bottom:1px solid #e5e7eb; font-weight:bold;">Numéro de réservation</td>
                    <td style="padding:12px; border-bottom:1px solid #e5e7eb;">${escapeHtml(reservationNumber)}</td>
                  </tr>
                  <tr>
                    <td style="padding:12px; border-bottom:1px solid #e5e7eb; font-weight:bold;">Montant</td>
                    <td style="padding:12px; border-bottom:1px solid #e5e7eb;">${escapeHtml(amount)} ${escapeHtml(currency)}</td>
                  </tr>
                  <tr>
                    <td style="padding:12px; border-bottom:1px solid #e5e7eb; font-weight:bold;">Véhicule</td>
                    <td style="padding:12px; border-bottom:1px solid #e5e7eb;">${escapeHtml(vehicle)}</td>
                  </tr>
                  <tr>
                    <td style="padding:12px; border-bottom:1px solid #e5e7eb; font-weight:bold;">Email client</td>
                    <td style="padding:12px; border-bottom:1px solid #e5e7eb;">${escapeHtml(customerEmail)}</td>
                  </tr>
                  <tr>
                    <td style="padding:12px; font-weight:bold;">ID Mollie</td>
                    <td style="padding:12px;">${escapeHtml(molliePaymentId)}</td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>
  `;
}

function getAdminEmailText({ reservationNumber, amount, currency, vehicle, customerEmail, molliePaymentId }) {
  return `Nouvelle réservation payée

Numéro de réservation : ${reservationNumber}
Montant : ${amount} ${currency}
Véhicule : ${vehicle}
Email client : ${customerEmail}
ID Mollie : ${molliePaymentId}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
