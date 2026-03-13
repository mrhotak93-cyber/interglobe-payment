export default {
  async fetch(request, env) {

    if (request.method === "POST") {

      const data = await request.json()

      const price = Number(data.price)

      if (!price || price <= 0) {
        return new Response(JSON.stringify({
          error: "Prix invalide"
        }), { status: 400 })
      }

      const mollieResponse = await fetch(
        "https://api.mollie.com/v2/payments",
        {
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
            description: "Transport express",
            redirectUrl: "https://tonsite.com/paiement-ok",
            cancelUrl: "https://tonsite.com/paiement-annule",
            webhookUrl: "https://tonworker/webhook"
          })
        }
      )

      const payment = await mollieResponse.json()

      return new Response(JSON.stringify({
        checkout: payment._links.checkout.href
      }), {
        headers: { "Content-Type": "application/json" }
      })

    }

    return new Response("Worker actif")
  }
}
