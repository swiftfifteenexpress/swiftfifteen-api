// ============================================================
// Swift-Fifteen Express — Shipbubble Price Estimate Function
// Route: POST /api/estimate
// Flow: validate addresses → get address codes → fetch rates
// ============================================================

async function validateAddress(address, name, phone, email, apiKey) {
  const payload = {
    name:    name,
    email:   email,
    phone:   phone,
    address: address + ', Lagos, Nigeria'
  };

  console.log(`Validating address: "${address}"`);

  const res = await fetch('https://api.shipbubble.com/v1/shipping/address/validate', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json'
    },
    body: JSON.stringify(payload)
  });

  const raw = await res.text();
  console.log(`Address validate status: ${res.status}`);
  console.log(`Address validate response: ${raw}`);

  const data = JSON.parse(raw);
  if (data.status !== 'success' || !data.data?.address_code) {
    throw new Error(`Address validation failed for "${address}": ${data.message || 'unknown error'}`);
  }
  return data.data.address_code;
}

export default async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { pickup_address, delivery_address, package_weight } = req.body;

  console.log('=== estimate called ===');
  console.log('Pickup:', pickup_address);
  console.log('Delivery:', delivery_address);

  if (!pickup_address || !delivery_address) {
    return res.status(400).json({ error: 'Both addresses are required' });
  }

  const MINIMUM_CHARGE = 2000;
  const API_KEY = process.env.SHIPBUBBLE_API_KEY;

  if (!API_KEY) {
    return res.status(200).json({
      success: true, kwikpik_price: null,
      your_price: MINIMUM_CHARGE, fallback: true,
      message: 'Shipbubble API key not configured'
    });
  }

  try {
    // Step 1 — Validate both addresses to get address codes
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
        'Recipient',
        '+2348000000000',
        'recipient@example.com',
        API_KEY
      )
    ]);

    console.log('Sender code:', senderCode);
    console.log('Receiver code:', receiverCode);

    // Step 2 — Fetch rates using address codes
    const weight = parseFloat(package_weight) || 1;
    const ratesPayload = {
      pickup_date:    new Date().toISOString().split('T')[0],
      category_id:    1,
      package_items: [{
        name:         'Package',
        description:  'Delivery package',
        unit_weight:  weight,
        unit_amount:  1000,
        quantity:     1
      }],
      package_dimension: { length: 10, width: 10, height: 10 },
      sender_address_code:   senderCode,
      receiver_address_code: receiverCode
    };

    console.log('Fetching rates with payload:', JSON.stringify(ratesPayload));

    const ratesRes = await fetch('https://api.shipbubble.com/v1/shipping/fetch_rates', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type':  'application/json',
        'Accept':        'application/json'
      },
      body: JSON.stringify(ratesPayload)
    });

    const ratesRaw = await ratesRes.text();
    console.log('Rates HTTP status:', ratesRes.status);
    console.log('Rates response:', ratesRaw);

    const ratesData = JSON.parse(ratesRaw);

    if (ratesData.status !== 'success' || !ratesData.data?.couriers?.length) {
      console.error('No couriers:', JSON.stringify(ratesData));
      return res.status(200).json({
        success: true, your_price: MINIMUM_CHARGE,
        fallback: true, message: 'No couriers available for this route',
        debug: ratesData
      });
    }

    const cheapest  = ratesData.data.cheapest_courier;
    const basePrice = parseFloat(cheapest?.total || 0);

    console.log('Cheapest courier:', cheapest?.courier_name, '₦' + basePrice);

    if (!basePrice) {
      return res.status(200).json({
        success: true, your_price: MINIMUM_CHARGE,
        fallback: true, message: 'Could not extract price'
      });
    }

    return res.status(200).json({
      success:              true,
      kwikpik_price:        basePrice,
      your_price:           basePrice,
      courier_name:         cheapest?.courier_name || '',
      pickup_eta:           cheapest?.pickup_eta   || '',
      delivery_eta:         cheapest?.delivery_eta || '',
      sender_address_code:  senderCode,
      receiver_address_code: receiverCode,
      request_token:        ratesData.data.request_token,
      fallback:             false,
      currency:             'NGN'
    });

  } catch (err) {
    console.error('Estimate error:', err.message);
    return res.status(200).json({
      success: true, your_price: MINIMUM_CHARGE,
      fallback: true, error: err.message
    });
  }
      }
