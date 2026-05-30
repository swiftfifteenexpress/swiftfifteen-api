// ============================================================
// Swift-Fifteen Express — Kwikpik Price Estimate Function
// Route: POST /api/estimate
// ============================================================

export default async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { pickup_address, delivery_address, package_weight } = req.body;

  const MARGIN_FLAT    = 800;
  const MINIMUM_CHARGE = 3000;

  if (!process.env.KWIKPIK_API_KEY) {
    return res.status(200).json({
      success: true, your_price: MINIMUM_CHARGE,
      fallback: true, message: 'API key not configured'
    });
  }

  try {
    const kwikpikRes = await fetch('https://api.kwikpik.io/requests/estimate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.KWIKPIK_API_KEY,
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        pickup_address: pickup_address,
        delivery_address: delivery_address,
        package_weight: package_weight || 'small',
      })
    });

    const rawText = await kwikpikRes.text();

    // Return the raw response so we can see exactly what Kwikpik is sending
    // TEMPORARY — for debugging only
    return res.status(200).json({
      success: false,
      debug: true,
      kwikpik_status: kwikpikRes.status,
      kwikpik_status_text: kwikpikRes.statusText,
      kwikpik_raw_response: rawText,
      api_key_first_4_chars: process.env.KWIKPIK_API_KEY.substring(0, 4),
      message: 'Debug mode — showing raw Kwikpik response'
    });

  } catch (err) {
    return res.status(200).json({
      success: false, fallback: true,
      error: err.message,
      message: 'Network error reaching Kwikpik'
    });
  }
                                                  }
