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
      return new Response("Webhook reçu", {
        status: 200,
        headers: corsHeaders
      });
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
