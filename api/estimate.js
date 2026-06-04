// ============================================================
// Swift-Fifteen Express — Shipbubble Price Estimate Function
// Route: POST /api/estimate
// Flow: validate addresses → get address codes → fetch rates
// ============================================================

/**
 * Utility: Validate an address and get its unique address_code
 */
async function validateAddress(address, name, phone, email, apiKey) {
  const payload = {
    name:    name,
    email:   email || 'orders@swiftfifteenexpress.com',
    phone:   phone,
    address: address + (address.toLowerCase().includes('nigeria') ? '' : ', Lagos, Nigeria')
  };

  console.log(`Estimator - Validating: "${payload.address}"`);

  const res = await fetch('https://api.shipbubble.com/v1/shipping/address/validate', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await res.json();
  
  if (data.status !== 'success' || !data.data?.address_code) {
    throw new Error(`Address validation failed for "${address}": ${data.message || 'unknown error'}`);
  }
  return data.data.address_code;
}

export default async function handler(req, res) {
  // --- CORS Headers ---
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { pickup_address, delivery_address, package_weight } = req.body;

  console.log('=== estimate-request execution started ===');

  if (!pickup_address || !delivery_address) {
    return res.status(400).json({ error: 'Both pickup and delivery addresses are required for an estimate' });
  }

  const MINIMUM_CHARGE = 2000;
  const API_KEY = process.env.SHIPBUBBLE_API_KEY;

  if (!API_KEY) {
    console.warn('Shipbubble API key missing - returning fallback price');
    return res.status(200).json({
      success: true, 
      kwikpik_price: null,
      your_price: MINIMUM_CHARGE, 
      fallback: true,
      message: 'Pricing currently estimated based on minimum charge.'
    });
  }

  try {
    // Step 1 — Validate both addresses to get address codes
    console.log('Validating addresses for rate calculation...');
    const [senderCode, receiverCode] = await Promise.all([
      validateAddress(
        pickup_address,
        'Swift-Fifteen Express',
        '+2348029234994',
        'orders@swiftfifteenexpress.com',
        API_KEY
      ),
      validateAddress(
        delivery_address,
        'Prospective Recipient',
        '+2348000000000',
        'recipient@example.com',
        API_KEY
      )
    ]);

    // Step 2 — Fetch rates using address codes
    const weight = parseFloat(package_weight) || 1;
    const ratesPayload = {
      pickup_date: new Date().toISOString().split('T')[0],
      category_id: 1, // General Category
      package_items: [{
        name: 'Logistics Package',
        description: 'Standard Delivery',
        unit_weight: weight.toString(),
        unit_amount: "1000",
        quantity: "1"
      }],
      package_dimension: { length: 10, width: 10, height: 10 },
      sender_address_code: senderCode,
      reciever_address_code: receiverCode // Note: Documentation uses this specific spelling
    };

    console.log('Fetching live shipping rates...');
    const ratesRes = await fetch('https://api.shipbubble.com/v1/shipping/fetch_rates', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(ratesPayload)
    });

    const ratesData = await ratesRes.json();

    if (ratesData.status !== 'success' || !ratesData.data?.couriers?.length) {
      console.warn('No couriers found for route - using fallback');
      return res.status(200).json({
        success: true, 
        your_price: MINIMUM_CHARGE,
        fallback: true, 
        message: 'No active couriers found for this route, using base estimate.'
      });
    }

    // Identify the cheapest available option
    const cheapest = ratesData.data.cheapest_courier || ratesData.data.couriers[0];
    const basePrice = parseFloat(cheapest?.total || 0);

    if (!basePrice) {
      return res.status(200).json({
        success: true, 
        your_price: MINIMUM_CHARGE,
        fallback: true, 
        message: 'Rate calculation returned zero, using base estimate.'
      });
    }

    // Success response with live data
    return res.status(200).json({
      success: true,
      kwikpik_price: basePrice,
      your_price: basePrice, // You can add your markup here if needed (e.g., basePrice + 500)
      courier_name: cheapest.courier_name,
      pickup_eta: cheapest.pickup_eta,
      delivery_eta: cheapest.delivery_eta,
      sender_address_code: senderCode,
      reciever_address_code: receiverCode,
      request_token: ratesData.data.request_token,
      fallback: false,
      currency: 'NGN'
    });

  } catch (err) {
    console.error('Estimate Error:', err.message);
    return res.status(200).json({
      success: true, 
      your_price: MINIMUM_CHARGE,
      fallback: true, 
      error: err.message
    });
  }
    }
    
