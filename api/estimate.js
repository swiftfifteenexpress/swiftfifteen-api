// ============================================================
// Swift-Fifteen Express — Kwikpik Price Estimate Function
// Deployed on Vercel — keeps your API key hidden from the browser
// Route: POST /api/estimate
// ============================================================

export default async function handler(req, res) {

  // Allow requests from your domain only
  res.setHeader('Access-Control-Allow-Origin', 'https://swiftfifteenexpress.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { pickup_address, delivery_address, package_weight } = req.body;

  if (!pickup_address || !delivery_address) {
    return res.status(400).json({ error: 'Pickup and delivery addresses are required' });
  }

  // ── YOUR MARGIN SETTINGS ──────────────────────────────────
  // Adjust these at any time without touching the order form
  const MARGIN_FLAT       = 800;   // flat ₦800 added to every order
  const MARGIN_PERCENTAGE = 0;     // optional % on top (e.g. 0.1 = 10%). Set 0 to use flat only
  const MINIMUM_CHARGE    = 3000;  // never charge less than ₦3,000 regardless of Kwikpik price
  // ─────────────────────────────────────────────────────────

  try {
    // Call Kwikpik price estimate endpoint
    const kwikpikRes = await fetch('https://api.kwikpik.io/requests/estimate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.KWIKPIK_API_KEY,
      },
      body: JSON.stringify({
        pickup_address: pickup_address,
        delivery_address: delivery_address,
        package_weight: package_weight || 'small',
      })
    });

    if (!kwikpikRes.ok) {
      const errText = await kwikpikRes.text();
      console.error('Kwikpik estimate error:', errText);
      // Return a fallback zone-based price if Kwikpik API fails
      return res.status(200).json({
        success: true,
        kwikpik_price: null,
        your_price: MINIMUM_CHARGE,
        fallback: true,
        message: 'Price estimated based on zone. Final price confirmed on WhatsApp.'
      });
    }

    const data = await kwikpikRes.json();

    // Extract the base price from Kwikpik response
    // Covers all common Kwikpik response shapes
    const kwikpikBasePrice = data?.data?.amount
      || data?.data?.price
      || data?.data?.estimated_price
      || data?.data?.total
      || data?.data?.fee
      || data?.amount
      || data?.price
      || data?.estimated_price
      || data?.total
      || data?.fee
      || data?.estimated_cost
      || null;
    
    // Log full response in Vercel logs for debugging during testing
    console.log('Kwikpik estimate response:', JSON.stringify(data));

    if (!kwikpikBasePrice) {
      console.error('Could not extract price from Kwikpik response:', data);
      return res.status(200).json({
        success: true,
        kwikpik_price: null,
        your_price: MINIMUM_CHARGE,
        fallback: true,
        message: 'Price estimated based on zone.'
      });
    }

    // Calculate your final customer price
    const baseNum     = parseFloat(kwikpikBasePrice);
    const withMargin  = baseNum + MARGIN_FLAT + (baseNum * MARGIN_PERCENTAGE);
    const finalPrice  = Math.max(Math.ceil(withMargin / 100) * 100, MINIMUM_CHARGE);
    // Rounds up to nearest ₦100 for clean pricing and enforces minimum

    return res.status(200).json({
      success: true,
      kwikpik_price: baseNum,       // your internal cost (never shown to customer)
      your_price: finalPrice,        // what customer pays
      fallback: false,
      currency: 'NGN'
    });

  } catch (err) {
    console.error('Estimate function error:', err);
    // Graceful fallback — never break the order form
    return res.status(200).json({
      success: true,
      kwikpik_price: null,
      your_price: MINIMUM_CHARGE,
      fallback: true,
      message: 'Price estimated based on zone.'
    });
  }
      }
