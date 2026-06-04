// ============================================================
// Swift-Fifteen Express — Paystack Verify + Shipbubble Dispatch
// Route: POST /api/verify-payment
// Flow: verify payment → validate addresses → fetch rates → dispatch
// ============================================================

/**
 * Utility: Format phone number to Shipbubble's preferred international format (+234...)
 */
function formatPhone(phone) {
  if (!phone) return '+2348000000000';
  const digits = phone.toString().replace(/\D/g, '');
  if (digits.startsWith('234')) return '+' + digits;
  if (digits.startsWith('0'))   return '+234' + digits.slice(1);
  if (digits.length === 10)     return '+234' + digits;
  return '+' + digits;
}

/**
 * Utility: Map user weight selection to numeric KG values
 */
function weightToKg(w) {
  if (!w) return 1;
  const weightStr = w.toString().toLowerCase();
  if (weightStr.includes('20kg+')) return 25;
  if (weightStr.includes('5–20'))  return 12;
  if (weightStr.includes('1–5'))   return 3;
  return 0.5;
}

/**
 * Step 2 Utility: Validate an address and get its unique address_code
 */
async function validateAddress(address, name, phone, email, apiKey) {
  const payload = {
    name:    name,
    email:   email || 'orders@swiftfifteenexpress.com',
    phone:   formatPhone(phone),
    address: address + (address.toLowerCase().includes('nigeria') ? '' : ', Lagos, Nigeria')
  };

  console.log(`Validating Address: "${payload.address}"`);

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
    throw new Error(`Address validation failed for "${address}": ${data.message || 'Unknown error'}`);
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

  const { reference, order_data } = req.body;

  console.log('=== verify-payment execution started ===');
  if (!reference) {
    return res.status(400).json({ success: false, error: 'Payment reference is required' });
  }

  const SHIPBUBBLE_KEY = process.env.SHIPBUBBLE_API_KEY;
  const PAYSTACK_KEY   = process.env.PAYSTACK_SECRET_KEY;

  try {
    // ── Step 1: Verify Paystack payment ──────────────────
    console.log('Verifying Paystack Transaction...');
    const psRes = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { 'Authorization': `Bearer ${PAYSTACK_KEY}` } }
    );
    const psData = await psRes.json();

    if (!psData.status || psData.data?.status !== 'success') {
      return res.status(200).json({
        success: false, 
        payment_verified: false,
        message: 'Payment could not be verified by Paystack'
      });
    }

    const paidNGN = psData.data.amount / 100;
    console.log(`Payment Verified: ₦${paidNGN}`);

    // Check if we have the necessary order data to proceed with dispatch
    if (!order_data?.pickup_address || !order_data?.delivery_address) {
      return res.status(200).json({
        success: true, 
        payment_verified: true,
        dispatch_status: 'pending',
        message: 'Payment verified, but order addresses are missing for automated dispatch.'
      });
    }

    if (!SHIPBUBBLE_KEY) {
      throw new Error('Shipbubble API key is not configured in environment variables.');
    }

    // ── Step 2: Validate addresses to get Codes ──────────
    console.log('Validating Pickup and Delivery addresses...');
    const [senderCode, receiverCode] = await Promise.all([
      validateAddress(
        order_data.pickup_address,
        order_data.sender_name || 'SwiftFifteen Customer',
        order_data.sender_phone,
        order_data.sender_email,
        SHIPBUBBLE_KEY
      ),
      validateAddress(
        order_data.delivery_address,
        order_data.recipient_name || 'Recipient',
        order_data.recipient_phone || order_data.sender_phone,
        null, // Email optional for recipient
        SHIPBUBBLE_KEY
      )
    ]);

    // ── Step 3: Fetch Shipping Rates ──────────────────────
    const weight = weightToKg(order_data.package_weight);
    const pickupDate = order_data.pickup_date || new Date().toISOString().split('T')[0];

    const ratesPayload = {
      pickup_date: pickupDate,
      category_id: 1, // Defaulting to General Category
      package_items: [{
        name: order_data.package_description || 'Logistics Package',
        description: order_data.package_description || 'Standard Delivery',
        unit_weight: weight.toString(),
        unit_amount: (parseFloat(order_data.declared_value) || 1000).toString(),
        quantity: "1"
      }],
      package_dimension: { length: 10, width: 10, height: 10 },
      sender_address_code: senderCode,
      reciever_address_code: receiverCode // Note: Documentation uses this specific spelling
    };

    console.log('Fetching available courier rates...');
    const ratesRes = await fetch('https://api.shipbubble.com/v1/shipping/fetch_rates', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SHIPBUBBLE_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(ratesPayload)
    });

    const ratesData = await ratesRes.json();

    if (ratesData.status !== 'success' || !ratesData.data?.couriers?.length) {
      return res.status(200).json({
        success: true, 
        payment_verified: true,
        dispatch_status: 'manual_required',
        message: 'Payment verified, but no automated courier rates were found for this route.'
      });
    }

    // Auto-select the cheapest courier as per Shipbubble's recommendation
    const requestToken = ratesData.data.request_token;
    const selectedCourier = ratesData.data.cheapest_courier || ratesData.data.couriers[0];

    // ── Step 4: Create Shipment (Dispatch Rider) ──────────
    console.log(`Dispatching via ${selectedCourier.courier_name}...`);
    const shipPayload = {
      request_token: requestToken,
      courier_id: selectedCourier.courier_id,
      service_code: selectedCourier.service_code,
      is_cod_label: false
    };

    const shipRes = await fetch('https://api.shipbubble.com/v1/shipping/labels', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SHIPBUBBLE_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(shipPayload)
    });

    const shipData = await shipRes.json();

    if (shipData.status !== 'success') {
      return res.status(200).json({
        success: true, 
        payment_verified: true,
        dispatch_status: 'failed',
        message: `Dispatch failed: ${shipData.message}. Please dispatch manually from the dashboard.`
      });
    }

    // ── Success: Return all tracking info to frontend ────
    return res.status(200).json({
      success: true,
      payment_verified: true,
      dispatch_status: 'success',
      order_id: shipData.data.order_id,
      tracking_url: shipData.data.tracking_url,
      courier_name: shipData.data.courier.name,
      pickup_eta: selectedCourier.pickup_eta,
      message: 'Payment verified and rider dispatched successfully!'
    });

  } catch (err) {
    console.error('Critical Error in verify-payment:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      details: err.message
    });
  }
      }
    
