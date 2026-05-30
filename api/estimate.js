// ============================================================
// Swift-Fifteen Express — Kwikpik Price Estimate Function
// Route: POST /api/estimate
// ============================================================

export default async function handler(req, res) {

  // Allow all origins — fixes CORS for www and non-www
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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
  const MARGIN_FLAT       = 800;   // flat ₦800 added to every order
  const MARGIN_PERCENTAGE = 0;     // optional % on top. Set 0 to use flat only
  const MINIMUM_CHARGE    = 3000;  // never charge less than ₦3,000
  // ─────────────────────────────────────────────────────────

  // Check API key is present
  if (!process.env.KWIKPIK_API_KEY) {
    console.error('KWIKPIK_API_KEY environment variable is missing');
    return res.status(200).json({
      success: true,
      kwikpik_price: null,
      your_price: MINIMUM_CHARGE,
      fallback: true,
      message: 'API key not configured'
    });
  }

  try {
    console.log('Calling Kwikpik estimate with:', { pickup_address, delivery_address });

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

    const rawText = await kwikpikRes.text();
    console.log('Kwikpik raw response status:', kwikpikRes.status);
    console.log('Kwikpik raw response body:', rawText);

    let data;
    try {
      data = JSON.parse(rawText);
    } catch(e) {
      console.error('Failed to parse Kwikpik response as JSON:', rawText);
      return res.status(200).json({
        success: true,
        your_price: MINIMUM_CHARGE,
        fallback: true,
        message: 'Could not parse Kwikpik response'
      });
    }

    // Extract price — covers all common Kwikpik response shapes
    const kwikpikBasePrice = data?.data?.amount
      || data?.data?.price
      || data?.data?.estimated_price
      || data?.data?.total
      || data?.data?.fee
      || data?.data?.cost
      || data?.amount
      || data?.price
      || data?.estimated_price
      || data?.total
      || data?.fee
      || data?.cost
      || null;

    if (!kwikpikBasePrice) {
      console.error('Could not extract price. Full response:', JSON.stringify(data));
      return res.status(200).json({
        success: true,
        kwikpik_price: null,
        your_price: MINIMUM_CHARGE,
        fallback: true,
        debug_response: data,
        message: 'Price field not found in response'
      });
    }

    const baseNum    = parseFloat(kwikpikBasePrice);
    const withMargin = baseNum + MARGIN_FLAT + (baseNum * MARGIN_PERCENTAGE);
    const finalPrice = Math.max(Math.ceil(withMargin / 100) * 100, MINIMUM_CHARGE);

    return res.status(200).json({
      success: true,
      kwikpik_price: baseNum,
      your_price: finalPrice,
      fallback: false,
      currency: 'NGN'
    });

  } catch (err) {
    console.error('Estimate function error:', err.message);
    return res.status(200).json({
      success: true,
      kwikpik_price: null,
      your_price: MINIMUM_CHARGE,
      fallback: true,
      error: err.message,
      message: 'Fallback price used due to API error'
    });
  }
}
